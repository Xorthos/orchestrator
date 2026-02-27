import { Logger } from '../logger.js';

type NotificationEvent = 'plan-ready' | 'implementation-done' | 'failed' | 'merged';

interface NotificationData {
  issueKey: string;
  summary: string;
  message: string;
  url?: string;
}

const EVENT_COLORS: Record<NotificationEvent, string> = {
  'plan-ready': '0078D4',       // blue
  'implementation-done': '28A745', // green
  'failed': 'DC3545',           // red
  'merged': '28A745',           // green
};

const EVENT_TITLES: Record<NotificationEvent, string> = {
  'plan-ready': 'Plan Ready for Review',
  'implementation-done': 'Implementation Complete',
  'failed': 'Task Failed',
  'merged': 'PR Merged to Production',
};

export class Notifier {
  constructor(
    private teamsWebhookUrl: string | null,
    private enabledEvents: Set<string> | null,
    private log: Logger
  ) {}

  async notify(event: NotificationEvent, data: NotificationData): Promise<void> {
    if (!this.teamsWebhookUrl) return;
    if (this.enabledEvents && !this.enabledEvents.has(event)) return;

    try {
      const card = this.buildTeamsCard(event, data);
      await fetch(this.teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
    } catch (error) {
      // Best effort — never fail the workflow for notification issues
      this.log.debug(`Notification failed (${event}): ${(error as Error).message}`);
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
}
