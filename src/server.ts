import { createHmac, timingSafeEqual } from 'crypto';
import express from 'express';
import type { Config } from './config.js';
import type { JiraWebhookPayload, GitHubWebhookPayload } from './types.js';
import { Logger } from './logger.js';
import { WorkflowEngine } from './workflow.js';

export function createServer(config: Config, log: Logger, workflow: WorkflowEngine): express.Application {
  const app = express();

  // Capture raw body for HMAC verification, then parse JSON
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // ── HMAC Verification Middleware ────────────────────────────

  function verifySignature(req: express.Request & { rawBody?: Buffer }, res: express.Response, next: express.NextFunction): void {
    if (!config.webhook.secret) {
      next();
      return;
    }

    const signature = req.headers['x-hub-signature'] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    const expectedSig = 'sha256=' + createHmac('sha256', config.webhook.secret)
      .update(req.rawBody ?? '')
      .digest('hex');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  }

  // ── Routes ─────────────────────────────────────────────────

  app.post('/webhook/jira', verifySignature, (req, res) => {
    const payload = req.body as JiraWebhookPayload;

    log.debug(`Webhook received: ${payload.webhookEvent} ${payload.issue?.key ?? ''}`);

    // Respond 200 immediately, process async
    res.status(200).json({ received: true });

    workflow.handleWebhook(payload).catch((error) => {
      log.error(`Webhook processing error: ${(error as Error).message}`);
    });
  });

  // ── GitHub Webhook ───────────────────────────────────────

  function verifyGitHubSignature(req: express.Request & { rawBody?: Buffer }, res: express.Response, next: express.NextFunction): void {
    if (!config.webhook.githubSecret) {
      next();
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: 'Missing GitHub signature' });
      return;
    }

    const expectedSig = 'sha256=' + createHmac('sha256', config.webhook.githubSecret)
      .update(req.rawBody ?? '')
      .digest('hex');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      res.status(401).json({ error: 'Invalid GitHub signature' });
      return;
    }

    next();
  }

  app.post('/webhook/github', verifyGitHubSignature, (req, res) => {
    const event = req.headers['x-github-event'] as string;
    const payload = req.body as GitHubWebhookPayload;

    log.debug(`GitHub webhook received: ${event} ${payload.action ?? ''}`);

    res.status(200).json({ received: true });

    workflow.handleGitHubWebhook(event, payload).catch((error) => {
      log.error(`GitHub webhook processing error: ${(error as Error).message}`);
    });
  });

  // ── Status & Health ─────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/status', (req, res) => {
    const token = config.webhook.statusApiToken;
    if (!token) {
      res.status(403).json({ error: 'Status endpoint not configured' });
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${token}`) {
      res.status(403).json({ error: 'Invalid or missing token' });
      return;
    }

    const status = workflow.getStatus();
    res.json({ status: 'ok', timestamp: new Date().toISOString(), ...status });
  });

  return app;
}
