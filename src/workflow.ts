import type { Config } from './config.js';
import type { JiraWebhookPayload } from './types.js';
import { Logger } from './logger.js';
import { StateManager } from './services/state.js';
import { JiraService } from './services/jira.js';
import { GitHubService } from './services/github.js';
import { ClaudeService } from './services/claude.js';

export class WorkflowEngine {
  private processing = new Set<string>();

  constructor(
    private config: Config,
    private log: Logger,
    private state: StateManager,
    private jira: JiraService,
    private github: GitHubService,
    private claude: ClaudeService
  ) {}

  // ── Webhook Entry Point ─────────────────────────────────────

  async handleWebhook(payload: JiraWebhookPayload): Promise<void> {
    const event = payload.webhookEvent;

    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      await this.handleIssueEvent(payload);
    } else if (event === 'comment_created') {
      await this.handleCommentEvent(payload);
    } else {
      this.log.debug(`Ignoring webhook event: ${event}`);
    }
  }

  // ── Issue Events ────────────────────────────────────────────

  private async handleIssueEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) return;

    const issueKey = issue.key;
    const status = issue.fields.status?.name?.toLowerCase();
    const labels = issue.fields.labels ?? [];
    const assigneeId = issue.fields.assignee?.accountId ?? null;

    // Check if status changed to "Done" via changelog
    const statusChange = payload.changelog?.items.find((item) => item.field === 'status');
    if (statusChange?.toString?.toLowerCase() === 'done') {
      await this.handleMerge(issueKey);
      return;
    }

    // Check if a failed task was re-assigned to Claude → retry implementation
    const isAssignedToClaude =
      this.config.jira.claudeAccountId && assigneeId === this.config.jira.claudeAccountId;

    if (isAssignedToClaude) {
      const taskState = this.state.getTask(issueKey);
      if (taskState && (taskState.phase === 'failed' || taskState.phase === 'approved')) {
        this.log.info(`${issueKey} \u2192 Re-assigned to Claude, retrying implementation...`);
        this.state.upsertTask(issueKey, { phase: 'approved' });
        await this.handleImplementation(issueKey);
        return;
      }
    }

    // Check if this is a new Claude task ("To Do" + assigned to Claude or labeled)
    if (status === 'to do') {
      const isClaudeTask =
        isAssignedToClaude || labels.includes(this.config.jira.claudeLabel);

      if (isClaudeTask) {
        await this.handleNewTask(issue as any);
      }
    }
  }

  // ── Comment Events ──────────────────────────────────────────

  private async handleCommentEvent(payload: JiraWebhookPayload): Promise<void> {
    const issue = payload.issue;
    const comment = payload.comment;
    if (!issue || !comment) return;

    const issueKey = issue.key;
    const taskState = this.state.getTask(issueKey);
    if (!taskState) return;

    const commentText = this.jira.descriptionToText(comment.body).trim();

    // Skip bot comments
    if (commentText.startsWith('\u{1F916}')) return;

    if (taskState.phase === 'plan-posted') {
      await this.handlePlanFeedback(issueKey, commentText);
    } else if (taskState.phase === 'test') {
      await this.handleTestFeedback(issueKey, commentText);
    }
  }

  // ── Phase 1: Plan ──────────────────────────────────────────

  private async handleNewTask(issue: { key: string; fields: { summary: string; description?: unknown } }): Promise<void> {
    const issueKey = issue.key;
    const summary = issue.fields.summary;
    const description = this.jira.descriptionToText(issue.fields.description);

    if (this.processing.has(issueKey)) return;

    const existing = this.state.getTask(issueKey);
    if (existing && existing.phase === 'plan-posted') return;

    this.processing.add(issueKey);
    this.log.task(`[PLAN] ${issueKey}: ${summary}`);

    try {
      await this.jira.transitionIssue(issueKey, 'In Progress');
      await this.jira.addComment(
        issueKey,
        `\u{1F916} Claude is analyzing this task and creating an implementation plan...`
      );

      this.log.info(`${issueKey} \u2192 Claude is planning...`);
      const result = await this.claude.createPlan(issueKey, summary, description);

      if (!result.success) {
        throw new Error(`Planning failed: ${result.error || 'Unknown error'}`);
      }

      const plan = result.output;

      await this.jira.addComment(
        issueKey,
        `\u{1F916} **Implementation Plan:**\n\n${plan}\n\n` +
          `---\n` +
          `**To approve:** Comment \`approve\` (optionally add notes after it)\n` +
          `**To reject/modify:** Comment with your feedback and Claude will re-plan\n` +
          `**To ask Claude a question:** Just comment your question`
      );

      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }

      this.state.upsertTask(issueKey, {
        phase: 'plan-posted',
        plan,
        summary,
        description,
        session_id: result.sessionId,
        cost_usd: result.costUsd,
        plan_posted_at: new Date().toISOString(),
      });

      this.log.success(`${issueKey} \u2192 Plan posted. Waiting for your approval.`);
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Planning failed: ${(error as Error).message}`);
      await this.jira.addComment(
        issueKey,
        `\u{1F916}\u274C Planning failed:\n\n${(error as Error).message}\n\nPlease adjust the task description and retry.`
      );
      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }
    } finally {
      this.processing.delete(issueKey);
    }
  }

  // ── Phase 1b: Plan Feedback ────────────────────────────────

  private async handlePlanFeedback(issueKey: string, commentText: string): Promise<void> {
    if (this.processing.has(issueKey)) return;

    const taskState = this.state.getTask(issueKey);
    if (!taskState) return;

    const textLower = commentText.toLowerCase();

    if (textLower.startsWith('approve')) {
      const reviewerNotes = commentText.substring(7).trim();
      this.log.success(`${issueKey} \u2192 Plan approved! ${reviewerNotes ? `Notes: ${reviewerNotes}` : ''}`);

      this.state.upsertTask(issueKey, {
        phase: 'approved',
        reviewer_notes: reviewerNotes || null,
      });

      await this.handleImplementation(issueKey);
    } else {
      this.log.info(`${issueKey} \u2192 Received feedback, re-planning...`);

      this.processing.add(issueKey);
      try {
        await this.jira.addComment(
          issueKey,
          `\u{1F916} Got it \u2014 adjusting the plan based on your feedback...`
        );

        const result = await this.claude.createPlan(
          issueKey,
          taskState.summary,
          `${taskState.description}\n\n## Previous Plan:\n${taskState.plan}\n\n## Reviewer Feedback:\n${commentText}`
        );

        if (result.success) {
          await this.jira.addComment(
            issueKey,
            `\u{1F916} **Updated Plan:**\n\n${result.output}\n\n` +
              `---\n` +
              `**To approve:** Comment \`approve\`\n` +
              `**More feedback?** Just comment.`
          );

          this.state.upsertTask(issueKey, {
            phase: 'plan-posted',
            plan: result.output,
            session_id: result.sessionId,
            cost_usd: (taskState.cost_usd ?? 0) + (result.costUsd ?? 0),
            plan_posted_at: new Date().toISOString(),
          });
        } else {
          await this.jira.addComment(issueKey, `\u{1F916}\u274C Re-planning failed: ${result.error}`);
        }
      } finally {
        this.processing.delete(issueKey);
      }
    }
  }

  // ── Phase 2: Implement ─────────────────────────────────────

  private async handleImplementation(issueKey: string): Promise<void> {
    if (this.processing.has(issueKey)) return;
    this.processing.add(issueKey);

    const taskState = this.state.getTask(issueKey);
    if (!taskState) return;

    const { summary, description, plan, reviewer_notes } = taskState;

    this.log.task(`[IMPLEMENT] ${issueKey}: ${summary}`);

    let branchName: string | undefined;

    try {
      await this.jira.addComment(issueKey, `\u{1F916} Plan approved \u2014 starting implementation...`);

      if (this.config.jira.claudeAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.claudeAccountId);
      }

      branchName = this.claude.createBranch(issueKey, summary);
      this.log.info(`${issueKey} \u2192 Branch: ${branchName}`);

      this.log.info(`${issueKey} \u2192 Claude is coding...`);
      const result = await this.claude.implementPlan(
        issueKey,
        summary,
        description,
        plan ?? '',
        reviewer_notes
      );

      if (!result.success) {
        throw new Error(`Implementation failed: ${result.error}\n\n${result.output?.substring(0, 1000)}`);
      }

      this.log.info(`${issueKey} \u2192 Pushing changes...`);
      const pushResult = this.claude.pushChanges(issueKey, summary, branchName);

      if (!pushResult.pushed) {
        throw new Error(`No changes to push: ${pushResult.reason}`);
      }

      this.log.info(`${issueKey} \u2192 Merging into staging...`);
      this.claude.mergeIntoStaging(branchName);
      this.log.success(`${issueKey} \u2192 Staging branch updated and pushed`);

      this.log.info(`${issueKey} \u2192 Smoke testing staging...`);
      const testResult = await this.claude.smokeTestStaging();
      const testNote = testResult.tested
        ? testResult.passed
          ? '\u2705 Staging smoke test passed'
          : `\u26A0\uFE0F Staging concerns: ${testResult.output}`
        : `\u2139\uFE0F Staging test skipped: ${testResult.reason}`;

      this.log.info(`${issueKey} \u2192 Creating PR...`);
      const pr = await this.github.createPullRequest(
        branchName,
        this.claude.getDefaultBranch(),
        `${issueKey}: ${summary}`,
        `## ${issueKey}: ${summary}\n\n` +
          `### Approved Plan\n${plan}\n\n` +
          `### Implementation Notes\n${result.output?.substring(0, 2000) || 'See commits.'}\n\n` +
          `### Staging Test\n${testNote}\n\n` +
          `[Jira: ${issueKey}](${this.jira.getBaseUrl()}/browse/${issueKey})\n\n---\n*Automated by jira-claude-automation*`
      );

      this.log.success(`${issueKey} \u2192 PR created: ${pr.html_url}`);

      await this.jira.addLabel(issueKey, `${this.config.jira.claudeLabel}-pr-pending`);

      await this.jira.addComment(
        issueKey,
        `\u{1F916} \u2705 Implementation complete!\n\n` +
          `**Branch:** \`${branchName}\`\n` +
          `**PR:** ${pr.html_url}\n` +
          `**PR #:** ${pr.number}\n\n` +
          `${testNote}\n\n` +
          `Please review the PR and staging site.\n` +
          `When satisfied, move this task to **"Done"** to merge & deploy to production.`
      );

      await this.jira.transitionIssue(issueKey, 'Test');

      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }

      this.state.upsertTask(issueKey, {
        phase: 'test',
        branch_name: branchName,
        pr_number: pr.number,
        pr_url: pr.html_url,
        session_id: result.sessionId,
        cost_usd: (taskState.cost_usd ?? 0) + (result.costUsd ?? 0),
      });

      this.log.success(`${issueKey} \u2192 In Test. PR: ${pr.html_url}`);
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Implementation failed: ${(error as Error).message}`);

      await this.jira.addComment(
        issueKey,
        `\u{1F916}\u274C Implementation error:\n\n${(error as Error).message}\n\nPlease review and retry or handle manually.`
      );

      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }

      this.state.upsertTask(issueKey, { phase: 'failed' });
    } finally {
      this.claude.cleanup();
      this.processing.delete(issueKey);
    }
  }

  // ── Phase 2b: Test Feedback / Rework ───────────────────────

  private async handleTestFeedback(issueKey: string, feedback: string): Promise<void> {
    if (this.processing.has(issueKey)) return;

    const taskState = this.state.getTask(issueKey);
    if (!taskState || !taskState.branch_name) return;

    this.log.info(`${issueKey} \u2192 Test feedback received, starting rework...`);
    this.processing.add(issueKey);

    try {
      await this.jira.addComment(
        issueKey,
        `\u{1F916} Got it \u2014 reviewing your feedback and making fixes...`
      );

      if (this.config.jira.claudeAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.claudeAccountId);
      }

      const result = await this.claude.rework(
        issueKey,
        taskState.summary,
        taskState.description,
        taskState.plan ?? '',
        feedback,
        taskState.branch_name,
        taskState.session_id
      );

      if (!result.success) {
        throw new Error(`Rework failed: ${result.error}`);
      }

      const pushResult = this.claude.pushRework(issueKey, taskState.branch_name, feedback);

      if (!pushResult.pushed) {
        await this.jira.addComment(
          issueKey,
          `\u{1F916} I reviewed the feedback but didn't find any code changes needed. ` +
            `Could you provide more specific details about what needs to change?`
        );
        this.state.upsertTask(issueKey, { last_feedback_check: new Date().toISOString() });
        return;
      }

      this.log.info(`${issueKey} \u2192 Merging fixes into staging...`);
      this.claude.mergeIntoStaging(taskState.branch_name);

      const testResult = await this.claude.smokeTestStaging();
      const testNote = testResult.tested
        ? testResult.passed
          ? '\u2705 Staging smoke test passed'
          : `\u26A0\uFE0F Staging concerns: ${testResult.output}`
        : `\u2139\uFE0F Staging test skipped: ${testResult.reason}`;

      await this.jira.addComment(
        issueKey,
        `\u{1F916} \u2705 Fixes pushed!\n\n` +
          `**What changed:** ${result.output?.substring(0, 1000) || 'See latest commits.'}\n\n` +
          `${testNote}\n\n` +
          `The PR and staging site are updated. Please re-test.\n` +
          `Move to **"Done"** when satisfied, or comment again with further feedback.`
      );

      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }

      this.state.upsertTask(issueKey, {
        last_feedback_check: new Date().toISOString(),
        session_id: result.sessionId,
        cost_usd: (taskState.cost_usd ?? 0) + (result.costUsd ?? 0),
      });

      this.log.success(`${issueKey} \u2192 Rework complete, staging updated.`);
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Rework failed: ${(error as Error).message}`);
      await this.jira.addComment(
        issueKey,
        `\u{1F916}\u274C Rework failed:\n\n${(error as Error).message}\n\nPlease check manually or provide different feedback.`
      );
      if (this.config.jira.yourAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.yourAccountId);
      }
    } finally {
      this.claude.cleanup();
      this.processing.delete(issueKey);
    }
  }

  // ── Phase 3: Merge ────────────────────────────────────────

  private async handleMerge(issueKey: string): Promise<void> {
    const mergeKey = `merge-${issueKey}`;
    if (this.processing.has(mergeKey)) return;
    this.processing.add(mergeKey);

    this.log.info(`${issueKey} \u2192 Approved! Merging PR...`);

    try {
      const taskState = this.state.getTask(issueKey);
      let prNumber = taskState?.pr_number ?? null;

      // Fallback: find PR number from comments
      if (!prNumber) {
        const fullIssue = await this.jira.getIssue(issueKey);
        const comments = (fullIssue.fields as any).comment?.comments ?? [];
        for (let i = comments.length - 1; i >= 0; i--) {
          const text = this.jira.descriptionToText(comments[i].body);
          const match = text.match(/\*\*PR #:\*\*\s*(\d+)/);
          if (match) {
            prNumber = parseInt(match[1], 10);
            break;
          }
        }
      }

      if (!prNumber) {
        this.log.warn(`${issueKey} \u2192 Could not find PR number`);
        return;
      }

      const pr = await this.github.getPullRequest(prNumber);
      if (pr.state !== 'open') {
        this.log.info(`${issueKey} \u2192 PR #${prNumber} already ${pr.state}`);
        await this.jira.removeLabel(issueKey, `${this.config.jira.claudeLabel}-pr-pending`);
        this.state.deleteTask(issueKey);
        return;
      }

      await this.github.mergePullRequest(prNumber, `${issueKey}: ${pr.title}`, 'squash');
      await this.jira.removeLabel(issueKey, `${this.config.jira.claudeLabel}-pr-pending`);
      await this.jira.addComment(issueKey, `\u{1F916}\u2705 PR #${prNumber} merged to ${this.claude.getDefaultBranch()}. Production deploy triggered.`);

      await this.github.deleteBranch(pr.head.ref);
      this.state.deleteTask(issueKey);

      this.log.success(`${issueKey} \u2192 PR #${prNumber} merged! Deploying to production.`);
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Merge failed: ${(error as Error).message}`);
      await this.jira.addComment(issueKey, `\u{1F916}\u274C Auto-merge failed: ${(error as Error).message}\n\nPlease merge manually.`);
    } finally {
      this.processing.delete(mergeKey);
    }
  }

  // ── Reconciliation Poll ────────────────────────────────────

  async reconcile(): Promise<void> {
    this.log.debug('Running reconciliation poll...');

    try {
      // 1. New tasks
      const tasks = await this.jira.findClaudeTasks(
        this.config.jira.claudeAccountId,
        this.config.jira.claudeLabel
      );
      for (const task of tasks) {
        await this.handleNewTask(task as any);
      }

      // 2. Check plan approvals by polling comments
      const planTasks = this.state.getTasksByPhase('plan-posted');
      for (const taskState of planTasks) {
        if (this.processing.has(taskState.issue_key)) continue;

        try {
          const issue = await this.jira.getIssue(taskState.issue_key);
          const comments = (issue.fields as any).comment?.comments ?? [];
          const planPostedAt = new Date(taskState.plan_posted_at ?? taskState.updated_at).getTime();

          for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            const text = this.jira.descriptionToText(comment.body).trim();
            const commentTime = new Date(comment.created).getTime();

            if (text.startsWith('\u{1F916}')) continue;
            if (commentTime <= planPostedAt) break;

            await this.handlePlanFeedback(taskState.issue_key, text);
            break;
          }
        } catch (error) {
          this.log.error(`${taskState.issue_key} \u2192 Reconciliation error: ${(error as Error).message}`);
        }
      }

      // 3. Check test feedback
      const testTasks = this.state.getTasksByPhase('test');
      for (const taskState of testTasks) {
        if (this.processing.has(taskState.issue_key)) continue;

        try {
          const issue = await this.jira.getIssue(taskState.issue_key);
          const status = (issue.fields as any).status?.name?.toLowerCase();
          if (status === 'done') {
            await this.handleMerge(taskState.issue_key);
            continue;
          }

          const comments = (issue.fields as any).comment?.comments ?? [];
          const lastCheckTime = new Date(taskState.last_feedback_check ?? taskState.updated_at).getTime();

          for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            const text = this.jira.descriptionToText(comment.body).trim();
            const commentTime = new Date(comment.created).getTime();

            if (text.startsWith('\u{1F916}')) continue;
            if (commentTime <= lastCheckTime) break;

            await this.handleTestFeedback(taskState.issue_key, text);
            break;
          }
        } catch (error) {
          this.log.error(`${taskState.issue_key} \u2192 Reconciliation error: ${(error as Error).message}`);
        }
      }

      // 4. Check failed/stuck tasks re-assigned to Claude
      const retryableTasks = [
        ...this.state.getTasksByPhase('failed'),
        ...this.state.getTasksByPhase('approved'),
      ];
      for (const taskState of retryableTasks) {
        if (this.processing.has(taskState.issue_key)) continue;

        try {
          const issue = await this.jira.getIssue(taskState.issue_key);
          const assigneeId = (issue.fields as any).assignee?.accountId ?? null;

          if (this.config.jira.claudeAccountId && assigneeId === this.config.jira.claudeAccountId) {
            this.log.info(`${taskState.issue_key} \u2192 Re-assigned to Claude, retrying implementation...`);
            this.state.upsertTask(taskState.issue_key, { phase: 'approved' });
            await this.handleImplementation(taskState.issue_key);
          }
        } catch (error) {
          this.log.error(`${taskState.issue_key} \u2192 Reconciliation error: ${(error as Error).message}`);
        }
      }

      // 5. Check for "Done" tasks needing merge
      const approvedTasks = await this.jira.findApprovedTasks(this.config.jira.claudeLabel);
      for (const issue of approvedTasks) {
        await this.handleMerge((issue as any).key);
      }
    } catch (error) {
      this.log.error(`Reconciliation error: ${(error as Error).message}`);
    }
  }
}
