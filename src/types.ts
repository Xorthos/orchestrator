export type TaskPhase =
  | 'planning'
  | 'plan-posted'
  | 'approved'
  | 'implementing'
  | 'test'
  | 'merging'
  | 'failed';

export interface TaskRow {
  issue_key: string;
  phase: TaskPhase;
  summary: string;
  description: string;
  plan: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  worktree_path: string | null;
  reviewer_notes: string | null;
  session_id: string | null;
  cost_usd: number | null;
  plan_posted_at: string | null;
  creator_account_id: string | null;
  last_feedback_check: string | null;
  created_at: string;
  updated_at: string;
}

export interface JiraWebhookPayload {
  webhookEvent: string;
  timestamp?: number;
  issue?: {
    id: string;
    key: string;
    self: string;
    fields: {
      summary: string;
      description?: unknown;
      status?: { name: string; id: string };
      labels?: string[];
      assignee?: { accountId: string; displayName: string } | null;
      reporter?: { accountId: string; displayName: string } | null;
      priority?: { name: string };
      issuetype?: { name: string };
      comment?: { comments: JiraComment[] };
    };
  };
  changelog?: {
    items: Array<{
      field: string;
      fieldtype: string;
      from: string | null;
      fromString: string | null;
      to: string | null;
      toString: string | null;
    }>;
  };
  comment?: JiraComment;
}

export interface JiraComment {
  id: string;
  author: {
    accountId: string;
    displayName: string;
  };
  body: unknown;
  created: string;
  updated: string;
}

export interface GitHubWebhookPayload {
  action: string;
  review?: {
    state: string; // 'approved', 'changes_requested', 'commented'
    body: string;
    user: { login: string };
  };
  pull_request?: {
    number: number;
    head: { ref: string };
    title: string;
    body: string;
  };
  comment?: {
    body: string;
    user: { login: string };
  };
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  sessionId: string | null;
  costUsd: number | null;
  error?: string;
}

export interface PlanResult extends ClaudeResult {
  technicalPlan: string;
  functionalSummary: string;
  hasQuestions: boolean;
  questions: string;
}
