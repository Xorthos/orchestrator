import { Version3Client } from 'jira.js';
import type { Config } from '../config.js';

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, string> }>;
  attrs?: Record<string, unknown>;
}

interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export class JiraService {
  private client: Version3Client;
  private projectKey: string;
  private baseUrl: string;

  constructor(private config: Config['jira']) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.projectKey = config.projectKey;
    this.client = new Version3Client({
      host: this.baseUrl,
      authentication: {
        basic: {
          email: config.email,
          apiToken: config.apiToken,
        },
      },
    });
  }

  async getMyself() {
    return this.client.myself.getCurrentUser();
  }

  async findClaudeTasks(claudeAccountId: string | null, claudeLabel: string): Promise<unknown[]> {
    let jql: string;
    if (claudeAccountId) {
      jql = `project = ${this.projectKey} AND assignee = "${claudeAccountId}" AND status = "To Do" ORDER BY priority DESC, created ASC`;
    } else {
      jql = `project = ${this.projectKey} AND labels = "${claudeLabel}" AND status = "To Do" ORDER BY priority DESC, created ASC`;
    }

    const result = await this.client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
      jql,
      fields: ['summary', 'description', 'priority', 'issuetype', 'labels', 'comment', 'attachment', 'reporter'],
    });
    return result.issues ?? [];
  }

  async findApprovedTasks(claudeLabel: string): Promise<unknown[]> {
    const jql = `project = ${this.projectKey} AND labels = "${claudeLabel}-pr-pending" AND status = "Done" ORDER BY updated DESC`;
    const result = await this.client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
      jql,
      fields: ['summary', 'labels', 'comment'],
    });
    return result.issues ?? [];
  }

  async getIssue(issueKey: string) {
    return this.client.issues.getIssue({
      issueIdOrKey: issueKey,
      fields: ['summary', 'description', 'priority', 'issuetype', 'labels', 'comment', 'attachment', 'status', 'reporter'],
    });
  }

  async transitionIssue(issueKey: string, statusName: string): Promise<void> {
    const transitions = await this.client.issues.getTransitions({
      issueIdOrKey: issueKey,
    });

    const transition = transitions.transitions?.find(
      (t) => t.name?.toLowerCase() === statusName.toLowerCase()
    );

    if (!transition?.id) {
      const available = transitions.transitions?.map((t) => t.name).join(', ');
      throw new Error(
        `No transition to "${statusName}" found for ${issueKey}. Available: ${available}`
      );
    }

    await this.client.issues.doTransition({
      issueIdOrKey: issueKey,
      transition: { id: transition.id },
    });
  }

  async assignIssue(issueKey: string, accountId: string): Promise<void> {
    await this.client.issues.assignIssue({
      issueIdOrKey: issueKey,
      accountId,
    });
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    await this.client.issueComments.addComment({
      issueIdOrKey: issueKey,
      comment: this.markdownToAdf(text) as any,
    });
  }

  async addLabel(issueKey: string, label: string): Promise<void> {
    await this.client.issues.editIssue({
      issueIdOrKey: issueKey,
      update: {
        labels: [{ add: label }],
      },
    });
  }

  async removeLabel(issueKey: string, label: string): Promise<void> {
    await this.client.issues.editIssue({
      issueIdOrKey: issueKey,
      update: {
        labels: [{ remove: label }],
      },
    });
  }

  descriptionToText(description: unknown): string {
    if (!description) return '';
    if (typeof description === 'string') return description;

    const extractText = (node: AdfNode): string => {
      if (!node) return '';
      if (node.type === 'text') return node.text || '';
      if (node.content) return node.content.map(extractText).join('');
      return '';
    };

    const doc = description as AdfDoc;
    if (doc.content) {
      return doc.content
        .map((block) => {
          const text = extractText(block);
          if (block.type === 'heading') return `\n## ${text}\n`;
          if (block.type === 'bulletList') {
            return (block.content || [])
              .map((item) => `- ${extractText(item)}`)
              .join('\n');
          }
          if (block.type === 'orderedList') {
            return (block.content || [])
              .map((item, i) => `${i + 1}. ${extractText(item)}`)
              .join('\n');
          }
          if (block.type === 'codeBlock') {
            return `\`\`\`\n${text}\n\`\`\``;
          }
          return text;
        })
        .join('\n\n');
    }

    return JSON.stringify(description);
  }

  markdownToAdf(text: string): AdfDoc {
    const blocks: AdfNode[] = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Code block
      if (line.trimStart().startsWith('```')) {
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        blocks.push({
          type: 'codeBlock',
          content: [{ type: 'text', text: codeLines.join('\n') }],
        });
        continue;
      }

      // Horizontal rule
      if (line.trim() === '---') {
        blocks.push({ type: 'rule' });
        i++;
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        lines[i].trim() !== '---' &&
        !lines[i].trimStart().startsWith('```')
      ) {
        paraLines.push(lines[i]);
        i++;
      }

      const paraText = paraLines.join('\n');
      blocks.push({
        type: 'paragraph',
        content: this.parseInlineMarks(paraText),
      });
    }

    if (blocks.length === 0) {
      blocks.push({ type: 'paragraph', content: [{ type: 'text', text }] });
    }

    return { type: 'doc', version: 1, content: blocks };
  }

  private parseInlineMarks(text: string): AdfNode[] {
    const nodes: AdfNode[] = [];
    const regex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      }

      if (match[1]) {
        nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
      } else if (match[3]) {
        nodes.push({ type: 'text', text: match[4], marks: [{ type: 'code' }] });
      } else if (match[5]) {
        nodes.push({
          type: 'text',
          text: match[6],
          marks: [{ type: 'link', attrs: { href: match[7] } }],
        });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      nodes.push({ type: 'text', text: text.slice(lastIndex) });
    }

    if (nodes.length === 0) {
      nodes.push({ type: 'text', text });
    }

    return nodes;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}
