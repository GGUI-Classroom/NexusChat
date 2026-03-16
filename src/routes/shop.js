const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// All available decorations — defined here, not in DB
const DECORATIONS = [
  {
    id: 'glow_blue',
    name: 'Blue Glow',
    description: 'A soft pulsing blue aura',
    rarity: 'common',
    preview: 'glow_blue'
  },
  {
    id: 'orbit_white',
    name: 'Orbit Ring',
    description: 'A sleek white ring orbiting your avatar',
    rarity: 'rare',
    preview: 'orbit_white'
  },
  {
    id: 'halo_gold',
    name: 'Golden Halo',
    description: 'A golden halo floating above',
    rarity: 'rare',
    preview: 'halo_gold'
  },
  {
    id: 'neon_pink',
    name: 'Neon Pink',
    description: 'A flickering neon pink border',
    rarity: 'epic',
    preview: 'neon_pink'
  },
  {
    id: 'galaxy',
    name: 'Galaxy Ring',
    description: 'A rotating galaxy gradient around your avatar',
    rarity: 'legendary',
    preview: 'galaxy'
  },
  {
    id: 'glow_green',
    name: 'Glow Moon',
    description: 'A soft glowing moonlight aura',
    rarity: 'common',
    preview: 'glow_green'
  },
  {
    id: 'orbit_gold',
    name: 'Gold Orbit',
    description: 'A golden spinning orbit ring',
    rarity: 'epic',
    preview: 'orbit_gold'
  },
  {
    id: 'fire',
    name: 'Fire Ring',
    description: 'Flames dancing around your avatar',
    rarity: 'legendary',
    preview: 'fire'
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    description: 'A rotating rainbow ring',
    rarity: 'legendary',
    preview: 'rainbow'
  },
  {
    id: 'frost',
    name: 'Frost',
    description: 'An icy frost aura',
    rarity: 'epic',
    preview: 'frost'
  },
  {
    id: 'nexus_admin',
    name: 'Nexus Admin',
    description: 'A red power surge that consumes your avatar. For those who run the grid.',
    rarity: 'legendary',
    preview: 'nexus_admin'
  },
  {
    id: 'storm',
    name: 'Storm',
    description: 'Electric sparks orbit you, then a lightning bolt tears through every 5 seconds.',
    rarity: 'legendary',
    preview: 'storm'
  }
];

// Code -> decoration mapping (loaded from env vars)
function getCodeMap() {
  return {
    [process.env.DECO_CODE_NEXUS2026 || 'NEXUS2026']:       'orbit_white',
    [process.env.DECO_CODE_FIRSTDEP  || 'FIRSTDEP']:        'galaxy',
    [process.env.DECO_CODE_GLOWYMOON || 'GLOWYMOON']:       'glow_green',
    [process.env.DECO_CODE_NEONWAVE  || 'NEONWAVE']:        'neon_pink',
    [process.env.DECO_CODE_FIRESTORM || 'FIRESTORM']:       'fire',
    [process.env.DECO_CODE_RAINBOW   || 'RAINBOW']:         'rainbow',
    [process.env.DECO_CODE_FROSTBITE || 'FROSTBITE']:       'frost',
    [process.env.DECO_CODE_GOLDRING  || 'GOLDRING']:        'orbit_gold',
    [process.env.DECO_CODE_BLUEGLOW      || 'BLUEGLOW']:      'glow_blue',
    [process.env.DECO_CODE_NEXUSADMIN    || 'NEXUSETRALX']:    'nexus_admin',
    [process.env.DECO_CODE_STORMBRINGER  || 'STORMBRINGER']:  'storm',
  };
}

// Get all decorations + which ones the user owns
router.get('/', async (req, res) => {
  const owned = await pool.query(
    'SELECT decoration_id FROM user_decorations WHERE user_id=$1',
    [req.session.userId]
  );
  const user = await pool.query(
    'SELECT active_decoration FROM users WHERE id=$1',
    [req.session.userId]
  );
  const ownedIds = new Set(owned.rows.map(r => r.decoration_id));
  res.json({
    decorations: DECORATIONS.map(d => ({ ...d, owned: ownedIds.has(d.id) })),
    active: user.rows[0]?.active_decoration || null
  });
});

// Redeem a code
router.post('/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'No code provided' });

  const codeMap = getCodeMap();
  const decorationId = codeMap[code.trim().toUpperCase()];

  if (!decorationId) return res.status(404).json({ error: 'Invalid code' });

  const deco = DECORATIONS.find(d => d.id === decorationId);
  if (!deco) return res.status(404).json({ error: 'Decoration not found' });

  // Check already owned
  const already = await pool.query(
    'SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2',
    [req.session.userId, decorationId]
  );
  if (already.rows.length) return res.status(409).json({ error: 'You already own this decoration!' });

  await pool.query(
    'INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)',
    [uuidv4(), req.session.userId, decorationId]
  );
  res.json({ success: true, decoration: { ...deco, owned: true } });
});

// Equip / unequip a decoration
router.post('/equip', async (req, res) => {
  const { decorationId } = req.body;

  if (decorationId) {
    // Verify ownership
    const owned = await pool.query(
      'SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2',
      [req.session.userId, decorationId]
    );
    if (!owned.rows.length) return res.status(403).json({ error: 'You do not own this decoration' });
  }

  await pool.query(
    'UPDATE users SET active_decoration=$1 WHERE id=$2',
    [decorationId || null, req.session.userId]
  );
  res.json({ success: true, active: decorationId || null });
});

module.exports = router;
