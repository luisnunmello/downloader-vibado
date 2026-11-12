import express, { Router } from 'express';
import { HARD_MAX_SIZE_MB } from '../config.js';
import { requireAuth, requireMaster } from '../session.js';
import { getServerMaxMb, setServerMaxMb } from '../settings.js';

const router = Router();
router.use('/api/settings', requireAuth, requireMaster, express.json({ limit: '1kb' }));

router.get('/api/settings', async (_req, res) => {
  res.json({ maxSizeMb: await getServerMaxMb(), hardMaxSizeMb: HARD_MAX_SIZE_MB });
});

router.patch('/api/settings', async (req, res) => {
  const maxSizeMb = req.body?.maxSizeMb;
  if (typeof maxSizeMb !== 'number' || !Number.isInteger(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > HARD_MAX_SIZE_MB) {
    return res.status(400).json({ error: `Maximum size must be 1-${HARD_MAX_SIZE_MB} MB` });
  }
  await setServerMaxMb(maxSizeMb);
  res.json({ maxSizeMb, hardMaxSizeMb: HARD_MAX_SIZE_MB });
});

export default router;
