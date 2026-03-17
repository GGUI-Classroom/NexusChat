const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function syncAchievementFields(userId, fields) {
  try {
    const { ACHIEVEMENTS } = require('./achievements');
    const uuidv4 = require('uuid').v4;
    for (const field of fields) {
      const relevant = ACHIEVEMENTS.filter(a => a.field === field);
      if (!relevant.length) continue;
      let count = 0;
      if (field === 'codes_redeemed' || field === 'decos_owned') {
        const r = await pool.query('SELECT COUNT(*) FROM user_decorations WHERE user_id=$1', [userId]);
        count = parseInt(r.rows[0].count);
      } else if (field === 'decos_equipped') {
        const r = await pool.query('SELECT active_decoration FROM users WHERE id=$1', [userId]);
        count = r.rows[0]?.active_decoration ? 1 : 0;
      }
      for (const a of relevant) {
        const progress = Math.min(count, a.target);
        const completed = count >= a.target;
        const now = Math.floor(Date.now() / 1000);
        await pool.query(`
          INSERT INTO user_achievements (id, user_id, achievement_id, progress, completed_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (user_id, achievement_id) DO UPDATE
            SET progress=GREATEST(user_achievements.progress,$4),
                completed_at=CASE WHEN user_achievements.completed_at IS NULL AND $6 THEN $5 ELSE user_achievements.completed_at END
        `, [uuidv4(), userId, a.id, progress, completed?now:null, completed]);
      }
    }
  } catch(e) { console.error('sync achievement error:', e.message); }
}

// All available decorations — defined here, not in DB
const DECORATIONS = [
  {
    id: 'glow_blue',
    nexalPrice: 500,
    name: 'Blue Glow',
    description: 'A soft pulsing blue aura',
    rarity: 'common',
    preview: 'glow_blue'
  },
  {
    id: 'orbit_white',
    nexalPrice: 1500,
    name: 'Orbit Ring',
    description: 'A sleek white ring orbiting your avatar',
    rarity: 'rare',
    preview: 'orbit_white'
  },
  {
    id: 'halo_gold',
    nexalPrice: 1500,
    name: 'Golden Halo',
    description: 'A golden halo floating above',
    rarity: 'rare',
    preview: 'halo_gold'
  },
  {
    id: 'neon_pink',
    nexalPrice: 3500,
    name: 'Neon Pink',
    description: 'A flickering neon pink border',
    rarity: 'epic',
    preview: 'neon_pink'
  },
  {
    id: 'galaxy',
    nexalPrice: 8000,
    name: 'Galaxy Ring',
    description: 'A rotating galaxy gradient around your avatar',
    rarity: 'legendary',
    preview: 'galaxy'
  },
  {
    id: 'glow_green',
    nexalPrice: 500,
    name: 'Glow Moon',
    description: 'A soft glowing moonlight aura',
    rarity: 'common',
    preview: 'glow_green'
  },
  {
    id: 'orbit_gold',
    nexalPrice: 3500,
    name: 'Gold Orbit',
    description: 'A golden spinning orbit ring',
    rarity: 'epic',
    preview: 'orbit_gold'
  },
  {
    id: 'fire',
    nexalPrice: 8000,
    name: 'Fire Ring',
    description: 'Flames dancing around your avatar',
    rarity: 'legendary',
    preview: 'fire'
  },
  {
    id: 'rainbow',
    nexalPrice: 8000,
    name: 'Rainbow',
    description: 'A rotating rainbow ring',
    rarity: 'legendary',
    preview: 'rainbow'
  },
  {
    id: 'frost',
    nexalPrice: 3500,
    name: 'Frost',
    description: 'An icy frost aura',
    rarity: 'epic',
    preview: 'frost'
  },
  {
    id: 'nexus_admin',
    nexalPrice: null,
    name: 'Nexus Admin',
    description: 'A red power surge that consumes your avatar. For those who run the grid.',
    rarity: 'mythical',
    preview: 'nexus_admin'
  },
  {
    id: 'storm',
    nexalPrice: 10000,
    name: 'Storm',
    description: 'Electric sparks orbit you, then a lightning bolt tears through every 5 seconds.',
    rarity: 'mythical',
    preview: 'storm'
  }
];

