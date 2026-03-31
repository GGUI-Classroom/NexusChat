const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SECRET_CATEGORY = '???SECRET???';
const SECRET_PASSPHRASE = (process.env.SECRET_DECO_PASSPHRASE || 'void').trim().toLowerCase();

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
  },

  // ---- NEW BATCH ----
  // Commons
  { id: 'pulse_teal',   nexalPrice: 500,  name: 'Teal Pulse',     description: 'A soft teal aura that breathes.',                       rarity: 'common',    preview: 'pulse_teal' },
  { id: 'spark_red',    nexalPrice: 500,  name: 'Red Spark',      description: 'Tiny red sparks pop around the rim.',                   rarity: 'common',    preview: 'spark_red' },
  { id: 'haze_purple',  nexalPrice: 500,  name: 'Purple Haze',    description: 'A slow drifting purple mist ring.',                     rarity: 'common',    preview: 'haze_purple' },
  // Rares
  { id: 'aurora',       nexalPrice: 1500, name: 'Aurora',         description: 'A shifting northern-lights gradient ring.',             rarity: 'rare',      preview: 'aurora' },
  { id: 'circuit',      nexalPrice: 1500, name: 'Circuit',        description: 'Glowing circuit lines that trace the avatar border.',   rarity: 'rare',      preview: 'circuit' },
  // Legendaries
  { id: 'diamond',      nexalPrice: 8000, name: 'Diamond',        description: 'A diamond-crystal border with a shine sweep every 5s.', rarity: 'legendary', preview: 'diamond' },
  { id: 'goldshine',    nexalPrice: 8000, name: 'Gold Shine',     description: 'A golden border with a warm gleam sweep every 5s.',     rarity: 'legendary', preview: 'goldshine' },
  // Mythicals
  { id: 'inferno',      nexalPrice: 10000, name: 'Inferno',        description: 'Real animated flames that engulf your avatar.',         rarity: 'mythical',  preview: 'inferno' },
  { id: 'hydro',        nexalPrice: 10000, name: 'Hydro',          description: 'Shimmering water ripples and bubbles orbit your avatar.',rarity: 'mythical',  preview: 'hydro' },
  { id: 'shatter',      nexalPrice: 10000, name: 'Shatter',        description: 'Glass forms over your avatar, glints, then dramatically shatters. Reforms every 5s.', rarity: 'mythical', preview: 'shatter' },
  { id: 'yinyang',      nexalPrice: 10000, name: 'Yin & Yang',     description: 'Balance of light and dark. Every 5s, the symbol manifests.', rarity: 'mythical', preview: 'yinyang' },
  { id: 'aether_mist',  nexalPrice: 10000, name: 'Aether Mist',   description: 'Iridescent mist swirls with astral sparks in a premium aura.', rarity: 'mythical', preview: 'aether_mist' },
  { id: 'magma',        nexalPrice: 10000, name: 'Magma',         description: 'Molten lava drips from above your profile in a fiery flow.', rarity: 'mythical', preview: 'magma' },
  {
    id: 'eclipsed_lantern',
    nexalPrice: null,
    name: 'The Eclipsed Lantern',
    description: 'Forged at the boundary between what is seen and what is forgotten.',
    flavorText: 'Forged at the boundary between what is seen and what is forgotten.',
    rarity: '??SECRET??',
    preview: 'eclipsed_lantern',
    category: SECRET_CATEGORY,
    hidden: true
  },
];

const SECRET_DECORATION_IDS = new Set(
  DECORATIONS.filter(d => d.hidden && d.category === SECRET_CATEGORY).map(d => d.id)
);

function toClientDecoration(d, owned) {
  return {
    id: d.id,
    nexalPrice: d.nexalPrice,
    name: d.name,
    description: d.description,
    flavorText: d.flavorText || d.description,
    rarity: d.rarity,
    preview: d.preview,
    category: d.category || null,
    owned: !!owned
  };
}

