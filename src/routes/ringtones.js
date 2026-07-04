const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const RINGTONES = [
  {
    id: 'neon_surge',
    name: 'Arcade',
    price: 5000,
    description: 'Bright arcade-style sweeps with a crisp lead tone.'
  },
  {
    id: 'cyber_echo',
    name: 'Double Tap',
    price: 5000,
    description: 'Layered digital beeps with a bounce-back echo feel.'
  },
  {
    id: 'starlight_ping',
    name: 'Glass Bell',
    price: 5000,
    description: 'Shimmering high notes with a clean modern pulse.'
  },
  {
    id: 'thunder_hop',
    name: 'Bass Step',
    price: 5000,
    description: 'Punchy bass hit followed by energetic stepping tones.'
  },
  {
    id: 'velvet_alarm',
    name: 'Soft Bell',
    price: 5000,
    description: 'Smooth warm synth chime that still cuts through noise.'
  },
  {
    id: 'quantum_drift',
    name: 'Quick Rise',
    price: 5000,
    description: 'Crazy stuff'
  },
  {
    id: 'nova_breaker',
    name: 'Red Alert',
    price: 5000,
    description: 'Explosive bass bloom with stuttering starship alert bursts.'
  }
];

router.get('/', async (req, res) => {
  const [owned, user] = await Promise.all([
    pool.query('SELECT ringtone_id FROM user_ringtones WHERE user_id=$1', [req.session.userId]),
    pool.query('SELECT active_ringtone, nexals FROM users WHERE id=$1', [req.session.userId])
  ]);

  const ownedSet = new Set(owned.rows.map(r => r.ringtone_id));
  res.json({
    ringtones: RINGTONES.map(r => ({ ...r, owned: ownedSet.has(r.id) })),
    active: user.rows[0]?.active_ringtone || null,
    nexals: user.rows[0]?.nexals || 0
  });
});

router.post('/buy', async (req, res) => {
  const { ringtoneId } = req.body;
  const ringtone = RINGTONES.find(r => r.id === ringtoneId);
  if (!ringtone) return res.status(404).json({ error: 'Ringtone not found' });

  const owned = await pool.query('SELECT id FROM user_ringtones WHERE user_id=$1 AND ringtone_id=$2', [req.session.userId, ringtoneId]);
  if (owned.rows.length) return res.status(409).json({ error: 'Already owned' });

  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  const balance = user.rows[0]?.nexals || 0;
  if (balance < ringtone.price) {
    return res.status(400).json({ error: `Not enough Nexals (need ${ringtone.price.toLocaleString()}, have ${balance.toLocaleString()})` });
  }

  await pool.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [ringtone.price, req.session.userId]);
  await pool.query('INSERT INTO user_ringtones (id,user_id,ringtone_id) VALUES ($1,$2,$3)', [uuidv4(), req.session.userId, ringtoneId]);

  const updated = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({ success: true, nexals: updated.rows[0].nexals, ringtone: { ...ringtone, owned: true } });
});

router.post('/equip', async (req, res) => {
  const { ringtoneId } = req.body;

  if (ringtoneId) {
    const exists = RINGTONES.some(r => r.id === ringtoneId);
    if (!exists) return res.status(404).json({ error: 'Ringtone not found' });

    const owned = await pool.query('SELECT id FROM user_ringtones WHERE user_id=$1 AND ringtone_id=$2', [req.session.userId, ringtoneId]);
    if (!owned.rows.length) return res.status(403).json({ error: 'Not owned' });
  }

  await pool.query('UPDATE users SET active_ringtone=$1 WHERE id=$2', [ringtoneId || null, req.session.userId]);
  res.json({ success: true, active: ringtoneId || null });
});

module.exports = router;
module.exports.RINGTONES = RINGTONES;