// Special nexal boost codes (not decorations)
const NEXAL_CODES = {
  [process.env.NEXAL_CODE_1 || 'ADMIN1231209#7327']: 100000,
};

// Code -> decoration mapping (loaded from env vars)
function getCodeMap() {
  return {
    [process.env.DECO_CODE_NEXUS2026 || 'NEXUS2026']:       'orbit_white',
    [process.env.DECO_CODE_FIRSTYEAR || 'FIRSTYEAR']:       'halo_gold',
    [process.env.DECO_CODE_FIRSTDEP  || 'FIRSTDEP']:        'galaxy',
    [process.env.DECO_CODE_GLOWYMOON || 'GLOWYMOON']:       'glow_green',
    [process.env.DECO_CODE_NEONWAVE  || 'NEONWAVE']:        'neon_pink',
    [process.env.DECO_CODE_FIRESTORM || 'FIRESTORM']:       'fire',
    [process.env.DECO_CODE_RAINBOW   || 'RAINBOW']:         'rainbow',
    [process.env.DECO_CODE_FROSTBITE || 'FROSTBITE']:       'frost',
    [process.env.DECO_CODE_GOLDRING  || 'GOLDRING']:        'orbit_gold',
    [process.env.DECO_CODE_BLUEGLOW      || 'BLUEGLOW']:      'glow_blue',
    [process.env.DECO_CODE_NEXUSADMIN    || 'NEXUSADMIN']:    'nexus_admin',
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
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({
    decorations: DECORATIONS.map(d => ({ ...d, owned: ownedIds.has(d.id) })),
    active: user.rows[0]?.active_decoration || null,
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
});

// Redeem a code
router.post('/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'No code provided' });

  const codeMap = getCodeMap();
  const decorationId = codeMap[code.trim().toUpperCase()];

  // Check if it's a nexal boost code
  if (NEXAL_CODES[code.trim().toUpperCase()] !== undefined) {
    const amount = NEXAL_CODES[code.trim().toUpperCase()];
    await pool.query('UPDATE users SET nexals = nexals + $1 WHERE id=$2', [amount, req.session.userId]);
    const r = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    return res.json({ success: true, nexalBoost: true, amount, nexals: r.rows[0].nexals });
  }

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
  // Track achievements
  await syncAchievementFields(req.session.userId, ['codes_redeemed', 'decos_owned']);
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
  if (decorationId) await syncAchievementFields(req.session.userId, ['decos_equipped']);
  res.json({ success: true, active: decorationId || null });
});

// Buy a decoration with nexals
router.post('/buy', async (req, res) => {
  const { decorationId } = req.body;
  const deco = DECORATIONS.find(d => d.id === decorationId);
  if (!deco) return res.status(404).json({ error: 'Decoration not found' });
  if (!deco.nexalPrice) return res.status(403).json({ error: 'This decoration is code-only and cannot be purchased' });

  // Check not already owned
  const owned = await pool.query('SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2', [req.session.userId, decorationId]);
  if (owned.rows.length) return res.status(409).json({ error: 'You already own this decoration' });

  // Check nexal balance
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  const balance = user.rows[0]?.nexals || 0;
  if (balance < deco.nexalPrice) return res.status(400).json({ error: `Not enough Nexals (need ${deco.nexalPrice.toLocaleString()}, have ${balance.toLocaleString()})` });

  // Deduct and grant
  await pool.query('UPDATE users SET nexals = nexals - $1 WHERE id=$2', [deco.nexalPrice, req.session.userId]);
  await pool.query('INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)', [require('uuid').v4(), req.session.userId, decorationId]);

  const updated = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  await syncAchievementFields(req.session.userId, ['decos_owned', 'decos_equipped']);
  res.json({ success: true, nexals: updated.rows[0].nexals, decoration: { ...deco, owned: true } });
});

// Remove (unclaim) a decoration
router.delete('/unclaim/:decorationId', async (req, res) => {
  const { decorationId } = req.params;
  // If it's equipped, unequip first
  await pool.query(
    'UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2',
    [req.session.userId, decorationId]
  );
  await pool.query(
    'DELETE FROM user_decorations WHERE user_id=$1 AND decoration_id=$2',
    [req.session.userId, decorationId]
  );
  res.json({ success: true });
});

module.exports = router;
