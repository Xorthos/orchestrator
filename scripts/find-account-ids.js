#!/usr/bin/env node

/**
 * Look up Jira account IDs by name or email.
 * Usage: npm run find-account-ids
 *        npm run find-account-ids -- "John"
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

const query = process.argv[2] || '';

(async () => {
  try {
    console.log('Looking up Jira account IDs...\n');

    // Always show the authenticated user first
    const me = await jira.getMyself();
    console.log('Your account:');
    console.log(`  Name:       ${me.displayName}`);
    console.log(`  Email:      ${me.emailAddress}`);
    console.log(`  Account ID: ${me.accountId}`);
    console.log('');

    if (query) {
      console.log(`Searching for "${query}"...\n`);
      const users = await jira.searchUsers(query);
      if (users.length === 0) {
        console.log('No users found.');
      } else {
        users.forEach((u) => {
          console.log(`  ${u.displayName}`);
          console.log(`    Account ID: ${u.accountId}`);
          console.log(`    Type:       ${u.accountType}`);
          console.log('');
        });
      }
    } else {
      console.log('Tip: pass a search string to find other users:');
      console.log('  npm run find-account-ids -- "Claude"');
    }
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
})();
