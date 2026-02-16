/**
 * GitHub API Client
 * Handles branch management, PR creation, and merging
 */

const https = require('https');

class GitHubClient {
  constructor(config) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
  }

  async request(method, path, body = null) {
    const options = {
      method,
      hostname: 'api.github.com',
      path: `/repos/${this.owner}/${this.repo}${path}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'jira-claude-automation',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : null);
          } else {
            reject(
              new Error(
                `GitHub API ${method} ${path} returned ${res.statusCode}: ${data}`
              )
            );
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Create a pull request
   */
  async createPullRequest(head, base, title, body) {
    return this.request('POST', '/pulls', {
      title,
      body,
      head,
      base,
      draft: false,
    });
  }

  /**
   * Merge a pull request
   */
  async mergePullRequest(prNumber, commitTitle, mergeMethod = 'squash') {
    return this.request('PUT', `/pulls/${prNumber}/merge`, {
      commit_title: commitTitle,
      merge_method: mergeMethod,
    });
  }

  /**
   * Get a pull request by number
   */
  async getPullRequest(prNumber) {
    return this.request('GET', `/pulls/${prNumber}`);
  }

  /**
   * Find PR by branch name
   */
  async findPullRequestByBranch(branchName) {
    const prs = await this.request(
      'GET',
      `/pulls?head=${this.owner}:${branchName}&state=open`
    );
    return prs.length > 0 ? prs[0] : null;
  }

  /**
   * Get latest commit status/checks for a ref
   */
  async getCheckStatus(ref) {
    try {
      const result = await this.request(
        'GET',
        `/commits/${ref}/check-runs`
      );
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Delete a branch
   */
  async deleteBranch(branchName) {
    try {
      await this.request('DELETE', `/git/refs/heads/${branchName}`);
    } catch {
      // Branch might already be deleted
    }
  }
}

module.exports = GitHubClient;
