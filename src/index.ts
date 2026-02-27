import { join } from 'path';
import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { StateManager } from './services/state.js';
import { JiraService } from './services/jira.js';
import { GitHubService } from './services/github.js';
import { ClaudeService } from './services/claude.js';
import { Notifier } from './services/notifier.js';
import { WorkflowEngine } from './workflow.js';
import { createServer } from './server.js';

async function main() {
  // Load config (throws on missing required vars)
  const config = loadConfig();
  const log = new Logger(config.logLevel);

  console.log('');
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  Jira \u2192 Claude Code \u2192 GitHub Automation         \u2551');
  console.log('\u2551  Webhook-driven with reconciliation poll        \u2551');
  console.log('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');
  console.log('');

  log.info(`Project:     ${config.jira.projectKey}`);
  log.info(`Repo:        ${config.github.owner}/${config.github.repo}`);
  log.info(`Webhook:     port ${config.webhook.port}`);
  log.info(`HMAC:        ${config.webhook.secret ? 'enabled' : 'disabled'}`);
  log.info(`Reconcile:   every ${config.reconciliationInterval}s`);
  log.info(`Auth:        ${config.claude.useMaxSubscription ? 'Claude Max subscription' : 'API key'}`);
  log.info(`Detection:   ${config.jira.claudeAccountId ? 'Assignee-based' : `Label: ${config.jira.claudeLabel}`}`);
  log.info(`Repo path:   ${config.claude.repoPath}`);
  log.info(`Cost limits: Plan $${config.claude.maxBudgetPlan} / Implement $${config.claude.maxBudgetImplement}`);
  log.info(`Teams:       ${config.teamsWebhookUrl ? 'enabled' : 'disabled'}`);
  log.info(`GH webhook:  ${config.webhook.githubSecret ? 'enabled (HMAC)' : config.webhook.githubSecret === null ? 'enabled (no HMAC)' : 'disabled'}`);
  log.info(`Stale check: ${config.staleTaskHours > 0 ? `${config.staleTaskHours}h` : 'disabled'}`);
  console.log('');

  // Init services
  const dbPath = join(process.env.DB_PATH || process.cwd(), '.orchestrator.db');
  const state = new StateManager(dbPath);
  const jira = new JiraService(config.jira);
  const github = new GitHubService(config.github);
  const claude = new ClaudeService(config.claude, log);
  const notifier = new Notifier(config.teamsWebhookUrl, config.notificationEvents, log);

  // Verify connections
  try {
    const me = await jira.getMyself();
    log.success(`Jira: ${me.displayName} (${me.emailAddress})`);
  } catch (error) {
    log.error(`Jira connection failed: ${(error as Error).message}`);
    process.exit(1);
  }

  try {
    const repo = await github.verifyConnection();
    claude.setDefaultBranch(repo.defaultBranch);
    log.success(`GitHub: ${repo.fullName} (default: ${repo.defaultBranch})`);
  } catch (error) {
    log.error(`GitHub connection failed: ${(error as Error).message}`);
    process.exit(1);
  }

  // Show pending tasks from state
  const allTasks = state.getAllTasks();
  const pending = allTasks.filter((t) => t.phase === 'plan-posted');
  if (pending.length > 0) {
    log.info(`Resuming ${pending.length} task(s) awaiting plan approval:`);
    pending.forEach((t) => log.info(`  \u2192 ${t.issue_key}`));
  }

  console.log('');

  // Create workflow engine and server
  const workflow = new WorkflowEngine(config, log, state, jira, github, claude, notifier);
  const app = createServer(config, log, workflow);

  // Start Express server
  const server = app.listen(config.webhook.port, () => {
    log.success(`Webhook server listening on port ${config.webhook.port}`);
  });

  // Start reconciliation timer
  log.info(`Starting reconciliation poll every ${config.reconciliationInterval}s...`);
  const reconcileTimer = setInterval(() => {
    workflow.reconcile().catch((error) => {
      log.error(`Reconciliation error: ${(error as Error).message}`);
    });
  }, config.reconciliationInterval * 1000);

  // Run initial reconciliation
  await workflow.reconcile();

  // Graceful shutdown
  function shutdown() {
    log.info('Shutting down...');
    clearInterval(reconcileTimer);
    server.close();
    state.close();
    claude.cleanup();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
