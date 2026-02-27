import { Octokit } from '@octokit/rest';
import type { Config } from '../config.js';
import { withRetry } from '../utils/retry.js';

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
    const { data } = await withRetry(() =>
      this.octokit.repos.get({ owner: this.owner, repo: this.repo })
    );
    return { fullName: data.full_name, defaultBranch: data.default_branch };
  }

  async createPullRequest(
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<{ number: number; html_url: string }> {
    const { data } = await withRetry(() =>
      this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head, base, title, body, draft: false,
      })
    );
    return { number: data.number, html_url: data.html_url };
  }

  async mergePullRequest(
    prNumber: number,
    commitTitle: string,
    mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'
  ): Promise<void> {
    await withRetry(() =>
      this.octokit.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        commit_title: commitTitle,
        merge_method: mergeMethod,
      })
    );
  }

  async getPullRequest(prNumber: number): Promise<{ state: string; head: { ref: string }; title: string }> {
    const { data } = await withRetry(() =>
      this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      })
    );
    return { state: data.state, head: { ref: data.head.ref }, title: data.title };
  }

  async findWorkflowRun(
    workflowFile: string,
    branch: string,
    triggeredAfter: Date
  ): Promise<{ id: number; status: string; conclusion: string | null } | null> {
    const { data } = await withRetry(() =>
      this.octokit.actions.listWorkflowRuns({
        owner: this.owner,
        repo: this.repo,
        workflow_id: workflowFile,
        branch,
        per_page: 5,
      })
    );

    const cutoff = triggeredAfter.toISOString();
    const run = data.workflow_runs.find((r) => r.created_at >= cutoff);
    if (!run) return null;

    return { id: run.id, status: run.status ?? '', conclusion: run.conclusion ?? null };
  }

  async getWorkflowRunStatus(
    runId: number
  ): Promise<{ status: string; conclusion: string | null }> {
    const { data } = await withRetry(() =>
      this.octokit.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
      })
    );
    return { status: data.status ?? '', conclusion: data.conclusion ?? null };
  }

  async getFailedJobLogs(runId: number): Promise<string> {
    const { data: jobsData } = await withRetry(() =>
      this.octokit.actions.listJobsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
        filter: 'latest',
      })
    );

    const failedJobs = jobsData.jobs.filter((j) => j.conclusion === 'failure');
    if (failedJobs.length === 0) return 'No failed jobs found.';

    const logs: string[] = [];
    for (const job of failedJobs) {
      try {
        const { data } = await withRetry(() =>
          this.octokit.actions.downloadJobLogsForWorkflowRun({
            owner: this.owner,
            repo: this.repo,
            job_id: job.id,
          })
        );
        const logText = typeof data === 'string' ? data : String(data);
        const lines = logText.split('\n');
        const tail = lines.slice(-200).join('\n');
        logs.push(`=== Job: ${job.name} (id ${job.id}) ===\n${tail}`);
      } catch {
        logs.push(`=== Job: ${job.name} (id ${job.id}) === [log download failed]`);
      }
    }

    return logs.join('\n\n');
  }

  async closePullRequest(prNumber: number): Promise<void> {
    await withRetry(() =>
      this.octokit.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        state: 'closed',
      })
    );
  }

  async deleteBranch(branchName: string): Promise<void> {
    try {
      await withRetry(() =>
        this.octokit.git.deleteRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${branchName}`,
        })
      );
    } catch {
      // Branch might already be deleted
    }
  }
}
