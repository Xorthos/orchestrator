import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { ClaudeResult, PlanResult } from '../types.js';
import { Logger } from '../logger.js';

export interface BranchInfo {
  branchName: string;
  worktreePath: string;
}

export class ClaudeService {
  private repoPath: string;
  private worktreeBase: string;
  private defaultBranch = 'main';
  private stagingUrl: string | null;
  private useMaxSubscription: boolean;
  private maxTurnsPlan: number;
  private maxTurnsImplement: number;
  private maxBudgetPlan: number;
  private maxBudgetImplement: number;
  private maxConcurrentTasks: number;
  private activeWorktrees = new Map<string, string>(); // issueKey -> worktreePath
  private stagingLock = false;
  private log: Logger;

  constructor(config: Config['claude'], log: Logger) {
    this.repoPath = config.repoPath;
    this.worktreeBase = join(config.repoPath, '..', '.orchestrator-worktrees');
    this.stagingUrl = config.stagingUrl;
    this.useMaxSubscription = config.useMaxSubscription;
    this.maxTurnsPlan = config.maxTurnsPlan;
    this.maxTurnsImplement = config.maxTurnsImplement;
    this.maxBudgetPlan = config.maxBudgetPlan;
    this.maxBudgetImplement = config.maxBudgetImplement;
    this.maxConcurrentTasks = config.maxConcurrentTasks;
    this.log = log;
  }

  setDefaultBranch(branch: string): void {
    this.defaultBranch = branch;
  }

  getDefaultBranch(): string {
    return this.defaultBranch;
  }

  canAcceptTask(): boolean {
    return this.activeWorktrees.size < this.maxConcurrentTasks;
  }

  // ── Git Operations ──────────────────────────────────────────

  git(args: string): string {
    return this.gitAt(this.repoPath, args);
  }

  private gitAt(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }

  createBranch(issueKey: string, summary: string): BranchInfo {
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    const branchName = `claude/${issueKey}-${slug}`;
    const worktreePath = join(this.worktreeBase, branchName.replace(/\//g, '-'));

    // Ensure worktree base exists
    if (!existsSync(this.worktreeBase)) {
      mkdirSync(this.worktreeBase, { recursive: true });
    }

    // Clean up stale worktree if it exists
    try {
      this.git(`worktree remove "${worktreePath}" --force`);
    } catch { /* didn't exist */ }

    // Fetch latest and clean up old branch if exists
    this.git(`fetch origin ${this.defaultBranch}`);
    try {
      this.git(`branch -D ${branchName}`);
    } catch { /* didn't exist */ }

    // Create worktree with new branch based on latest default
    this.git(`worktree add "${worktreePath}" -b ${branchName} origin/${this.defaultBranch}`);
    this.activeWorktrees.set(issueKey, worktreePath);

    return { branchName, worktreePath };
  }

  pushChanges(issueKey: string, summary: string, branchName: string, worktreePath: string): { pushed: boolean; reason?: string } {
    const status = this.gitAt(worktreePath, 'status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made' };
    }

    this.gitAt(worktreePath, 'add -A');

    const commitMsg = `${issueKey}: ${summary}\n\nImplemented by Claude Code automation.\nJira: ${issueKey}`;
    const msgFile = join(worktreePath, '.git-commit-msg');
    writeFileSync(msgFile, commitMsg);
    this.gitAt(worktreePath, `commit -F "${msgFile}"`);
    unlinkSync(msgFile);

    this.gitAt(worktreePath, `push -u origin ${branchName}`);
    return { pushed: true };
  }

  pushRework(issueKey: string, branchName: string, feedback: string, worktreePath: string): { pushed: boolean; reason?: string } {
    const status = this.gitAt(worktreePath, 'status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made during rework' };
    }

    this.gitAt(worktreePath, 'add -A');

    const commitMsg = `${issueKey}: Address review feedback\n\nFeedback: ${feedback.substring(0, 200)}\n\nJira: ${issueKey}`;
    const msgFile = join(worktreePath, '.git-commit-msg');
    writeFileSync(msgFile, commitMsg);
    this.gitAt(worktreePath, `commit -F "${msgFile}"`);
    unlinkSync(msgFile);

    this.gitAt(worktreePath, `push origin ${branchName}`);
    return { pushed: true };
  }

