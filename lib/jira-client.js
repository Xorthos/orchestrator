/**
 * Jira API Client
 * Handles all Jira REST API interactions
 */

const https = require('https');
const { URL } = require('url');

class JiraClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.projectKey = config.projectKey;
    this.auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  async request(method, path, body = null) {
    const url = new URL(`${this.baseUrl}/rest/api/3${path}`);

    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
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
                `Jira API ${method} ${path} returned ${res.statusCode}: ${data}`
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
   * Find tasks assigned to Claude that are in "To Do" status
   */
  async findClaudeTasks(claudeAccountId, claudeLabel) {
    let jql;
    if (claudeAccountId) {
      jql = `project = ${this.projectKey} AND assignee = "${claudeAccountId}" AND status = "To Do" ORDER BY priority DESC, created ASC`;
    } else {
      jql = `project = ${this.projectKey} AND labels = "${claudeLabel}" AND status = "To Do" ORDER BY priority DESC, created ASC`;
    }

    const result = await this.request(
      'GET',
      `/search?jql=${encodeURIComponent(jql)}&fields=summary,description,priority,issuetype,labels,comment,attachment`
    );
    return result.issues || [];
  }

  /**
   * Find tasks in "Done" status that were previously handled by Claude
   * (these need their PRs merged)
   */
  async findApprovedTasks(claudeLabel) {
    const jql = `project = ${this.projectKey} AND labels = "${claudeLabel}-pr-pending" AND status = "Done" ORDER BY updated DESC`;
    const result = await this.request(
      'GET',
      `/search?jql=${encodeURIComponent(jql)}&fields=summary,labels,comment`
    );
    return result.issues || [];
  }

  /**
   * Get full issue details including description
   */
  async getIssue(issueKey) {
    return this.request('GET', `/issue/${issueKey}?fields=summary,description,priority,issuetype,labels,comment,attachment,status`);
  }

  /**
   * Transition an issue to a new status
   */
  async transitionIssue(issueKey, statusName) {
    // First, get available transitions
    const transitions = await this.request(
      'GET',
      `/issue/${issueKey}/transitions`
    );

    const transition = transitions.transitions.find(
      (t) => t.name.toLowerCase() === statusName.toLowerCase()
    );

    if (!transition) {
      const available = transitions.transitions.map((t) => t.name).join(', ');
      throw new Error(
        `No transition to "${statusName}" found for ${issueKey}. Available: ${available}`
      );
    }

    await this.request('POST', `/issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });
  }

  /**
   * Assign issue to a user
   */
  async assignIssue(issueKey, accountId) {
    await this.request('PUT', `/issue/${issueKey}/assignee`, {
      accountId: accountId,
    });
  }

  /**
   * Add a comment to an issue.
   * Converts a markdown-like string into Atlassian Document Format (ADF).
   */
  async addComment(issueKey, text) {
    await this.request('POST', `/issue/${issueKey}/comment`, {
      body: this._markdownToAdf(text),
    });
  }

  /**
   * Convert a markdown-ish string to ADF.
   * Handles: paragraphs, **bold**, `code`, ```code blocks```,
   * [link](url), --- (horizontal rule), and line breaks.
   */
  _markdownToAdf(text) {
    const blocks = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Code block (```)
      if (line.trimStart().startsWith('```')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
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

      // Empty line — skip (paragraph separation)
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Collect contiguous non-empty, non-special lines into one paragraph
      const paraLines = [];
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
        content: this._parseInlineMarks(paraText),
      });
    }

    if (blocks.length === 0) {
      blocks.push({ type: 'paragraph', content: [{ type: 'text', text }] });
    }

    return { type: 'doc', version: 1, content: blocks };
  }

  /**
   * Parse inline markdown marks within a line/paragraph.
   * Handles **bold**, `code`, and [text](url).
   */
  _parseInlineMarks(text) {
    const nodes = [];
    // Regex matches: **bold**, `code`, [text](url), or plain text
    const regex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Push preceding plain text
      if (match.index > lastIndex) {
        nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      }

      if (match[1]) {
        // **bold**
        nodes.push({
          type: 'text',
          text: match[2],
          marks: [{ type: 'strong' }],
        });
      } else if (match[3]) {
        // `code`
        nodes.push({
          type: 'text',
          text: match[4],
          marks: [{ type: 'code' }],
        });
      } else if (match[5]) {
        // [text](url)
        nodes.push({
          type: 'text',
          text: match[6],
          marks: [{ type: 'link', attrs: { href: match[7] } }],
        });
      }

      lastIndex = match.index + match[0].length;
    }

    // Trailing plain text
    if (lastIndex < text.length) {
      nodes.push({ type: 'text', text: text.slice(lastIndex) });
    }

    if (nodes.length === 0) {
      nodes.push({ type: 'text', text });
    }

    return nodes;
  }

  /**
   * Add a label to an issue
   */
  async addLabel(issueKey, label) {
    await this.request('PUT', `/issue/${issueKey}`, {
      update: {
        labels: [{ add: label }],
      },
    });
  }

  /**
   * Remove a label from an issue
   */
  async removeLabel(issueKey, label) {
    await this.request('PUT', `/issue/${issueKey}`, {
      update: {
        labels: [{ remove: label }],
      },
    });
  }

  /**
   * Convert Jira ADF (Atlassian Document Format) description to plain text
   */
  descriptionToText(description) {
    if (!description) return '';
    if (typeof description === 'string') return description;

    const extractText = (node) => {
      if (!node) return '';
      if (node.type === 'text') return node.text || '';
      if (node.content) return node.content.map(extractText).join('');
      return '';
    };

    if (description.content) {
      return description.content
        .map((block) => {
          const text = extractText(block);
          if (block.type === 'heading') return `\n## ${text}\n`;
          if (block.type === 'bulletList') {
            return block.content
              .map((item) => `- ${extractText(item)}`)
              .join('\n');
          }
          if (block.type === 'orderedList') {
            return block.content
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

  /**
   * Look up current user info
   */
  async getMyself() {
    return this.request('GET', '/myself');
  }

  /**
   * Search for a user
   */
  async searchUsers(query) {
    return this.request(
      'GET',
      `/user/search?query=${encodeURIComponent(query)}`
    );
  }
}

module.exports = JiraClient;
