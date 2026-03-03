import { Logger } from '../logger.js';

type NotificationEvent = 'plan-ready' | 'implementation-done' | 'failed' | 'merged' | 'stale';

interface NotificationData {
  issueKey: string;
  summary: string;
  message: string;
  url?: string;
}

const EVENT_COLORS: Record<NotificationEvent, string> = {
  'plan-ready': '0078D4',          // blue
  'implementation-done': '28A745', // green
  'failed': 'DC3545',             // red
  'merged': '28A745',             // green
  'stale': 'FFC107',              // amber
};

const EVENT_TITLES: Record<NotificationEvent, string> = {
  'plan-ready': 'Plan Ready for Review',
  'implementation-done': 'Implementation Complete',
  'failed': 'Task Failed',
  'merged': 'PR Merged to Production',
  'stale': 'Task Stale',
};

export class Notifier {
  constructor(
    private teamsWebhookUrl: string | null,
    private slackWebhookUrl: string | null,
    private enabledEvents: Set<string> | null,
    private log: Logger
  ) {}

  async notify(event: NotificationEvent, data: NotificationData): Promise<void> {
    if (this.enabledEvents && !this.enabledEvents.has(event)) return;

    const promises: Promise<void>[] = [];
    if (this.teamsWebhookUrl) promises.push(this.sendTeams(event, data));
    if (this.slackWebhookUrl) promises.push(this.sendSlack(event, data));

    await Promise.allSettled(promises);
  }

  // ── Teams ──────────────────────────────────────────────────

  private async sendTeams(event: NotificationEvent, data: NotificationData): Promise<void> {
    try {
      const card = this.buildTeamsCard(event, data);
      await fetch(this.teamsWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
    } catch (error) {
      this.log.debug(`Teams notification failed (${event}): ${(error as Error).message}`);
    }
  }

  private buildTeamsCard(event: NotificationEvent, data: NotificationData) {
    const color = EVENT_COLORS[event] ?? '6C757D';
    const title = EVENT_TITLES[event] ?? event;

    const facts = [
      { title: 'Issue', value: data.issueKey },
      { title: 'Summary', value: data.summary },
    ];

    const actions: Array<{ '@type': string; name: string; targets: Array<{ os: string; uri: string }> }> = [];
    if (data.url) {
      actions.push({
        '@type': 'OpenUri',
        name: 'View',
        targets: [{ os: 'default', uri: data.url }],
      });
    }

    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: color,
      summary: `${data.issueKey}: ${title}`,
      sections: [
        {
          activityTitle: `${data.issueKey}: ${title}`,
          facts,
          text: data.message,
          markdown: true,
        },
      ],
      potentialAction: actions.length > 0 ? actions : undefined,
    };
  }

  // ── Slack ──────────────────────────────────────────────────

  private async sendSlack(event: NotificationEvent, data: NotificationData): Promise<void> {
    try {
      const payload = this.buildSlackPayload(event, data);
      await fetch(this.slackWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.log.debug(`Slack notification failed (${event}): ${(error as Error).message}`);
    }
  }

  private buildSlackPayload(event: NotificationEvent, data: NotificationData) {
    const SLACK_COLORS: Record<NotificationEvent, string> = {
      'plan-ready': '#0078D4',
      'implementation-done': '#28A745',
      'failed': '#DC3545',
      'merged': '#28A745',
      'stale': '#FFC107',
    };

    const title = EVENT_TITLES[event] ?? event;
    const color = SLACK_COLORS[event] ?? '#6C757D';

    const blocks: Array<Record<string, unknown>> = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${data.issueKey}: ${title}*\n${data.message}`,
        },
      },
    ];

    if (data.url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View' },
            url: data.url,
          },
        ],
      });
    }

    return {
      attachments: [{ color, blocks }],
    };
  }
}
