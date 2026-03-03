import type { Config } from './config.js';
import type { JiraWebhookPayload, GitHubWebhookPayload } from './types.js';
import { Logger } from './logger.js';
import { StateManager } from './services/state.js';
import { JiraService } from './services/jira.js';
import { GitHubService } from './services/github.js';
import { ClaudeService } from './services/claude.js';
import { Notifier } from './services/notifier.js';
import { FigmaService } from './services/figma.js';
import { classifyError } from './utils/errors.js';

export class WorkflowEngine {
  private processing = new Set<string>();
  private botAccountId: string | null = null;
  private startedAt = new Date();
  private lastReconciliationAt: Date | null = null;
  private shuttingDown = false;

  constructor(
    private config: Config,
    private log: Logger,
    private state: StateManager,
    private jira: JiraService,
    private github: GitHubService,
    private claude: ClaudeService,
    private notifier: Notifier,
    private figma: FigmaService | null
  ) {}

  getStatus() {
    const allTasks = this.state.getAllTasks();
    return {
      system: {
        uptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
        startedAt: this.startedAt.toISOString(),
        lastReconciliation: this.lastReconciliationAt?.toISOString() ?? null,
        activeWorktrees: this.claude.getActiveWorktreeCount(),
        maxConcurrentTasks: this.config.claude.maxConcurrentTasks,
      },
      processing: {
        count: this.processing.size,
        keys: Array.from(this.processing),
      },
      tasks: allTasks.map((t) => ({
        issueKey: t.issue_key,
        phase: t.phase,
        summary: t.summary,
        costUsd: t.cost_usd,
        prUrl: t.pr_url,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        ageMinutes: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 60000),
      })),
      stats: this.state.getStats(),
      history: this.state.getHistoryStats(),
    };
  }

  setBotAccountId(id: string): void {
    this.botAccountId = id;
  }

  startShutdown(): void {
    this.shuttingDown = true;
  }

  async waitForCompletion(timeoutMs = 60000): Promise<string[]> {
    const start = Date.now();
    while (this.processing.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return Array.from(this.processing);
  }

  private isBotComment(comment: { author?: { accountId: string }; body?: unknown }): boolean {
    if (this.botAccountId && comment.author?.accountId === this.botAccountId) return true;
    const text = this.jira.descriptionToText(comment.body).trim();
    return text.startsWith('\u{1F916}');
  }

  private getAssignBackId(issueKey: string): string | null {
    const taskState = this.state.getTask(issueKey);
    return taskState?.creator_account_id ?? this.config.jira.yourAccountId;
  }

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

    // Check status changes via changelog
    const statusChange = payload.changelog?.items.find((item) => item.field === 'status');
    const newStatus = statusChange?.toString?.toLowerCase();
    if (newStatus === 'done') {
      await this.handleMerge(issueKey);
      return;
    }
    if (newStatus === 'cancelled' || newStatus === 'closed') {
      await this.handleCancellation(issueKey);
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

    // Skip bot comments
    if (this.isBotComment(comment)) return;

    const commentText = this.jira.descriptionToText(comment.body).trim();

    if (taskState.phase === 'planning') {
      await this.handleQuestionAnswers(issueKey, commentText);
    } else if (taskState.phase === 'plan-posted') {
      await this.handlePlanFeedback(issueKey, commentText);
    } else if (taskState.phase === 'test') {
      await this.handleTestFeedback(issueKey, commentText);
    }
  }

  // ── Phase 1: Plan ──────────────────────────────────────────

  private async handleNewTask(issue: { key: string; fields: { summary: string; description?: unknown; reporter?: { accountId: string } | null } }): Promise<void> {
    const issueKey = issue.key;
    if (this.shuttingDown) {
      this.log.info(`${issueKey} \u2192 Rejecting: shutdown in progress`);
      return;
    }

    const summary = issue.fields.summary;
    let description = this.jira.descriptionToText(issue.fields.description);
    const creatorAccountId = issue.fields.reporter?.accountId ?? null;

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

      // Fetch and include attachment content
      const attachmentContext = await this.jira.getAttachmentContext(issueKey);
      if (attachmentContext) {
        description += attachmentContext;
        this.log.info(`${issueKey} \u2192 Included attachment context`);
      }

      this.log.info(`${issueKey} \u2192 Claude is planning...`);
      const result = await this.claude.createPlan(issueKey, summary, description);

      if (!result.success) {
        throw new Error(`Planning failed: ${result.error || 'Unknown error'}`);
      }

      const assignBackId = creatorAccountId ?? this.config.jira.yourAccountId;

      if (result.hasQuestions) {
        await this.jira.addComment(
          issueKey,
          `\u{1F916} **Before I can plan this, I have a few questions:**\n\n${result.questions}\n\n` +
            `---\n` +
            `Please reply with your answers and I\u2019ll create the plan.`
        );

        if (assignBackId) {
          await this.jira.assignIssue(issueKey, assignBackId);
        }

        this.state.upsertTask(issueKey, {
          phase: 'planning',
          summary,
          description,
          creator_account_id: creatorAccountId,
          session_id: result.sessionId,
          cost_usd: result.costUsd,
        });

        this.log.info(`${issueKey} \u2192 Questions posted. Waiting for answers.`);
      } else {
        // Figma design generation (if applicable)
        let designNote = '';
        let figmaDesignUrl: string | null = null;
        const figmaConfig = this.claude.getFigmaConfig();

        if (result.uiDesignNeeded && figmaConfig && this.figma) {
          this.log.info(`${issueKey} \u2192 Generating Figma design...`);
          await this.jira.addComment(issueKey, '\u{1F916} Generating UI design in Figma...');

          try {
            const designResult = await this.claude.generateDesign(
              issueKey,
              summary,
              result.uiDescription,
              figmaConfig.fileKey
            );

            if (designResult.success) {
              const nodeId = await this.figma.findNodeByName(figmaConfig.fileKey, issueKey);

              if (nodeId) {
                const pngBuffer = await this.figma.exportNodeAsPng(figmaConfig.fileKey, nodeId);
                await this.jira.addAttachment(issueKey, `${issueKey}-design.png`, pngBuffer, 'image/png');

                figmaDesignUrl = `https://www.figma.com/file/${figmaConfig.fileKey}?node-id=${encodeURIComponent(nodeId)}`;
                designNote = `\n\n**UI Design:** [View in Figma](${figmaDesignUrl})\nA screenshot has been attached to this issue.`;
                this.log.success(`${issueKey} \u2192 Figma design created and uploaded`);
              } else {
                this.log.warn(`${issueKey} \u2192 Figma design created but frame not found for export`);
                designNote = '\n\n\u26A0\uFE0F UI design was generated in Figma but the frame could not be exported as a screenshot.';
              }
            } else {
              this.log.warn(`${issueKey} \u2192 Figma design generation failed: ${designResult.error}`);
              designNote = '\n\n\u26A0\uFE0F UI design generation was attempted but failed. Proceeding with text plan only.';
            }
          } catch (error) {
            this.log.warn(`${issueKey} \u2192 Figma design error: ${(error as Error).message}`);
            designNote = '\n\n\u26A0\uFE0F UI design generation was attempted but failed. Proceeding with text plan only.';
          }
        }

        await this.jira.addComment(
          issueKey,
          `\u{1F916} **Implementation Plan:**\n\n${result.functionalSummary}${designNote}\n\n` +
            `---\n` +
            `**To approve:** Comment \`approve\` (optionally add notes after it)\n` +
            `**To reject/modify:** Comment with your feedback and Claude will re-plan\n` +
            `**To ask Claude a question:** Just comment your question`
        );

        if (assignBackId) {
          await this.jira.assignIssue(issueKey, assignBackId);
        }

        this.state.upsertTask(issueKey, {
          phase: 'plan-posted',
          plan: result.technicalPlan,
          summary,
          description,
          creator_account_id: creatorAccountId,
          session_id: result.sessionId,
          cost_usd: result.costUsd,
          plan_posted_at: new Date().toISOString(),
          figma_design_url: figmaDesignUrl,
        });

        this.log.success(`${issueKey} \u2192 Plan posted. Waiting for your approval.`);
        await this.notifier.notify('plan-ready', {
          issueKey, summary,
          message: 'Implementation plan ready for review',
          url: `${this.jira.getBaseUrl()}/browse/${issueKey}`,
        });
      }
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Planning failed: ${(error as Error).message}`);
      await this.jira.addComment(
        issueKey,
        `\u{1F916}\u274C Planning failed:\n\n${(error as Error).message}\n\nPlease adjust the task description and retry.`
      );
      const errorAssignId = creatorAccountId ?? this.config.jira.yourAccountId;
      if (errorAssignId) {
        await this.jira.assignIssue(issueKey, errorAssignId);
      }
    } finally {
      this.processing.delete(issueKey);
    }
  }

  // ── Phase 1a: Question Answers ─────────────────────────────

  private async handleQuestionAnswers(issueKey: string, answers: string): Promise<void> {
    if (this.processing.has(issueKey)) return;

    const taskState = this.state.getTask(issueKey);
    if (!taskState) return;

    this.log.info(`${issueKey} \u2192 Received answers, re-running planning...`);
    this.processing.add(issueKey);

    try {
      await this.jira.addComment(
        issueKey,
        `\u{1F916} Thanks for the answers \u2014 creating the implementation plan now...`
      );

      const enrichedDescription =
        `${taskState.description}\n\n## Additional context (answers to clarifying questions):\n${answers}`;

      const result = await this.claude.createPlan(issueKey, taskState.summary, enrichedDescription);

      if (!result.success) {
        throw new Error(`Planning failed: ${result.error || 'Unknown error'}`);
      }

      const assignBackId = this.getAssignBackId(issueKey);

      if (result.hasQuestions) {
        await this.jira.addComment(
          issueKey,
          `\u{1F916} **I still have a few questions:**\n\n${result.questions}\n\n` +
            `---\n` +
            `Please reply with your answers and I\u2019ll create the plan.`
        );

        this.state.upsertTask(issueKey, {
          description: enrichedDescription,
          session_id: result.sessionId,
          cost_usd: (taskState.cost_usd ?? 0) + (result.costUsd ?? 0),
        });
      } else {
        await this.jira.addComment(
          issueKey,
          `\u{1F916} **Implementation Plan:**\n\n${result.functionalSummary}\n\n` +
            `---\n` +
            `**To approve:** Comment \`approve\` (optionally add notes after it)\n` +
            `**To reject/modify:** Comment with your feedback and Claude will re-plan\n` +
            `**To ask Claude a question:** Just comment your question`
        );

        if (assignBackId) {
          await this.jira.assignIssue(issueKey, assignBackId);
        }

        this.state.upsertTask(issueKey, {
          phase: 'plan-posted',
          plan: result.technicalPlan,
          description: enrichedDescription,
          session_id: result.sessionId,
          cost_usd: (taskState.cost_usd ?? 0) + (result.costUsd ?? 0),
          plan_posted_at: new Date().toISOString(),
        });

        this.log.success(`${issueKey} \u2192 Plan posted. Waiting for approval.`);
      }
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Planning after answers failed: ${(error as Error).message}`);
      await this.jira.addComment(
        issueKey,
        `\u{1F916}\u274C Planning failed:\n\n${(error as Error).message}\n\nPlease adjust the task and retry.`
      );
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
            `\u{1F916} **Updated Plan:**\n\n${result.functionalSummary}\n\n` +
              `---\n` +
              `**To approve:** Comment \`approve\`\n` +
              `**More feedback?** Just comment.`
          );

          this.state.upsertTask(issueKey, {
            phase: 'plan-posted',
            plan: result.technicalPlan,
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
    if (this.shuttingDown) {
      this.log.info(`${issueKey} \u2192 Rejecting: shutdown in progress`);
      return;
    }
    if (this.processing.has(issueKey)) return;
    if (!this.claude.canAcceptTask()) {
      this.log.info(`${issueKey} \u2192 Max concurrent tasks reached, deferring...`);
      return;
    }
    this.processing.add(issueKey);

    const taskState = this.state.getTask(issueKey);
    if (!taskState) return;

    const { summary, description, plan, reviewer_notes, figma_design_url } = taskState;

    this.log.task(`[IMPLEMENT] ${issueKey}: ${summary}`);

    let branchName: string | undefined;
    let worktreePath: string | undefined;

    try {
      await this.jira.addComment(issueKey, `\u{1F916} Plan approved \u2014 starting implementation...`);

      if (this.config.jira.claudeAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.claudeAccountId);
      }

      const branchInfo = this.claude.createBranch(issueKey, summary);
      branchName = branchInfo.branchName;
      worktreePath = branchInfo.worktreePath;
      this.log.info(`${issueKey} \u2192 Branch: ${branchName} (worktree: ${worktreePath})`);

      this.log.info(`${issueKey} \u2192 Claude is coding...`);
      const result = await this.claude.implementPlan(
        issueKey,
        summary,
        description,
        plan ?? '',
        reviewer_notes,
        worktreePath,
        figma_design_url
      );

      if (!result.success) {
        throw new Error(`Implementation failed: ${result.error}\n\n${result.output?.substring(0, 1000)}`);
      }

      this.log.info(`${issueKey} \u2192 Pushing changes...`);
      const pushResult = this.claude.pushChanges(issueKey, summary, branchName, worktreePath);

      if (!pushResult.pushed) {
        throw new Error(`No changes to push: ${pushResult.reason}`);
      }

      this.log.info(`${issueKey} \u2192 Merging into staging...`);
      await this.claude.mergeIntoStaging(branchName);
      this.log.success(`${issueKey} \u2192 Staging branch updated and pushed`);

      await this.waitForStagingWorkflow(issueKey, branchName, summary, taskState, worktreePath);

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

      const implAssignId = this.getAssignBackId(issueKey);
      if (implAssignId) {
        await this.jira.assignIssue(issueKey, implAssignId);
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
      await this.notifier.notify('implementation-done', {
        issueKey, summary,
        message: `Implementation complete. PR: ${pr.html_url}`,
        url: pr.html_url,
      });
    } catch (error) {
      const errorMsg = (error as Error).message;
      const category = classifyError(error);
      this.log.error(`${issueKey} \u2192 Implementation failed [${category}]: ${errorMsg}`);

      if (category === 'transient') {
        this.log.warn(`${issueKey} \u2192 Transient error, will retry on next reconciliation`);
        this.state.upsertTask(issueKey, { phase: 'approved' });
      } else {
        let comment = `\u{1F916}\u274C Implementation error:\n\n${errorMsg}`;
        if (category === 'conflict') {
          comment += `\n\nMerge conflict detected. Please resolve manually on branch \`${branchName}\`.`;
        } else if (category === 'budget') {
          comment += `\n\nClaude budget limit reached. Consider increasing \`CLAUDE_MAX_BUDGET_IMPLEMENT\` or splitting the task.`;
        } else {
          comment += `\n\nPlease review and retry or handle manually.`;
        }

        await this.jira.addComment(issueKey, comment);

        const implErrAssignId = this.getAssignBackId(issueKey);
        if (implErrAssignId) {
          await this.jira.assignIssue(issueKey, implErrAssignId);
        }

        this.state.upsertTask(issueKey, { phase: 'failed' });
        await this.notifier.notify('failed', {
          issueKey, summary,
          message: `Implementation failed [${category}]: ${errorMsg}`,
        });
      }
    } finally {
      this.claude.cleanupWorktree(issueKey);
      this.processing.delete(issueKey);
    }
  }

  // ── Phase 2b: Test Feedback / Rework ───────────────────────

  private async handleTestFeedback(issueKey: string, feedback: string): Promise<void> {
    if (this.shuttingDown) {
      this.log.info(`${issueKey} \u2192 Rejecting rework: shutdown in progress`);
      return;
    }
    if (this.processing.has(issueKey)) return;

    const taskState = this.state.getTask(issueKey);
    if (!taskState || !taskState.branch_name) return;

    this.log.info(`${issueKey} \u2192 Test feedback received, starting rework...`);
    this.processing.add(issueKey);

    let worktreePath: string | undefined;

    try {
      await this.jira.addComment(
        issueKey,
        `\u{1F916} Got it \u2014 reviewing your feedback and making fixes...`
      );

      if (this.config.jira.claudeAccountId) {
        await this.jira.assignIssue(issueKey, this.config.jira.claudeAccountId);
      }

      worktreePath = this.claude.prepareReworkWorktree(issueKey, taskState.branch_name);

      const result = await this.claude.rework(
        issueKey,
        taskState.summary,
        taskState.description,
        taskState.plan ?? '',
        feedback,
        taskState.branch_name,
        taskState.session_id,
        worktreePath
      );

      if (!result.success) {
        throw new Error(`Rework failed: ${result.error}`);
      }

      const pushResult = this.claude.pushRework(issueKey, taskState.branch_name, feedback, worktreePath);

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
      await this.claude.mergeIntoStaging(taskState.branch_name);

      await this.waitForStagingWorkflow(issueKey, taskState.branch_name, taskState.summary, taskState, worktreePath);

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

      const testAssignId = this.getAssignBackId(issueKey);
      if (testAssignId) {
        await this.jira.assignIssue(issueKey, testAssignId);
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
      const testErrAssignId = this.getAssignBackId(issueKey);
      if (testErrAssignId) {
        await this.jira.assignIssue(issueKey, testErrAssignId);
      }
    } finally {
      this.claude.cleanupWorktree(issueKey);
      this.processing.delete(issueKey);
    }
  }

  // ── GitHub Actions Workflow Monitoring ─────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async pollWorkflowRun(
    issueKey: string,
    runId: number
  ): Promise<{ success: boolean; conclusion: string | null }> {
    const intervals = [15000, 30000, 60000]; // 15s, 30s, then 60s
    const maxPollTime = 10 * 60 * 1000; // 10 minutes
    const start = Date.now();
    let intervalIdx = 0;

    while (Date.now() - start < maxPollTime) {
      const { status, conclusion } = await this.github.getWorkflowRunStatus(runId);
      this.log.debug(`${issueKey} → Workflow run ${runId}: status=${status}, conclusion=${conclusion}`);

      if (status === 'completed') {
        return { success: conclusion === 'success', conclusion };
      }

      const delay = intervals[Math.min(intervalIdx, intervals.length - 1)];
      intervalIdx++;
      await this.sleep(delay);
    }

    return { success: false, conclusion: 'timed_out' };
  }

  private async waitForStagingWorkflow(
    issueKey: string,
    branchName: string,
    summary: string,
    taskState: { cost_usd?: number | null },
    worktreePath?: string
  ): Promise<void> {
    const workflowFile = this.config.github.actionsWorkflowFile;
    if (!workflowFile) return; // backward-compatible: no polling if not configured

    const maxRetries = this.config.github.actionsMaxRetries;
    const totalAttempts = maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const pushTime = new Date();

      // Wait for the workflow run to appear (poll up to ~100s)
      this.log.info(`${issueKey} → Waiting for GitHub Actions workflow to start (attempt ${attempt}/${totalAttempts})...`);
      let runId: number | null = null;
      for (let i = 0; i < 10; i++) {
        await this.sleep(10000);
        const run = await this.github.findWorkflowRun(workflowFile, 'staging', pushTime);
        if (run) {
          runId = run.id;
          this.log.info(`${issueKey} → Found workflow run ${runId}`);
          break;
        }
      }

      if (!runId) {
        this.log.warn(`${issueKey} → No workflow run found after ~100s, proceeding anyway`);
        return;
      }

      // Poll until completed
      const result = await this.pollWorkflowRun(issueKey, runId);

      if (result.success) {
        this.log.success(`${issueKey} → Workflow run ${runId} succeeded`);
        return;
      }

      // Workflow failed
      this.log.warn(`${issueKey} → Workflow run ${runId} failed (conclusion: ${result.conclusion})`);

      if (attempt >= totalAttempts) {
        throw new Error(
          `GitHub Actions workflow failed after ${totalAttempts} attempt(s). ` +
          `Last conclusion: ${result.conclusion}`
        );
      }

      // Fetch logs and ask Claude to fix
      this.log.info(`${issueKey} → Fetching failed job logs...`);
      const logs = await this.github.getFailedJobLogs(runId);

      this.log.info(`${issueKey} → Claude is fixing the build (attempt ${attempt})...`);
      await this.jira.addComment(
        issueKey,
        `🤖 GitHub Actions workflow failed. Claude is attempting an auto-fix (attempt ${attempt}/${maxRetries})...`
      );

      const fixResult = await this.claude.fixBuildFailure(issueKey, summary, branchName, logs, attempt, worktreePath ?? '');
      if (!fixResult.success) {
        throw new Error(`Build fix failed: ${fixResult.error}`);
      }

      const pushResult = this.claude.pushBuildFix(issueKey, branchName, attempt, worktreePath ?? '');
      if (!pushResult.pushed) {
        throw new Error(`Build fix produced no changes: ${pushResult.reason}`);
      }

      // Re-merge into staging
      this.log.info(`${issueKey} → Re-merging fixed branch into staging...`);
      await this.claude.mergeIntoStaging(branchName);
      this.log.info(`${issueKey} → Re-merged into staging, polling workflow again...`);
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
        this.state.deleteTask(issueKey, 'merged');
        return;
      }

      await this.github.mergePullRequest(prNumber, `${issueKey}: ${pr.title}`, 'squash');
      await this.jira.removeLabel(issueKey, `${this.config.jira.claudeLabel}-pr-pending`);
      await this.jira.addComment(issueKey, `\u{1F916}\u2705 PR #${prNumber} merged to ${this.claude.getDefaultBranch()}. Production deploy triggered.`);

      await this.github.deleteBranch(pr.head.ref);
      this.state.deleteTask(issueKey, 'merged');

      this.log.success(`${issueKey} \u2192 PR #${prNumber} merged! Deploying to production.`);
      await this.notifier.notify('merged', {
        issueKey, summary: pr.title,
        message: `PR #${prNumber} merged to ${this.claude.getDefaultBranch()}. Production deploy triggered.`,
      });
    } catch (error) {
      this.log.error(`${issueKey} \u2192 Merge failed: ${(error as Error).message}`);
      await this.jira.addComment(issueKey, `\u{1F916}\u274C Auto-merge failed: ${(error as Error).message}\n\nPlease merge manually.`);
    } finally {
      this.processing.delete(mergeKey);
    }
  }

  // ── GitHub Webhook Handler ──────────────────────────────────

  async handleGitHubWebhook(event: string, payload: GitHubWebhookPayload): Promise<void> {
    if (event === 'pull_request_review' && payload.action === 'submitted') {
      await this.handlePRReview(payload);
    } else if (event === 'issue_comment' && payload.action === 'created') {
      await this.handlePRComment(payload);
    }
  }

  private async handlePRReview(payload: GitHubWebhookPayload): Promise<void> {
    const prNumber = payload.pull_request?.number;
    if (!prNumber) return;

    const task = this.state.getTaskByPrNumber(prNumber);
    if (!task || task.phase !== 'test') return;

    const review = payload.review;
    if (!review) return;

    if (review.state === 'changes_requested' && review.body) {
      this.log.info(`${task.issue_key} \u2190 GitHub PR review: changes requested by @${review.user.login}`);
      await this.handleTestFeedback(
        task.issue_key,
        `[GitHub PR Review by @${review.user.login}]: ${review.body}`
      );
    } else if (review.state === 'approved') {
      this.log.info(`${task.issue_key} \u2190 GitHub PR approved by @${review.user.login}`);
      await this.jira.addComment(
        task.issue_key,
        `\u{1F916} PR #${prNumber} approved by @${review.user.login} on GitHub. ` +
          `Move this task to **"Done"** to merge & deploy to production.`
      );
    }
  }

  private async handlePRComment(payload: GitHubWebhookPayload): Promise<void> {
    // Only handle comments on PRs (not plain issues)
    if (!payload.issue?.pull_request) return;

    const prNumber = payload.issue.number;
    const task = this.state.getTaskByPrNumber(prNumber);
    if (!task || task.phase !== 'test') return;

    const comment = payload.comment;
    if (!comment?.body) return;

    // Skip bot comments
    if (comment.body.startsWith('\u{1F916}')) return;

    this.log.info(`${task.issue_key} \u2190 GitHub PR comment by @${comment.user.login}`);
    await this.handleTestFeedback(
      task.issue_key,
      `[GitHub PR Comment by @${comment.user.login}]: ${comment.body}`
    );
  }

  // ── Task Cancellation ─────────────────────────────────────

  private async handleCancellation(issueKey: string): Promise<void> {
    const task = this.state.getTask(issueKey);
    if (!task) return;

    this.log.info(`${issueKey} \u2192 Cancelled. Cleaning up...`);

    if (task.pr_number) {
      try { await this.github.closePullRequest(task.pr_number); } catch { /* best effort */ }
    }
    if (task.branch_name) {
      try { await this.github.deleteBranch(task.branch_name); } catch { /* best effort */ }
    }

    this.state.deleteTask(issueKey, 'cancelled');
    this.log.success(`${issueKey} \u2192 Cleanup complete.`);
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
        if (!this.claude.canAcceptTask()) {
          this.log.debug('At capacity, skipping remaining new tasks');
          break;
        }
        await this.handleNewTask(task as any);
      }

      // 2a. Check for answers to questions
      const questionTasks = this.state.getTasksByPhase('planning');
      for (const taskState of questionTasks) {
        if (this.processing.has(taskState.issue_key)) continue;

        try {
          const issue = await this.jira.getIssue(taskState.issue_key);
          const comments = (issue.fields as any).comment?.comments ?? [];
          const lastUpdate = new Date(taskState.updated_at).getTime();

          for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            const commentTime = new Date(comment.created).getTime();

            if (this.isBotComment(comment)) continue;
            if (commentTime <= lastUpdate) break;

            const text = this.jira.descriptionToText(comment.body).trim();
            await this.handleQuestionAnswers(taskState.issue_key, text);
            break;
          }
        } catch (error) {
          this.log.error(`${taskState.issue_key} \u2192 Reconciliation error: ${(error as Error).message}`);
        }
      }

      // 2b. Check plan approvals by polling comments
      const planTasks = this.state.getTasksByPhase('plan-posted');
      for (const taskState of planTasks) {
        if (this.processing.has(taskState.issue_key)) continue;

        try {
          const issue = await this.jira.getIssue(taskState.issue_key);
          const comments = (issue.fields as any).comment?.comments ?? [];
          const planPostedAt = new Date(taskState.plan_posted_at ?? taskState.updated_at).getTime();

          for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            const commentTime = new Date(comment.created).getTime();

            if (this.isBotComment(comment)) continue;
            if (commentTime <= planPostedAt) break;

            const text = this.jira.descriptionToText(comment.body).trim();
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
            const commentTime = new Date(comment.created).getTime();

            if (this.isBotComment(comment)) continue;
            if (commentTime <= lastCheckTime) break;

            const text = this.jira.descriptionToText(comment.body).trim();
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
        if (!this.claude.canAcceptTask()) {
          this.log.debug('At capacity, skipping remaining retry tasks');
          break;
        }

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

      // 6. Detect stale tasks and notify
      const staleHours = this.config.staleTaskHours;
      if (staleHours > 0) {
        const staleTasks = this.state.getStaleTasks(staleHours);
        for (const task of staleTasks) {
          this.log.warn(
            `${task.issue_key} stuck in "${task.phase}" for >${staleHours}h — consider manual intervention`
          );

          const lastNotified = task.last_stale_notified
            ? new Date(task.last_stale_notified).getTime()
            : 0;
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

          if (lastNotified < oneDayAgo) {
            await this.notifier.notify('stale', {
              issueKey: task.issue_key,
              summary: task.summary,
              message: `Task stuck in "${task.phase}" for over ${staleHours} hours. Consider manual intervention.`,
              url: `${this.jira.getBaseUrl()}/browse/${task.issue_key}`,
            });
            this.state.upsertTask(task.issue_key, {
              last_stale_notified: new Date().toISOString(),
            });
          }
        }
      }

      // 7. Check for cancelled/deleted tasks in Jira (orphan cleanup)
      const allTracked = this.state.getAllTasks();
      for (const task of allTracked) {
        if (this.processing.has(task.issue_key)) continue;
        try {
          const issue = await this.jira.getIssue(task.issue_key);
          const jiraStatus = (issue.fields as any).status?.name?.toLowerCase();
          if (jiraStatus === 'cancelled' || jiraStatus === 'closed') {
            await this.handleCancellation(task.issue_key);
          }
        } catch (error) {
          const msg = (error as Error).message;
          // If issue was deleted (404), clean up
          if (msg.includes('404') || msg.includes('does not exist') || msg.includes('not found')) {
            this.log.warn(`${task.issue_key} \u2192 Issue not found in Jira, cleaning up`);
            this.state.deleteTask(task.issue_key, 'deleted');
          }
        }
      }
      this.lastReconciliationAt = new Date();
    } catch (error) {
      this.log.error(`Reconciliation error: ${(error as Error).message}`);
    }
  }
}
