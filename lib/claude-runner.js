/**
 * Claude Code Runner
 * Executes Claude Code CLI in headless mode to implement Jira tasks.
 *
 * Two-phase approach:
 *   Phase 1: "Plan" — Claude analyzes the task and produces a plan
 *   Phase 2: "Implement" — After human approval, Claude executes the plan
 *
 * Supports both API key and Claude Max subscription authentication.
 */

const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

class ClaudeRunner {
  constructor(config) {
    this.repoPath = config.repoPath;
    this.timeout = config.timeout || 600;
    this.planTimeout = config.planTimeout || 120;
    this.stagingUrl = config.stagingUrl;
    this.useMaxSubscription = config.useMaxSubscription || false;
  }

  /**
   * Ensure Claude Code is authenticated.
   * For Max subscription: must have run `claude login` once manually.
   * For API key: ANTHROPIC_API_KEY env var is used automatically.
   */
  async verifyAuth() {
    try {
      const result = execSync('claude --version', {
        encoding: 'utf-8',
        timeout: 10000,
      });
      console.log(`Claude Code version: ${result.trim()}`);
      return true;
    } catch (error) {
      throw new Error(
        'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
      );
    }
  }

  /**
   * Run a git command in the repo directory
   */
  git(args) {
    return execSync(`git ${args}`, {
      cwd: this.repoPath,
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  }

  /**
   * Create a new branch from master for this task
   */
  createBranch(issueKey, summary) {
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    const branchName = `claude/${issueKey}-${slug}`;

    this.git('checkout master');
    this.git('pull origin master');

    try {
      // Use -d (safe delete) — fails if branch has unmerged changes
      this.git(`branch -d ${branchName}`);
    } catch {
      // Branch didn't exist or has unmerged work (which is fine — we'll
      // create a fresh one from master either way). If it truly has
      // unmerged work, checkout -b below will fail, which is the safe
      // behavior.
    }
    this.git(`checkout -b ${branchName}`);

    return branchName;
  }

  /**
   * Run Claude Code CLI as a subprocess.
   *
   * When using Max subscription, omits the API key so Claude Code
   * falls back to the OAuth session from `claude login`.
   */
  async runClaude(prompt, options = {}) {
    const timeout = (options.timeout || this.timeout) * 1000;

    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      const args = ['-p', '--output-format', 'text'];

      if (options.sessionId) {
        args.push('--resume', options.sessionId);
      }

      args.push(prompt);

      // Build env: if using Max subscription, strip ANTHROPIC_API_KEY
      // so Claude Code uses the OAuth login session instead
      const env = { ...process.env };
      if (this.useMaxSubscription) {
        delete env.ANTHROPIC_API_KEY;
      }

      const proc = spawn('claude', args, {
        cwd: this.repoPath,
        env,
      });

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        if (options.verbose !== false) {
          process.stdout.write(`[Claude] ${text}`);
        }
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        process.stderr.write(`[Claude:err] ${text}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, output });
        } else {
          resolve({
            success: false,
            output,
            error: errorOutput || `Process exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => reject(err));

      setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeout);
    });
  }

  // ──────────────────────────────────────────────
  // Phase 1: PLAN (no code changes)
  // ──────────────────────────────────────────────

  async createPlan(issueKey, summary, description) {
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

    return this.runClaude(prompt, { timeout: this.planTimeout });
  }

  // ──────────────────────────────────────────────
  // Phase 2: IMPLEMENT (after plan approval)
  // ──────────────────────────────────────────────

  async implementPlan(issueKey, summary, description, plan, reviewerNotes) {
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

    return this.runClaude(prompt, { timeout: this.timeout });
  }

  // ──────────────────────────────────────────────
  // Clarification: post question to Jira, wait
  // ──────────────────────────────────────────────

  async waitForClarification(issueKey, jiraClient, questionTimestamp, pollIntervalMs = 15000) {
    const maxWaitMs = 24 * 60 * 60 * 1000; // 24 hours
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const issue = await jiraClient.getIssue(issueKey);
      const comments = issue.fields.comment?.comments || [];

      // Find the newest non-bot comment after our question
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        const text = jiraClient.descriptionToText(comment.body);

        if (text.startsWith('🤖')) continue;

        const commentTime = new Date(comment.created).getTime();
        if (commentTime > questionTimestamp) {
          return text;
        }
      }
    }

    throw new Error('Timed out waiting for clarification (24h)');
  }

  /**
   * Stage, commit, and push changes
   */
  pushChanges(issueKey, summary, branchName) {
    const status = this.git('status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made' };
    }

    this.git('add -A');

    const commitMsg = `${issueKey}: ${summary}\n\nImplemented by Claude Code automation.\nJira: ${issueKey}`;
    const msgFile = path.join(this.repoPath, '.git', 'CLAUDE_COMMIT_MSG');
    fs.writeFileSync(msgFile, commitMsg);
    this.git(`commit -F "${msgFile}"`);
    fs.unlinkSync(msgFile);

    this.git(`push -u origin ${branchName}`);
    return { pushed: true };
  }

  // ──────────────────────────────────────────────
  // Phase 3: REWORK (after test feedback)
  // ──────────────────────────────────────────────

  /**
   * Switch to existing feature branch, apply fixes based on feedback.
   * Branch already exists and has the previous implementation.
   */
  async rework(issueKey, summary, description, plan, feedback, branchName) {
    // Switch to the existing feature branch and pull latest
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

    return this.runClaude(prompt, { timeout: this.timeout });
  }

  /**
   * Push additional commits on an existing branch (for rework)
   */
  pushRework(issueKey, branchName, feedback) {
    const status = this.git('status --porcelain');
    if (!status) {
      return { pushed: false, reason: 'No changes made during rework' };
    }

    this.git('add -A');

    const commitMsg = `${issueKey}: Address review feedback\n\nFeedback: ${feedback.substring(0, 200)}\n\nJira: ${issueKey}`;
    const msgFile = path.join(this.repoPath, '.git', 'CLAUDE_COMMIT_MSG');
    fs.writeFileSync(msgFile, commitMsg);
    this.git(`commit -F "${msgFile}"`);
    fs.unlinkSync(msgFile);

    this.git(`push origin ${branchName}`);
    return { pushed: true };
  }

  /**
   * Merge the feature branch into the staging branch and push it.
   * This triggers the staging deployment.
   *
   * Flow: feature branch → merge into staging → push staging → back to feature branch
   */
  mergeIntoStaging(branchName) {
    // Make sure staging branch exists locally
    try {
      this.git('fetch origin staging');
      this.git('checkout staging');
      this.git('pull origin staging');
    } catch {
      // staging branch doesn't exist yet — create it from master
      this.git('checkout master');
      this.git('pull origin master');
      this.git('checkout -b staging');
    }

    // Merge the feature branch into staging
    try {
      this.git(`merge ${branchName} --no-edit`);
    } catch (error) {
      // Merge conflict — abort and report
      this.git('merge --abort');
      this.git(`checkout ${branchName}`);
      throw new Error(
        `Merge conflict when merging ${branchName} into staging. ` +
        `Please resolve manually or simplify the changes.`
      );
    }

    // Push staging
    this.git('push -u origin staging');

    // Switch back to the feature branch
    this.git(`checkout ${branchName}`);

    return true;
  }

  /**
   * Smoke test the staging URL with a real HTTP request.
   * Checks that the page responds with 2xx and a non-empty body.
   */
  async smokeTestStaging() {
    if (!this.stagingUrl) {
      return { tested: false, reason: 'No staging URL configured' };
    }

    console.log('Waiting 60s for staging deployment...');
    await new Promise((r) => setTimeout(r, 60000));

    try {
      const { statusCode, body } = await this._httpGet(this.stagingUrl);

      if (statusCode >= 200 && statusCode < 300) {
        if (body.length === 0) {
          return { tested: true, passed: false, output: `${statusCode} OK but empty response body` };
        }
        return { tested: true, passed: true, output: `HTTP ${statusCode}, ${body.length} bytes` };
      }

      return { tested: true, passed: false, output: `HTTP ${statusCode}` };
    } catch (error) {
      return { tested: true, passed: false, output: error.message };
    }
  }

  /**
   * Simple HTTP(S) GET with redirect following (up to 5 hops).
   */
  _httpGet(url, redirects = 5) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;

      client.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          return resolve(this._httpGet(res.headers.location, redirects - 1));
        }

        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', reject);
    });
  }

  cleanup() {
    try {
      this.git('checkout master');
    } catch {
      // Best effort
    }
  }
}

module.exports = ClaudeRunner;
