import express from 'express';
import { PUBLIC_DIR } from './config.js';
import adminRoutes from './routes/admin.js';
import downloadRoutes from './routes/download.js';
import uploadRoutes from './routes/upload.js';
import { messagePage } from './views.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      // All scripts and styles are served from our own origin; no inline code.
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.use('/static', express.static(PUBLIC_DIR));
  app.use(uploadRoutes);
  app.use(adminRoutes);
  app.use(downloadRoutes);
  app.use((_req, res) => res.status(404).send(messagePage('Not found')));

  return app;
}
