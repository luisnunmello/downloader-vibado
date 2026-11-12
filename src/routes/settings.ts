import express, { Router } from 'express';
import { statfs } from 'fs/promises';
import { DATA_DIR, HARD_MAX_SIZE_MB } from '../config.js';
import { pool } from '../db.js';
import { requireAuth, requireMaster } from '../session.js';
import { getServerMaxMb, setServerMaxMb } from '../settings.js';

const router = Router();
router.use('/api/settings', requireAuth, requireMaster, express.json({ limit: '1kb' }));

/** Free and total space of the disk that holds the uploaded files. */
async function diskSpace(): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const s = await statfs(DATA_DIR);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

router.get('/api/settings', async (_req, res) => {
  const [maxSizeMb, disk, usage] = await Promise.all([
    getServerMaxMb(),
    diskSpace(),
    pool.query(
      'SELECT COALESCE((SELECT sum(size) FROM files), 0)::float8 AS files, pg_database_size(current_database())::float8 AS db',
    ),
  ]);
  res.json({
    maxSizeMb,
    hardMaxSizeMb: HARD_MAX_SIZE_MB,
    storage: {
      disk,
      filesBytes: usage.rows[0].files,
      databaseBytes: usage.rows[0].db,
    },
  });
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
