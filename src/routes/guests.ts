import express, { Router } from 'express';
import { HARD_MAX_SIZE_MB, MAX_EXPIRY_MINUTES } from '../config.js';
import { createGuest, deleteGuest, GuestChanges, listGuests, MASTER_LABEL, updateGuest } from '../guests.js';
import { requireAuth, requireMaster } from '../session.js';
import { isPassword, MIN_PASSWORD } from './files.js';

const MAX_GUEST_NAME = 50;

const parseId = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

/** undefined = not provided, null = no limit / default, number = the limit, false = invalid. */
function parseLimit(value: unknown, max: number): number | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : false;
}

const router = Router();
router.use('/api/guests', requireAuth, requireMaster, express.json({ limit: '4kb' }));

router.get('/api/guests', async (_req, res) => {
  res.json(await listGuests());
});

router.post('/api/guests', async (req, res) => {
  const { name, password } = req.body ?? {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_GUEST_NAME) {
    return res.status(400).json({ error: `Name must be 1-${MAX_GUEST_NAME} characters` });
  }
  if (trimmed.toLowerCase() === MASTER_LABEL) return res.status(400).json({ error: 'That name is reserved' });
  if (!isPassword(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  const maxSizeMb = parseLimit(req.body?.maxSizeMb, HARD_MAX_SIZE_MB);
  const maxExpiryMinutes = parseLimit(req.body?.maxExpiryMinutes, MAX_EXPIRY_MINUTES);
  if (maxSizeMb === false) return res.status(400).json({ error: `Max size must be 1-${HARD_MAX_SIZE_MB} MB` });
  if (maxExpiryMinutes === false) return res.status(400).json({ error: 'Invalid max expiry' });

  try {
    const id = await createGuest(trimmed, password, {
      maxSizeMb: maxSizeMb ?? null,
      maxExpiryMinutes: maxExpiryMinutes ?? null,
    });
    res.status(201).json({ id });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return res.status(409).json({ error: 'A guest with that name exists' });
    throw e;
  }
});

// Change a guest's password and/or limits. Send null to clear a limit.
router.patch('/api/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body ?? {};
  const changes: GuestChanges = {};

  if (body.password !== undefined) {
    if (!isPassword(body.password)) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    changes.password = body.password;
  }
  const maxSizeMb = parseLimit(body.maxSizeMb, HARD_MAX_SIZE_MB);
  const maxExpiryMinutes = parseLimit(body.maxExpiryMinutes, MAX_EXPIRY_MINUTES);
  if (maxSizeMb === false) return res.status(400).json({ error: `Max size must be 1-${HARD_MAX_SIZE_MB} MB` });
  if (maxExpiryMinutes === false) return res.status(400).json({ error: 'Invalid max expiry' });
  if (maxSizeMb !== undefined) changes.maxSizeMb = maxSizeMb;
  if (maxExpiryMinutes !== undefined) changes.maxExpiryMinutes = maxExpiryMinutes;
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change' });

  if (id === null || !(await updateGuest(id, changes))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/api/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !(await deleteGuest(id))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
