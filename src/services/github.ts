import { Octokit } from '@octokit/rest';
import type { Config } from '../config.js';

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: Config['github']) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.octokit = new Octokit({ auth: config.token });
  }

  async verifyConnection(): Promise<{ fullName: string; defaultBranch: string }> {
    const { data } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
    };
  }

  async createPullRequest(
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<{ number: number; html_url: string }> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head,
      base,
      title,
      body,
      draft: false,
    });
    return { number: data.number, html_url: data.html_url };
  }

  async mergePullRequest(
    prNumber: number,
    commitTitle: string,
    mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'
  ): Promise<void> {
    await this.octokit.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_title: commitTitle,
      merge_method: mergeMethod,
    });
  }

  async getPullRequest(prNumber: number): Promise<{ state: string; head: { ref: string }; title: string }> {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return { state: data.state, head: { ref: data.head.ref }, title: data.title };
  }

  async deleteBranch(branchName: string): Promise<void> {
    try {
      await this.octokit.git.deleteRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branchName}`,
      });
    } catch {
      // Branch might already be deleted
    }
  }
}
