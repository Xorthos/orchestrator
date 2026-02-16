import { createHmac, timingSafeEqual } from 'crypto';
import express from 'express';
import type { Config } from './config.js';
import type { JiraWebhookPayload } from './types.js';
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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