// Special nexal boost codes (not decorations)
// Set amount to negative to mark as infinite-use
const NEXAL_CODES = {
  [process.env.NEXAL_CODE_1 || 'ADMIN1231209#7327']: { amount: 100000, infinite: true },
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
    [process.env.DECO_CODE_INFERNO       || 'INFERNO']:       'inferno',
    [process.env.DECO_CODE_HYDRO         || 'HYDRO']:         'hydro',
    [process.env.DECO_CODE_SHATTER       || 'SHATTER']:       'shatter',
    [process.env.DECO_CODE_YINYANG       || 'YINYANG']:       'yinyang',
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
    decorations: DECORATIONS
      .filter(d => !d.hidden)
      .map(d => toClientDecoration(d, ownedIds.has(d.id))),
    active: user.rows[0]?.active_decoration || null,
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
});

router.post('/claim-secret', async (req, res) => {
  const secretId = String(req.body.secretId || '').trim();
  const passphrase = String(req.body.passphrase || '').trim().toLowerCase();

  let secretDeco = null;
  if (secretId) {
    secretDeco = DECORATIONS.find(d => d.id === secretId && SECRET_DECORATION_IDS.has(d.id));
  } else if (passphrase && passphrase === SECRET_PASSPHRASE) {
    secretDeco = DECORATIONS.find(d => SECRET_DECORATION_IDS.has(d.id));
  }

  if (!secretDeco) {
    return res.status(403).json({ error: 'Secret claim denied' });
  }
  if (passphrase && passphrase !== SECRET_PASSPHRASE) {
    return res.status(403).json({ error: 'Secret claim denied' });
  }

  const already = await pool.query(
    'SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2',
    [req.session.userId, secretDeco.id]
  );

  if (!already.rows.length) {
    await pool.query(
      'INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)',
      [uuidv4(), req.session.userId, secretDeco.id]
    );
    await syncAchievementFields(req.session.userId, ['decos_owned']);
  }

  await pool.query(
    'UPDATE users SET active_decoration=$1 WHERE id=$2',
    [secretDeco.id, req.session.userId]
  );
  await syncAchievementFields(req.session.userId, ['decos_equipped']);

  res.json({
    success: true,
    alreadyOwned: already.rows.length > 0,
    decoration: toClientDecoration(secretDeco, true),
    active: secretDeco.id
  });
});

// Redeem a code
router.post('/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'No code provided' });

  const codeMap = getCodeMap();
  const decorationId = codeMap[code.trim().toUpperCase()];

  // Check if it's a nexal boost code
  const cleanCode = code.trim().toUpperCase();
  const nexalEntry = NEXAL_CODES[cleanCode] || NEXAL_CODES[code.trim()]; // try both upper and raw
  if (nexalEntry) {
    if (!nexalEntry.infinite) {
      // Check if already redeemed
      const already = await pool.query(
        'SELECT id FROM code_redemptions WHERE user_id=$1 AND code=$2',
        [req.session.userId, cleanCode]
      );
      if (already.rows.length) return res.status(409).json({ error: 'You have already redeemed this code' });
      // Record redemption
      await pool.query(
        'INSERT INTO code_redemptions (id, user_id, code) VALUES ($1,$2,$3)',
        [require('uuid').v4(), req.session.userId, cleanCode]
      );
    }
    await pool.query('UPDATE users SET nexals = nexals + $1 WHERE id=$2', [nexalEntry.amount, req.session.userId]);
    const r = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    return res.json({ success: true, nexalBoost: true, amount: nexalEntry.amount, nexals: r.rows[0].nexals });
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
  res.json({ success: true, decoration: toClientDecoration(deco, true) });
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
  if (deco.hidden) return res.status(403).json({ error: 'This decoration cannot be purchased' });
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
  res.json({ success: true, nexals: updated.rows[0].nexals, decoration: toClientDecoration(deco, true) });
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
module.exports.DECORATIONS = DECORATIONS;
