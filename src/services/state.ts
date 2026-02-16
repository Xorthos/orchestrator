import Database from 'better-sqlite3';
import type { TaskPhase, TaskRow } from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  issue_key TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  plan TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  reviewer_notes TEXT,
  session_id TEXT,
  cost_usd REAL,
  plan_posted_at TEXT,
  last_feedback_check TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class StateManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  getTask(issueKey: string): TaskRow | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE issue_key = ?')
      .get(issueKey) as TaskRow | undefined;
    return row ?? null;
  }

  upsertTask(issueKey: string, data: Partial<Omit<TaskRow, 'issue_key' | 'created_at' | 'updated_at'>>): void {
    const existing = this.getTask(issueKey);

    if (existing) {
      const fields: string[] = [];
      const values: unknown[] = [];

      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }

      fields.push("updated_at = datetime('now')");
      values.push(issueKey);

      this.db
        .prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE issue_key = ?`)
        .run(...values);
    } else {
      const cols = ['issue_key', ...Object.keys(data)];
      const placeholders = cols.map(() => '?');
      const values = [issueKey, ...Object.values(data)];

      this.db
        .prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`)
        .run(...values);
    }
  }

  getTasksByPhase(phase: TaskPhase): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE phase = ?')
      .all(phase) as TaskRow[];
  }

  getAllTasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks').all() as TaskRow[];
  }

  deleteTask(issueKey: string): void {
    this.db.prepare('DELETE FROM tasks WHERE issue_key = ?').run(issueKey);
  }

  close(): void {
    this.db.close();
  }
}
