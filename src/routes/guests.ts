import express, { Router } from 'express';
import { createGuest, deleteGuest, listGuests, MASTER_LABEL, setGuestPassword } from '../guests.js';
import { requireAuth, requireMaster } from '../session.js';
import { isPassword, MIN_PASSWORD } from './files.js';

const MAX_GUEST_NAME = 50;

const parseId = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

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

  try {
    res.status(201).json({ id: await createGuest(trimmed, password) });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return res.status(409).json({ error: 'A guest with that name exists' });
    throw e;
  }
});

router.patch('/api/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const password = req.body?.password;
  if (!isPassword(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  if (id === null || !(await setGuestPassword(id, password))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/api/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !(await deleteGuest(id))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
