#!/usr/bin/env node

/**
 * Jira → Claude Code → GitHub Automation Daemon
 *
 * Two-phase flow:
 *   1. PLAN:      Claude reads the task → creates a plan → posts to Jira
 *   2. IMPLEMENT:  You approve the plan → Claude codes it → PR created
 *
 * Three Jira statuses are watched:
 *   "To Do"       → New tasks assigned to Claude (triggers planning)
 *   "In Progress" → Plan approved in comments (triggers implementation)
 *   "Done"        → You approved the result (triggers PR merge)
 *
 * Usage:
 *   node daemon.js              # Foreground
 *   pm2 start daemon.js         # Background with PM2
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const JiraClient = require('./lib/jira-client');
const GitHubClient = require('./lib/github-client');
const ClaudeRunner = require('./lib/claude-runner');
const Logger = require('./lib/logger');

// ── Configuration ──────────────────────────────────────────────

const config = {
  jira: {
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY,
    claudeAccountId: process.env.JIRA_CLAUDE_ACCOUNT_ID,
    claudeLabel: process.env.JIRA_CLAUDE_LABEL || 'claude-bot',
    yourAccountId: process.env.YOUR_JIRA_ACCOUNT_ID,
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  },
  claude: {
    repoPath: process.env.REPO_PATH,
    timeout: parseInt(process.env.CLAUDE_TIMEOUT) || 600,
    planTimeout: parseInt(process.env.CLAUDE_PLAN_TIMEOUT) || 120,
    stagingUrl: process.env.STAGING_URL,
    useMaxSubscription: process.env.USE_CLAUDE_MAX === 'true',
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 30,
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ── State file: track what phase each task is in ───────────────
// Uses a simple async lock to prevent concurrent read-modify-write races.

const STATE_FILE = path.join(__dirname, '.task-state.json');
let _stateLock = Promise.resolve();

function _withStateLock(fn) {
  _stateLock = _stateLock.then(fn, fn);
  return _stateLock;
}

function _readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function _writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  return _readState();
}

function saveState(state) {
  _writeState(state);
}

function getTaskState(issueKey) {
  const state = _readState();
  return state[issueKey] || null;
}

function setTaskState(issueKey, data) {
  return _withStateLock(() => {
    const state = _readState();
    state[issueKey] = { ...state[issueKey], ...data, updatedAt: new Date().toISOString() };
    _writeState(state);
  });
}

function clearTaskState(issueKey) {
  return _withStateLock(() => {
    const state = _readState();
    delete state[issueKey];
    _writeState(state);
  });
}

// ── Validate Config ────────────────────────────────────────────

function validateConfig() {
  const required = [
    ['JIRA_BASE_URL', config.jira.baseUrl],
    ['JIRA_EMAIL', config.jira.email],
    ['JIRA_API_TOKEN', config.jira.apiToken],
    ['JIRA_PROJECT_KEY', config.jira.projectKey],
    ['GITHUB_TOKEN', config.github.token],
    ['GITHUB_OWNER', config.github.owner],
    ['GITHUB_REPO', config.github.repo],
    ['REPO_PATH', config.claude.repoPath],
  ];

  // API key only required if NOT using Max subscription
  if (!config.claude.useMaxSubscription) {
    required.push(['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY]);
  }

  const missing = required.filter(([, value]) => !value);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.map(([n]) => n).join(', ')}`);
    console.error('Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

// ── Initialize ─────────────────────────────────────────────────

validateConfig();

const log = new Logger(config.logLevel);
const jira = new JiraClient(config.jira);
const github = new GitHubClient(config.github);
const claude = new ClaudeRunner(config.claude);

const processing = new Set();

// ── Phase 1: PLAN ──────────────────────────────────────────────
// Triggered when a task is in "To Do" and assigned to Claude

async function handleNewTask(issue) {
  const issueKey = issue.key;
  const summary = issue.fields.summary;
  const description = jira.descriptionToText(issue.fields.description);

  if (processing.has(issueKey)) return;

  // Skip if we already have state for this task (plan already posted)
  const existing = getTaskState(issueKey);
  if (existing && existing.phase === 'plan-posted') {
    return; // Plan already posted, waiting for approval
  }

  processing.add(issueKey);
  log.task(`[PLAN] ${issueKey}: ${summary}`);

  try {
    // Move to In Progress while planning
    await jira.transitionIssue(issueKey, 'In Progress');
    await jira.addComment(
      issueKey,
      `🤖 Claude is analyzing this task and creating an implementation plan...`
    );

    // Run Claude in plan-only mode
    log.info(`${issueKey} → Claude is planning...`);
    const result = await claude.createPlan(issueKey, summary, description);

    if (!result.success) {
      throw new Error(`Planning failed: ${result.error || 'Unknown error'}`);
    }

    const plan = result.output;

    // Post the plan to Jira for approval
    await jira.addComment(
      issueKey,
      `🤖 **Implementation Plan:**\n\n${plan}\n\n` +
        `---\n` +
        `**To approve:** Comment \`approve\` (optionally add notes after it)\n` +
        `**To reject/modify:** Comment with your feedback and Claude will re-plan\n` +
        `**To ask Claude a question:** Just comment your question`
    );

    // Reassign to you for review
    if (config.jira.yourAccountId) {
      await jira.assignIssue(issueKey, config.jira.yourAccountId);
    }

    // Save state: plan posted, waiting for approval
    await setTaskState(issueKey, {
      phase: 'plan-posted',
      plan,
      summary,
      description,
      planPostedAt: new Date().toISOString(),
    });

    log.success(`${issueKey} → Plan posted. Waiting for your approval.`);
  } catch (error) {
    log.error(`${issueKey} → Planning failed: ${error.message}`);
    await jira.addComment(
      issueKey,
      `🤖❌ Planning failed:\n\n${error.message}\n\nPlease adjust the task description and retry.`
    );
    if (config.jira.yourAccountId) {
      await jira.assignIssue(issueKey, config.jira.yourAccountId);
    }
  } finally {
    processing.delete(issueKey);
  }
}

// ── Phase 1b: CHECK FOR PLAN APPROVAL ──────────────────────────
// Polls comments on tasks with plans waiting for approval

async function checkPlanApprovals() {
  const state = loadState();

  for (const [issueKey, taskState] of Object.entries(state)) {
    if (taskState.phase !== 'plan-posted') continue;
    if (processing.has(issueKey)) continue;

    try {
      const issue = await jira.getIssue(issueKey);
      const comments = issue.fields.comment?.comments || [];
      const planPostedAt = new Date(taskState.planPostedAt).getTime();

      // Look for human comments after the plan was posted
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        const text = jira.descriptionToText(comment.body).trim();
        const commentTime = new Date(comment.created).getTime();

        // Skip bot comments and old comments
        if (text.startsWith('🤖')) continue;
        if (commentTime <= planPostedAt) break;

        const textLower = text.toLowerCase();

        if (textLower.startsWith('approve')) {
          // ── APPROVED ──
          const reviewerNotes = text.substring(7).trim(); // Everything after "approve"
          log.success(`${issueKey} → Plan approved! ${reviewerNotes ? `Notes: ${reviewerNotes}` : ''}`);

          await setTaskState(issueKey, {
            phase: 'approved',
            reviewerNotes,
          });

          // Trigger implementation
          await handleImplementation(issueKey);
          break;
        } else {
          // ── FEEDBACK / QUESTION ──
          log.info(`${issueKey} → Received feedback, re-planning...`);

          processing.add(issueKey);
          try {
            await jira.addComment(
              issueKey,
              `🤖 Got it — adjusting the plan based on your feedback...`
            );

            // Re-plan with the feedback
            const result = await claude.createPlan(
              issueKey,
              taskState.summary,
              `${taskState.description}\n\n## Previous Plan:\n${taskState.plan}\n\n## Reviewer Feedback:\n${text}`
            );

            if (result.success) {
              await jira.addComment(
                issueKey,
                `🤖 **Updated Plan:**\n\n${result.output}\n\n` +
                  `---\n` +
                  `**To approve:** Comment \`approve\`\n` +
                  `**More feedback?** Just comment.`
              );

              await setTaskState(issueKey, {
                phase: 'plan-posted',
                plan: result.output,
                planPostedAt: new Date().toISOString(),
              });
            } else {
              await jira.addComment(issueKey, `🤖❌ Re-planning failed: ${result.error}`);
            }
          } finally {
            processing.delete(issueKey);
          }
          break;
        }
      }
    } catch (error) {
      log.error(`${issueKey} → Approval check error: ${error.message}`);
    }
  }
}

// ── Phase 2: IMPLEMENT ─────────────────────────────────────────
// Triggered after plan approval

async function handleImplementation(issueKey) {
  if (processing.has(issueKey)) return;
  processing.add(issueKey);

  const taskState = getTaskState(issueKey);
  if (!taskState) return;

  const { summary, description, plan, reviewerNotes } = taskState;

  log.task(`[IMPLEMENT] ${issueKey}: ${summary}`);

  let branchName;

  try {
    await jira.addComment(issueKey, `🤖 Plan approved — starting implementation...`);

    // Reassign to Claude during implementation
    if (config.jira.claudeAccountId) {
      await jira.assignIssue(issueKey, config.jira.claudeAccountId);
    }

    // Create feature branch
    branchName = claude.createBranch(issueKey, summary);
    log.info(`${issueKey} → Branch: ${branchName}`);

    // Run Claude Code to implement
    log.info(`${issueKey} → Claude is coding...`);
    const result = await claude.implementPlan(
      issueKey,
      summary,
      description,
      plan,
      reviewerNotes
    );

    if (!result.success) {
      throw new Error(`Implementation failed: ${result.error}\n\n${result.output?.substring(0, 1000)}`);
    }

    // Push changes
    log.info(`${issueKey} → Pushing changes...`);
    const pushResult = claude.pushChanges(issueKey, summary, branchName);

    if (!pushResult.pushed) {
      throw new Error(`No changes to push: ${pushResult.reason}`);
    }

    // Merge into staging branch (triggers staging deploy)
    log.info(`${issueKey} → Merging into staging...`);
    claude.mergeIntoStaging(branchName);
    log.success(`${issueKey} → Staging branch updated and pushed`);

    // Smoke test staging
    log.info(`${issueKey} → Smoke testing staging...`);
    const testResult = await claude.smokeTestStaging();
    const testNote = testResult.tested
      ? testResult.passed
        ? '✅ Staging smoke test passed'
        : `⚠️ Staging concerns: ${testResult.output}`
      : `ℹ️ Staging test skipped: ${testResult.reason}`;

    // Create PR
    log.info(`${issueKey} → Creating PR...`);
    const pr = await github.createPullRequest(
      branchName,
      'master',
      `${issueKey}: ${summary}`,
      `## ${issueKey}: ${summary}\n\n` +
        `### Approved Plan\n${plan}\n\n` +
        `### Implementation Notes\n${result.output?.substring(0, 2000) || 'See commits.'}\n\n` +
        `### Staging Test\n${testNote}\n\n` +
        `[Jira: ${issueKey}](${config.jira.baseUrl}/browse/${issueKey})\n\n---\n*Automated by jira-claude-automation*`
    );

    log.success(`${issueKey} → PR created: ${pr.html_url}`);

    // Label for tracking
    await jira.addLabel(issueKey, `${config.jira.claudeLabel}-pr-pending`);

    // Move to Test
    await jira.addComment(
      issueKey,
      `🤖 ✅ Implementation complete!\n\n` +
        `**Branch:** \`${branchName}\`\n` +
        `**PR:** ${pr.html_url}\n` +
        `**PR #:** ${pr.number}\n\n` +
        `${testNote}\n\n` +
        `Please review the PR and staging site.\n` +
        `When satisfied, move this task to **"Done"** to merge & deploy to production.`
    );

    await jira.transitionIssue(issueKey, 'Test');

    if (config.jira.yourAccountId) {
      await jira.assignIssue(issueKey, config.jira.yourAccountId);
    }

    await setTaskState(issueKey, {
      phase: 'test',
      branchName,
      prNumber: pr.number,
      prUrl: pr.html_url,
    });

    log.success(`${issueKey} → In Test. PR: ${pr.html_url}`);
  } catch (error) {
    log.error(`${issueKey} → Implementation failed: ${error.message}`);

    await jira.addComment(
      issueKey,
      `🤖❌ Implementation error:\n\n${error.message}\n\nPlease review and retry or handle manually.`
    );

    if (config.jira.yourAccountId) {
      await jira.assignIssue(issueKey, config.jira.yourAccountId);
    }

    await setTaskState(issueKey, { phase: 'failed', error: error.message });
  } finally {
    claude.cleanup();
    processing.delete(issueKey);
  }
}

// ── Phase 2b: REWORK (test failed, reviewer left feedback) ─────

async function checkTestFeedback() {
  const state = loadState();

  for (const [issueKey, taskState] of Object.entries(state)) {
    if (taskState.phase !== 'test') continue;
    if (processing.has(issueKey)) continue;

    try {
      const issue = await jira.getIssue(issueKey);

      // Only check tasks still in "Test" status (not moved to "Done")
      const status = issue.fields.status?.name?.toLowerCase();
      if (status === 'done') continue;

      const comments = issue.fields.comment?.comments || [];
      const lastCheckTime = new Date(taskState.lastFeedbackCheck || taskState.updatedAt).getTime();

      // Look for human comments since last check
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        const text = jira.descriptionToText(comment.body).trim();
        const commentTime = new Date(comment.created).getTime();

        if (text.startsWith('🤖')) continue;
        if (commentTime <= lastCheckTime) break;

        // Found feedback — trigger rework
        log.info(`${issueKey} → Test feedback received, starting rework...`);
        processing.add(issueKey);

        try {
          await jira.addComment(
            issueKey,
            `🤖 Got it — reviewing your feedback and making fixes...`
          );

          // Reassign to Claude during rework
          if (config.jira.claudeAccountId) {
            await jira.assignIssue(issueKey, config.jira.claudeAccountId);
          }

          // Run rework on the existing branch
          const result = await claude.rework(
            issueKey,
            taskState.summary,
            taskState.description,
            taskState.plan,
            text,
            taskState.branchName
          );

          if (!result.success) {
            throw new Error(`Rework failed: ${result.error}`);
          }

          // Push the fixes
          const pushResult = claude.pushRework(issueKey, taskState.branchName, text);

          if (!pushResult.pushed) {
            await jira.addComment(
              issueKey,
              `🤖 I reviewed the feedback but didn't find any code changes needed. ` +
                `Could you provide more specific details about what needs to change?`
            );
            await setTaskState(issueKey, { lastFeedbackCheck: new Date().toISOString() });
            break;
          }

          // Merge updated branch into staging
          log.info(`${issueKey} → Merging fixes into staging...`);
          claude.mergeIntoStaging(taskState.branchName);

          // Smoke test
          const testResult = await claude.smokeTestStaging();
          const testNote = testResult.tested
            ? testResult.passed
              ? '✅ Staging smoke test passed'
              : `⚠️ Staging concerns: ${testResult.output}`
            : `ℹ️ Staging test skipped: ${testResult.reason}`;

          // Comment with update (PR auto-updates since branch was pushed)
          await jira.addComment(
            issueKey,
            `🤖 ✅ Fixes pushed!\n\n` +
              `**What changed:** ${result.output?.substring(0, 1000) || 'See latest commits.'}\n\n` +
              `${testNote}\n\n` +
              `The PR and staging site are updated. Please re-test.\n` +
              `Move to **"Done"** when satisfied, or comment again with further feedback.`
          );

          if (config.jira.yourAccountId) {
            await jira.assignIssue(issueKey, config.jira.yourAccountId);
          }

          await setTaskState(issueKey, { lastFeedbackCheck: new Date().toISOString() });

          log.success(`${issueKey} → Rework complete, staging updated.`);
        } catch (error) {
          log.error(`${issueKey} → Rework failed: ${error.message}`);
          await jira.addComment(
            issueKey,
            `🤖❌ Rework failed:\n\n${error.message}\n\nPlease check manually or provide different feedback.`
          );
          if (config.jira.yourAccountId) {
            await jira.assignIssue(issueKey, config.jira.yourAccountId);
          }
        } finally {
          claude.cleanup();
          processing.delete(issueKey);
        }
        break; // Only process the latest feedback comment
      }
    } catch (error) {
      log.error(`${issueKey} → Feedback check error: ${error.message}`);
    }
  }
}

// ── Phase 3: MERGE (after you move task to Done) ───────────────

async function checkApprovals() {
  try {
    const approvedTasks = await jira.findApprovedTasks(config.jira.claudeLabel);

    for (const issue of approvedTasks) {
      const issueKey = issue.key;
      if (processing.has(`merge-${issueKey}`)) continue;
      processing.add(`merge-${issueKey}`);

      log.info(`${issueKey} → Approved! Merging PR...`);

      try {
        const taskState = getTaskState(issueKey);
        let prNumber = taskState?.prNumber;

        // Fallback: find PR number from comments
        if (!prNumber) {
          const fullIssue = await jira.getIssue(issueKey);
          const comments = fullIssue.fields.comment?.comments || [];
          for (const comment of comments.reverse()) {
            const text = jira.descriptionToText(comment.body);
            const match = text.match(/\*\*PR #:\*\*\s*(\d+)/);
            if (match) {
              prNumber = parseInt(match[1]);
              break;
            }
          }
        }

        if (!prNumber) {
          log.warn(`${issueKey} → Could not find PR number`);
          continue;
        }

        const pr = await github.getPullRequest(prNumber);
        if (pr.state !== 'open') {
          log.info(`${issueKey} → PR #${prNumber} already ${pr.state}`);
          await jira.removeLabel(issueKey, `${config.jira.claudeLabel}-pr-pending`);
          await clearTaskState(issueKey);
          continue;
        }

        // Merge
        await github.mergePullRequest(prNumber, `${issueKey}: ${pr.title}`, 'squash');
        await jira.removeLabel(issueKey, `${config.jira.claudeLabel}-pr-pending`);
        await jira.addComment(issueKey, `🤖✅ PR #${prNumber} merged to master. Production deploy triggered.`);

        // Clean up branch
        await github.deleteBranch(pr.head.ref);
        await clearTaskState(issueKey);

        log.success(`${issueKey} → PR #${prNumber} merged! Deploying to production.`);
      } catch (error) {
        log.error(`${issueKey} → Merge failed: ${error.message}`);
        await jira.addComment(issueKey, `🤖❌ Auto-merge failed: ${error.message}\n\nPlease merge manually.`);
      } finally {
        processing.delete(`merge-${issueKey}`);
      }
    }
  } catch (error) {
    log.error(`Approval check failed: ${error.message}`);
  }
}

// ── Main Poll Loop ─────────────────────────────────────────────

async function poll() {
  try {
    // 1. New tasks → Create plans
    const tasks = await jira.findClaudeTasks(
      config.jira.claudeAccountId,
      config.jira.claudeLabel
    );

    for (const task of tasks) {
      await handleNewTask(task);
    }

    // 2. Check for plan approvals (comment-based)
    await checkPlanApprovals();

    // 3. Check for test feedback / rework requests (comment-based)
    await checkTestFeedback();

    // 4. Check for completed approvals (Done status → merge)
    await checkApprovals();
  } catch (error) {
    log.error(`Poll error: ${error.message}`);
  }
}

// ── Startup ────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Jira → Claude Code → GitHub Automation         ║');
  console.log('║  Two-phase: Plan → Approve → Implement → Test   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  log.info(`Project:     ${config.jira.projectKey}`);
  log.info(`Repo:        ${config.github.owner}/${config.github.repo}`);
  log.info(`Poll:        ${config.pollInterval}s`);
  log.info(`Auth:        ${config.claude.useMaxSubscription ? 'Claude Max subscription' : 'API key'}`);
  log.info(`Detection:   ${config.jira.claudeAccountId ? 'Assignee-based' : `Label: ${config.jira.claudeLabel}`}`);
  log.info(`Repo path:   ${config.claude.repoPath}`);
  console.log('');

  // Verify connections
  try {
    const me = await jira.getMyself();
    log.success(`Jira: ${me.displayName} (${me.emailAddress})`);
  } catch (error) {
    log.error(`Jira connection failed: ${error.message}`);
    process.exit(1);
  }

  try {
    await claude.verifyAuth();
    log.success(`Claude Code: OK`);
  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }

  // Show pending tasks from state file
  const state = loadState();
  const pending = Object.entries(state).filter(([, s]) => s.phase === 'plan-posted');
  if (pending.length > 0) {
    log.info(`Resuming ${pending.length} task(s) awaiting plan approval:`);
    pending.forEach(([key]) => log.info(`  → ${key}`));
  }

  console.log('');
  log.info('Starting poll loop...\n');

  await poll();
  setInterval(poll, config.pollInterval * 1000);
}

process.on('SIGINT', () => {
  log.info('Shutting down...');
  claude.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('Shutting down...');
  claude.cleanup();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