  /** Merge a feature branch into staging. Uses the main repo with a lock to serialize staging merges. */
  async mergeIntoStaging(branchName: string): Promise<boolean> {
    // Wait for staging lock (simple spin — staging merges are fast)
    while (this.stagingLock) {
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stagingLock = true;

    try {
      this.git(`fetch origin ${branchName}`);

      try {
        this.git('fetch origin staging');
        this.git('checkout staging');
        this.git('pull origin staging');
      } catch {
        this.git(`checkout ${this.defaultBranch}`);
        this.git(`pull origin ${this.defaultBranch}`);
        this.git('checkout -b staging');
      }

      try {
        this.git(`merge origin/${branchName} --no-edit`);
      } catch {
        this.git('merge --abort');
        this.git(`checkout ${this.defaultBranch}`);
        throw new Error(
          `Merge conflict when merging ${branchName} into staging. ` +
          `Please resolve manually or simplify the changes.`
        );
      }

      this.git('push -u origin staging');
      this.git(`checkout ${this.defaultBranch}`);
      return true;
    } finally {
      this.stagingLock = false;
    }
  }

  async smokeTestStaging(): Promise<{ tested: boolean; passed?: boolean; output?: string; reason?: string }> {
    if (!this.stagingUrl) {
      return { tested: false, reason: 'No staging URL configured' };
    }

    this.log.info('Waiting 10s for staging deployment...');
    await new Promise((r) => setTimeout(r, 10000));

    try {
      const response = await fetch(this.stagingUrl, { redirect: 'follow' });
      const body = await response.text();

      if (response.ok) {
        if (body.length === 0) {
          return { tested: true, passed: false, output: `${response.status} OK but empty response body` };
        }
        return { tested: true, passed: true, output: `HTTP ${response.status}, ${body.length} bytes` };
      }

      return { tested: true, passed: false, output: `HTTP ${response.status}` };
    } catch (error) {
      return { tested: true, passed: false, output: (error as Error).message };
    }
  }

  async fixBuildFailure(
    issueKey: string,
    summary: string,
    branchName: string,
    failedJobLogs: string,
    attempt: number,
    worktreePath: string
  ): Promise<ClaudeResult> {
    this.gitAt(worktreePath, `pull origin ${branchName}`);

    const prompt = `You are fixing a GitHub Actions build failure for Jira task ${issueKey} (attempt ${attempt}).

## Task: ${summary}

## Branch: ${branchName}

## Failed Job Logs (last 200 lines per job):
\`\`\`
${failedJobLogs}
\`\`\`

## Instructions:
1. Read the error logs carefully and identify the root cause of the build failure
2. Fix the code so the build passes
3. Do NOT change the CI/CD workflow files unless the error is clearly in the workflow config
4. Keep fixes minimal — only fix what's broken
5. Run any available build/lint/test commands locally to verify your fix`;

    return this.runClaudeSDK(prompt, {
      maxTurns: this.maxTurnsImplement,
      maxBudgetUsd: this.maxBudgetImplement,
      permissionMode: 'acceptEdits',
      cwd: worktreePath,
    });
  }

  pushBuildFix(issueKey: string, branchName: string, attempt: number, worktreePath: string): { pushed: boolean; reason?: string } {
    const status = this.gitAt(worktreePath, 'status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made by build fix' };
    }

    this.gitAt(worktreePath, 'add -A');

    const commitMsg = `${issueKey}: Fix build failure (attempt ${attempt})\n\nAutomated build fix by Claude Code.\nJira: ${issueKey}`;
    const msgFile = join(worktreePath, '.git-commit-msg');
    writeFileSync(msgFile, commitMsg);
    this.gitAt(worktreePath, `commit -F "${msgFile}"`);
    unlinkSync(msgFile);

    this.gitAt(worktreePath, `push origin ${branchName}`);
    return { pushed: true };
  }

