#!/usr/bin/env node

/**
 * Test GitHub connection and display repo info.
 * Usage: npm run test-github
 */

require('dotenv').config();
const GitHubClient = require('../lib/github-client');

const required = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN,
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
});

(async () => {
  try {
    console.log('Testing GitHub connection...\n');

    // Fetch repo info (uses the base request method)
    const repo = await github.request('GET', '');
    console.log(`Repository:     ${repo.full_name}`);
    console.log(`Default branch: ${repo.default_branch}`);
    console.log(`Private:        ${repo.private}`);
    console.log(`Open issues:    ${repo.open_issues_count}`);

    // Check for open PRs
    const prs = await github.request('GET', '/pulls?state=open&per_page=5');
    console.log(`\nOpen PRs: ${prs.length}${prs.length === 5 ? '+' : ''}`);
    prs.forEach((pr) => console.log(`  #${pr.number}: ${pr.title}`));

    console.log('\nGitHub connection OK.');
  } catch (error) {
    console.error(`GitHub connection failed: ${error.message}`);
    process.exit(1);
  }
})();
