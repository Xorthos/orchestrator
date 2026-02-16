#!/usr/bin/env node

/**
 * Test Jira connection and display current user info.
 * Usage: npm run test-jira
 */

require('dotenv').config();
const JiraClient = require('../lib/jira-client');

const required = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const jira = new JiraClient({
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: process.env.JIRA_PROJECT_KEY,
});

(async () => {
  try {
    console.log('Testing Jira connection...\n');

    const me = await jira.getMyself();
    console.log(`Authenticated as: ${me.displayName} (${me.emailAddress})`);
    console.log(`Account ID:       ${me.accountId}`);
    console.log(`Time zone:        ${me.timeZone}`);

    const label = process.env.JIRA_CLAUDE_LABEL || 'claude-bot';
    const tasks = await jira.findClaudeTasks(
      process.env.JIRA_CLAUDE_ACCOUNT_ID,
      label
    );
    console.log(`\nClaude tasks in "To Do": ${tasks.length}`);
    tasks.forEach((t) => console.log(`  ${t.key}: ${t.fields.summary}`));

    console.log('\nJira connection OK.');
  } catch (error) {
    console.error(`Jira connection failed: ${error.message}`);
    process.exit(1);
  }
})();
