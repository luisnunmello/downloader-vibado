import { Router } from 'express';
import { identityFromRequest } from '../session.js';
import { render } from '../views.js';

const router = Router();

// Both pages share one template; the master also gets guest management.
router.get('/admin', async (req, res) => {
  const identity = await identityFromRequest(req);
  if (!identity) return res.redirect('/login');
  if (identity.role !== 'master') return res.redirect('/guest');
  res.send(render('panel', 'Admin', { heading: 'Admin', admin: '1' }, 'wide'));
});

router.get('/guest', async (req, res) => {
  const identity = await identityFromRequest(req);
  if (!identity) return res.redirect('/login');
  if (identity.role !== 'guest') return res.redirect('/admin');
  res.send(render('panel', 'Guest', { heading: `Guest: ${identity.name}` }, 'wide'));
});

export default router;
