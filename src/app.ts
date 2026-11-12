import express from 'express';
import { PUBLIC_DIR, TRUST_PROXY } from './config.js';
import authRoutes from './routes/auth.js';
import downloadRoutes from './routes/download.js';
import fileRoutes from './routes/files.js';
import guestRoutes from './routes/guests.js';
import panelRoutes from './routes/panel.js';
import settingsRoutes from './routes/settings.js';
import { messagePage, render } from './views.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (TRUST_PROXY !== undefined) app.set('trust proxy', TRUST_PROXY);

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
  app.get('/', (_req, res) => res.send(render('home', 'File sharing')));
  app.use(authRoutes);
  app.use(panelRoutes);
  app.use(fileRoutes);
  app.use(guestRoutes);
  app.use(settingsRoutes);
  app.use(downloadRoutes);
  app.use((_req, res) => res.status(404).send(messagePage('Not found')));

  return app;
}