  /** Prepare a worktree for rework on an existing branch */
  prepareReworkWorktree(issueKey: string, branchName: string): string {
    const worktreePath = join(this.worktreeBase, branchName.replace(/\//g, '-'));

    if (!existsSync(this.worktreeBase)) {
      mkdirSync(this.worktreeBase, { recursive: true });
    }

    // Clean up stale worktree if it exists
    try {
      this.git(`worktree remove "${worktreePath}" --force`);
    } catch { /* didn't exist */ }

    this.git(`fetch origin ${branchName}`);

    // Create worktree for the existing remote branch
    try {
      this.git(`branch -D ${branchName}`);
    } catch { /* didn't exist locally */ }
    this.git(`worktree add "${worktreePath}" -b ${branchName} origin/${branchName}`);
    this.activeWorktrees.set(issueKey, worktreePath);

    return worktreePath;
  }

  cleanupWorktree(issueKey: string): void {
    const worktreePath = this.activeWorktrees.get(issueKey);
    if (worktreePath) {
      try {
        this.git(`worktree remove "${worktreePath}" --force`);
      } catch { /* best effort */ }
      this.activeWorktrees.delete(issueKey);
    }
  }

  cleanup(): void {
    // Clean up all active worktrees
    for (const [issueKey] of this.activeWorktrees) {
      this.cleanupWorktree(issueKey);
    }
    try {
      this.git(`checkout ${this.defaultBranch}`);
    } catch {
      // Best effort
    }
  }

  // ── Claude Agent SDK Operations ─────────────────────────────

  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    // If using Max subscription, strip API key so SDK uses OAuth
    if (this.useMaxSubscription) {
      delete env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  private static readonly PLAN_DELIMITER = '===FUNCTIONAL SUMMARY===';
  private static readonly QUESTIONS_DELIMITER = '===QUESTIONS===';

  async createPlan(issueKey: string, summary: string, description: string): Promise<PlanResult> {
    const prompt = `You are analyzing Jira task ${issueKey} to create an implementation plan.
DO NOT make any code changes yet. Only analyze and plan.

## Task: ${summary}

## Description:
${description || 'No additional description provided.'}

## Instructions:
1. Read the existing codebase (check CLAUDE.md if it exists)
2. Understand the current functionality and how it relates to this task
3. Figure out exactly what needs to change and what the impact will be
4. Think about edge cases and potential issues

## CRITICAL — Output rules:
- While analyzing, you may explore the codebase using tools. Do NOT narrate what you are doing (e.g. "Let me search for...", "Now I'll read..."). Work silently.
- No preamble, no narration, no analysis recap in your final message.
- Your FINAL message must follow ONE of the two formats below:

### Format A — If you need clarification before you can plan:
If the task description is ambiguous, missing critical details, or could be interpreted in multiple ways, output ONLY:

${ClaudeService.QUESTIONS_DELIMITER}
Your questions here as a numbered list. Be specific about what you need to know and why.
Keep questions short and to the point. The reader is a non-technical project manager.

### Format B — If you have enough information to plan:
Output exactly TWO sections separated by the line: ${ClaudeService.PLAN_DELIMITER}

**Section 1 — Technical Plan (ABOVE the separator)**
A detailed technical plan that another AI can implement from. Include:
- Specific files to modify or create, with file paths
- What changes are needed in each file
- Technical approach and implementation details
- Edge cases to handle

**Section 2 — Functional Summary (BELOW the separator)**
A plain-language summary for a non-technical project manager. No file names, no code, no jargon. Include:
- **What changes:** What the user will see or experience differently
- **How it works:** A short, plain-language explanation of the approach
- **What to watch out for:** Any risks, open questions, or things needing human input
- **Scope:** Small / Medium / Large — with a one-sentence justification

Use Format A ONLY when the task genuinely cannot be planned without more information. If reasonable assumptions can be made, prefer Format B and note your assumptions under "What to watch out for".`;

    const result = await this.runClaudeSDK(prompt, {
      maxTurns: this.maxTurnsPlan,
      maxBudgetUsd: this.maxBudgetPlan,
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    });

    return this.parsePlanResult(result);
  }

  private parsePlanResult(result: ClaudeResult): PlanResult {
    const output = result.output;

    // Check for questions first
    const questionsIndex = output.indexOf(ClaudeService.QUESTIONS_DELIMITER);
    if (questionsIndex !== -1) {
      const questions = output.substring(questionsIndex + ClaudeService.QUESTIONS_DELIMITER.length).trim();
      return { ...result, technicalPlan: '', functionalSummary: '', hasQuestions: true, questions };
    }

    // Otherwise parse as plan
    const delimIndex = output.indexOf(ClaudeService.PLAN_DELIMITER);
    if (delimIndex === -1) {
      return { ...result, technicalPlan: output, functionalSummary: output, hasQuestions: false, questions: '' };
    }

    const technicalPlan = output.substring(0, delimIndex).trim();
    const functionalSummary = output.substring(delimIndex + ClaudeService.PLAN_DELIMITER.length).trim();

    return { ...result, technicalPlan, functionalSummary, hasQuestions: false, questions: '' };
  }

  async implementPlan(
    issueKey: string,
    summary: string,
    description: string,
    plan: string,
    reviewerNotes: string | null,
    worktreePath: string
  ): Promise<ClaudeResult> {
    const prompt = `You are implementing Jira task ${issueKey}. The plan was reviewed and approved.

## Task: ${summary}

## Original Description:
${description || 'No additional description provided.'}

## Approved Plan:
${plan}
${reviewerNotes ? `\n## Reviewer Notes:\n${reviewerNotes}\n` : ''}

## Instructions:
1. Follow the approved plan above
2. Implement all the changes described
3. Follow existing code style and patterns
4. Run existing tests to make sure nothing is broken
5. Run the linter if configured
6. Keep changes focused — only what the plan describes
7. Add or update tests if the plan calls for it

Provide a brief summary of what was changed when done.`;

    return this.runClaudeSDK(prompt, {
      maxTurns: this.maxTurnsImplement,
      maxBudgetUsd: this.maxBudgetImplement,
      permissionMode: 'acceptEdits',
      cwd: worktreePath,
    });
  }

  async rework(
    issueKey: string,
    summary: string,
    description: string,
    plan: string,
    feedback: string,
    branchName: string,
    sessionId: string | null,
    worktreePath: string
  ): Promise<ClaudeResult> {
    const prompt = `You are fixing Jira task ${issueKey} based on test feedback.
The implementation was done previously on this branch, but the reviewer found issues.

## Task: ${summary}

## Original Description:
${description || 'No additional description provided.'}

## Approved Plan:
${plan}

## Reviewer Feedback (IMPORTANT — address all of this):
${feedback}

## Instructions:
1. Review the reviewer's feedback carefully
2. Look at the current code on this branch to understand what was already done
3. Make the necessary fixes and improvements
4. Run existing tests to make sure nothing is broken
5. Run the linter if configured

Focus specifically on addressing the feedback. Provide a brief summary of what you fixed.`;

    return this.runClaudeSDK(prompt, {
      maxTurns: this.maxTurnsImplement,
      maxBudgetUsd: this.maxBudgetImplement,
      permissionMode: 'acceptEdits',
      ...(sessionId ? { resume: sessionId } : {}),
      cwd: worktreePath,
    });
  }

  private async runClaudeSDK(
    prompt: string,
    options: {
      maxTurns: number;
      maxBudgetUsd: number;
      permissionMode: 'plan' | 'acceptEdits' | 'dontAsk';
      allowedTools?: string[];
      resume?: string;
      cwd?: string;
    }
  ): Promise<ClaudeResult> {
    let outputText = '';
    let sessionId: string | null = null;
    let costUsd: number | null = null;

    try {
      const conversation = query({
        prompt,
        options: {
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          cwd: options.cwd ?? this.repoPath,
          permissionMode: options.permissionMode,
          env: this.buildEnv(),
          stderr: (data: string) => this.log.debug(`[claude-sdk] ${data.trimEnd()}`),
          ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
          ...(options.resume ? { resume: options.resume } : {}),
        },
      });

      for await (const event of conversation) {
        switch (event.type) {
          case 'system':
            sessionId = (event as any).session_id ?? sessionId;
            break;
          case 'assistant':
            if ((event as any).message?.content) {
              let turnText = '';
              for (const block of (event as any).message.content) {
                if (block.type === 'text') {
                  turnText += block.text;
                }
              }
              if (turnText) {
                outputText = turnText;
              }
            }
            break;
          case 'result': {
            const result = event as any;
            sessionId = result.session_id ?? sessionId;
            costUsd = result.cost_usd ?? result.costUsd ?? null;
            if (result.text) {
              outputText = result.text;
            }
            break;
          }
        }
      }

      return {
        success: true,
        output: outputText,
        sessionId,
        costUsd,
      };
    } catch (error) {
      return {
        success: false,
        output: outputText,
        sessionId,
        costUsd,
        error: (error as Error).message,
      };
    }
  }
}
