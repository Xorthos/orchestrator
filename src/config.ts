import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill in your values.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

export function loadConfig() {
  // API key only required if NOT using Max subscription
  const useMaxSubscription = process.env.USE_CLAUDE_MAX === 'true';
  if (!useMaxSubscription && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY (or set USE_CLAUDE_MAX=true)');
  }

  return {
    jira: {
      baseUrl: required('JIRA_BASE_URL'),
      email: required('JIRA_EMAIL'),
      apiToken: required('JIRA_API_TOKEN'),
      projectKey: required('JIRA_PROJECT_KEY'),
      claudeAccountId: process.env.JIRA_CLAUDE_ACCOUNT_ID || null,
      claudeLabel: optional('JIRA_CLAUDE_LABEL', 'claude-bot'),
      yourAccountId: process.env.YOUR_JIRA_ACCOUNT_ID || null,
    },
    github: {
      token: required('GITHUB_TOKEN'),
      owner: required('GITHUB_OWNER'),
      repo: required('GITHUB_REPO'),
    },
    claude: {
      repoPath: required('REPO_PATH'),
      timeout: optionalInt('CLAUDE_TIMEOUT', 600),
      planTimeout: optionalInt('CLAUDE_PLAN_TIMEOUT', 120),
      stagingUrl: process.env.STAGING_URL || null,
      useMaxSubscription,
      maxTurnsPlan: optionalInt('CLAUDE_MAX_TURNS_PLAN', 30),
      maxTurnsImplement: optionalInt('CLAUDE_MAX_TURNS_IMPLEMENT', 200),
      maxBudgetPlan: parseFloat(process.env.CLAUDE_MAX_BUDGET_PLAN || '2'),
      maxBudgetImplement: parseFloat(process.env.CLAUDE_MAX_BUDGET_IMPLEMENT || '10'),
    },
    webhook: {
      port: optionalInt('WEBHOOK_PORT', 3000),
      secret: process.env.WEBHOOK_SECRET || null,
    },
    reconciliationInterval: optionalInt('RECONCILIATION_INTERVAL', 300),
    logLevel: optional('LOG_LEVEL', 'info'),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
