import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import type { ClaudeResult } from '../types.js';
import { Logger } from '../logger.js';

export class ClaudeService {
  private repoPath: string;
  private stagingUrl: string | null;
  private useMaxSubscription: boolean;
  private maxTurnsPlan: number;
  private maxTurnsImplement: number;
  private maxBudgetPlan: number;
  private maxBudgetImplement: number;
  private log: Logger;

  constructor(config: Config['claude'], log: Logger) {
    this.repoPath = config.repoPath;
    this.stagingUrl = config.stagingUrl;
    this.useMaxSubscription = config.useMaxSubscription;
    this.maxTurnsPlan = config.maxTurnsPlan;
    this.maxTurnsImplement = config.maxTurnsImplement;
    this.maxBudgetPlan = config.maxBudgetPlan;
    this.maxBudgetImplement = config.maxBudgetImplement;
    this.log = log;
  }

  // ── Git Operations ──────────────────────────────────────────

  git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.repoPath,
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }

  createBranch(issueKey: string, summary: string): string {
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    const branchName = `claude/${issueKey}-${slug}`;

    this.git('checkout master');
    this.git('pull origin master');

    try {
      this.git(`branch -d ${branchName}`);
    } catch {
      // Branch didn't exist or has unmerged work
    }
    this.git(`checkout -b ${branchName}`);

    return branchName;
  }

  pushChanges(issueKey: string, summary: string, branchName: string): { pushed: boolean; reason?: string } {
    const status = this.git('status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made' };
    }

    this.git('add -A');

    const commitMsg = `${issueKey}: ${summary}\n\nImplemented by Claude Code automation.\nJira: ${issueKey}`;
    const msgFile = join(this.repoPath, '.git', 'CLAUDE_COMMIT_MSG');
    writeFileSync(msgFile, commitMsg);
    this.git(`commit -F "${msgFile}"`);
    unlinkSync(msgFile);

    this.git(`push -u origin ${branchName}`);
    return { pushed: true };
  }

  pushRework(issueKey: string, branchName: string, feedback: string): { pushed: boolean; reason?: string } {
    const status = this.git('status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made during rework' };
    }

    this.git('add -A');

    const commitMsg = `${issueKey}: Address review feedback\n\nFeedback: ${feedback.substring(0, 200)}\n\nJira: ${issueKey}`;
    const msgFile = join(this.repoPath, '.git', 'CLAUDE_COMMIT_MSG');
    writeFileSync(msgFile, commitMsg);
    this.git(`commit -F "${msgFile}"`);
    unlinkSync(msgFile);

    this.git(`push origin ${branchName}`);
    return { pushed: true };
  }

  mergeIntoStaging(branchName: string): boolean {
    try {
      this.git('fetch origin staging');
      this.git('checkout staging');
      this.git('pull origin staging');
    } catch {
      this.git('checkout master');
      this.git('pull origin master');
      this.git('checkout -b staging');
    }

    try {
      this.git(`merge ${branchName} --no-edit`);
    } catch {
      this.git('merge --abort');
      this.git(`checkout ${branchName}`);
      throw new Error(
        `Merge conflict when merging ${branchName} into staging. ` +
        `Please resolve manually or simplify the changes.`
      );
    }

    this.git('push -u origin staging');
    this.git(`checkout ${branchName}`);
    return true;
  }

  async smokeTestStaging(): Promise<{ tested: boolean; passed?: boolean; output?: string; reason?: string }> {
    if (!this.stagingUrl) {
      return { tested: false, reason: 'No staging URL configured' };
    }

    this.log.info('Waiting 60s for staging deployment...');
    await new Promise((r) => setTimeout(r, 60000));

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

  cleanup(): void {
    try {
      this.git('checkout master');
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

  async createPlan(issueKey: string, summary: string, description: string): Promise<ClaudeResult> {
    const prompt = `You are analyzing Jira task ${issueKey} to create an implementation plan.
DO NOT make any code changes yet. Only analyze and plan.

## Task: ${summary}

## Description:
${description || 'No additional description provided.'}

## Instructions:
1. Read the existing codebase (check CLAUDE.md if it exists)
2. Identify which files need to be created or modified
3. Think about edge cases and potential issues
4. Consider if tests need to be added or updated

## Output format — produce a clear, numbered plan with:
- **Files to modify**: List each file and what changes are needed
- **New files**: Any new files to create
- **Approach**: Brief description of the technical approach
- **Risks / Questions**: Anything unclear or risky that needs human input
- **Estimated scope**: Small / Medium / Large

Be specific about file paths and function names.`;

    return this.runClaudeSDK(prompt, {
      maxTurns: this.maxTurnsPlan,
      maxBudgetUsd: this.maxBudgetPlan,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    });
  }

  async implementPlan(
    issueKey: string,
    summary: string,
    description: string,
    plan: string,
    reviewerNotes: string | null
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
    });
  }

  async rework(
    issueKey: string,
    summary: string,
    description: string,
    plan: string,
    feedback: string,
    branchName: string,
    sessionId: string | null
  ): Promise<ClaudeResult> {
    this.git(`checkout ${branchName}`);
    this.git(`pull origin ${branchName}`);

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
      resume: sessionId ?? undefined,
    });
  }

  private async runClaudeSDK(
    prompt: string,
    options: {
      maxTurns: number;
      maxBudgetUsd: number;
      permissionMode: 'plan' | 'acceptEdits';
      allowedTools?: string[];
      resume?: string;
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
          cwd: this.repoPath,
          permissionMode: options.permissionMode,
          env: this.buildEnv(),
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
              for (const block of (event as any).message.content) {
                if (block.type === 'text') {
                  outputText += block.text;
                }
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
