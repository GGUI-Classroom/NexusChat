const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SECRET_CATEGORY = '???SECRET???';
const SECRET_PASSPHRASE = (process.env.SECRET_DECO_PASSPHRASE || 'void').trim().toLowerCase();
const HEHESHUIS_SECRET_ID = 'heheshuis_aura';
const HEHESHUIS_PASSPHRASE = 'lol';
const DECORATION_SELL_PRICES = {
  common: 300,
  rare: 650,
  epic: 1200,
  legendary: 1800,
  mythical: 2500
};

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
  // Pack-exclusive decorations
  { id: 'ember_trace', nexalPrice: null, name: 'Ember Trace', description: 'Warm sparks trace the edge of your avatar.', rarity: 'common', preview: 'ember_trace', packOnly: true },
  { id: 'mint_signal', nexalPrice: null, name: 'Mint Signal', description: 'A clean mint ping pulses from the border.', rarity: 'common', preview: 'mint_signal', packOnly: true },
  { id: 'pixel_pop', nexalPrice: null, name: 'Pixel Pop', description: 'Tiny pixel bits blink in and out around you.', rarity: 'common', preview: 'pixel_pop', packOnly: true },
  { id: 'soft_static', nexalPrice: null, name: 'Soft Static', description: 'A low static shimmer hums around the rim.', rarity: 'common', preview: 'soft_static', packOnly: true },
  { id: 'lime_loop', nexalPrice: null, name: 'Lime Loop', description: 'A bright lime ring loops with playful energy.', rarity: 'common', preview: 'lime_loop', packOnly: true },
  { id: 'neon_grid', nexalPrice: null, name: 'Neon Grid', description: 'Grid lines scan around your avatar like a city map.', rarity: 'rare', preview: 'neon_grid', packOnly: true },
  { id: 'violet_comet', nexalPrice: null, name: 'Violet Comet', description: 'A violet comet tail circles in a sharp arc.', rarity: 'rare', preview: 'violet_comet', packOnly: true },
  { id: 'signal_wave', nexalPrice: null, name: 'Signal Wave', description: 'Blue signal waves ripple from your profile.', rarity: 'rare', preview: 'signal_wave', packOnly: true },
  { id: 'chrome_edge', nexalPrice: null, name: 'Chrome Edge', description: 'A polished chrome outline flashes with cold light.', rarity: 'rare', preview: 'chrome_edge', packOnly: true },
  { id: 'solar_flare', nexalPrice: null, name: 'Solar Flare', description: 'Small solar lashes flare across the border.', rarity: 'rare', preview: 'solar_flare', packOnly: true },
  { id: 'void_pulse', nexalPrice: null, name: 'Void Pulse', description: 'A dark pulse bends light around the avatar.', rarity: 'epic', preview: 'void_pulse', packOnly: true },
  { id: 'plasma_arc', nexalPrice: null, name: 'Plasma Arc', description: 'Hot plasma arcs snap across the rim.', rarity: 'epic', preview: 'plasma_arc', packOnly: true },
  { id: 'crystal_bloom', nexalPrice: null, name: 'Crystal Bloom', description: 'Crystal petals bloom outward in icy color.', rarity: 'epic', preview: 'crystal_bloom', packOnly: true },
  { id: 'toxic_slime', nexalPrice: null, name: 'Toxic Slime', description: 'Glossy green drips crawl around the border.', rarity: 'epic', preview: 'toxic_slime', packOnly: true },
  { id: 'nebula_dust', nexalPrice: null, name: 'Nebula Dust', description: 'Soft star dust swirls in a purple-blue ring.', rarity: 'epic', preview: 'nebula_dust', packOnly: true },
  { id: 'ion_crown', nexalPrice: null, name: 'Ion Crown', description: 'Electric crown points rise from the top edge.', rarity: 'legendary', preview: 'ion_crown', packOnly: true },
  { id: 'ruby_circuit', nexalPrice: null, name: 'Ruby Circuit', description: 'Ruby-red circuitry races around your avatar.', rarity: 'legendary', preview: 'ruby_circuit', packOnly: true },
  { id: 'starforge', nexalPrice: null, name: 'Starforge', description: 'Forged star metal glows in rotating segments.', rarity: 'legendary', preview: 'starforge', packOnly: true },
  { id: 'quantum_ring', nexalPrice: null, name: 'Quantum Ring', description: 'A split ring phases in and out of sync.', rarity: 'legendary', preview: 'quantum_ring', packOnly: true },
  { id: 'midnight_sun', nexalPrice: null, name: 'Midnight Sun', description: 'Black-gold heat radiates from an eclipse rim.', rarity: 'legendary', preview: 'midnight_sun', packOnly: true },
  { id: 'dragon_core', nexalPrice: null, name: 'Dragon Core', description: 'A molten core breathes with sharp scale sparks.', rarity: 'mythical', preview: 'dragon_core', packOnly: true },
  { id: 'cosmic_crown', nexalPrice: null, name: 'Cosmic Crown', description: 'A crown of tiny stars drifts above the profile.', rarity: 'mythical', preview: 'cosmic_crown', packOnly: true },
  { id: 'phantom_blade', nexalPrice: null, name: 'Phantom Blade', description: 'Ghostly blade arcs cut around the avatar.', rarity: 'mythical', preview: 'phantom_blade', packOnly: true },
  { id: 'time_rift', nexalPrice: null, name: 'Time Rift', description: 'Clocklike rifts tick and warp around the edge.', rarity: 'mythical', preview: 'time_rift', packOnly: true },
  { id: 'zero_gravity', nexalPrice: null, name: 'Zero Gravity', description: 'Small orbiting shards float in low gravity.', rarity: 'mythical', preview: 'zero_gravity', packOnly: true },
  { id: 'singularity', nexalPrice: null, name: 'Singularity', description: 'A tiny black-hole ring pulls light inward.', rarity: 'mythical', preview: 'singularity', packOnly: true },
  { id: 'celestial_wings', nexalPrice: null, name: 'Celestial Wings', description: 'Bright wing flares open with golden starlight.', rarity: 'mythical', preview: 'celestial_wings', packOnly: true },
  { id: 'apex_storm', nexalPrice: null, name: 'Apex Storm', description: 'A premium storm ring surges with blue-white strikes.', rarity: 'mythical', preview: 'apex_storm', packOnly: true },
  { id: 'prism_overdrive', nexalPrice: null, name: 'Prism Overdrive', description: 'Prismatic light races around in overdrive.', rarity: 'mythical', preview: 'prism_overdrive', packOnly: true },
  { id: 'eternal_flame', nexalPrice: null, name: 'Eternal Flame', description: 'An everlasting flame crown rolls over the border.', rarity: 'mythical', preview: 'eternal_flame', packOnly: true },
  { id: 'magic_mists', nexalPrice: null, name: 'Magic Mists', description: 'Iridescent violet and cyan mist wraps your avatar in a glossy arcane sphere.', rarity: 'mythical', preview: 'magic_mists', packOnly: true },
  {
    id: 'stormveil',
    nexalPrice: null,
    name: 'The Stormveil',
    description: "It doesn't rain here. It hunts.",
    flavorText: "It doesn't rain here. It hunts.",
    rarity: '??SECRET??',
    preview: 'stormveil',
    category: SECRET_CATEGORY,
    hidden: true
  },
  {
    id: HEHESHUIS_SECRET_ID,
    nexalPrice: null,
    name: 'Heheshuis Aura',
    description: 'A tri-layer neon aura: energy ring, pulse bloom, and chaotic swirl.',
    flavorText: 'The orbit hums in three voices.',
    rarity: '??SECRET??',
    preview: HEHESHUIS_SECRET_ID,
    category: SECRET_CATEGORY,
    hidden: true
  },
];

const DECORATION_PACKS = [
  {
    id: 'starter_pack',
    name: 'Starter Pack',
    price: 500,
    rarity: 'mixed',
    description: 'Open for one starter decoration. Mostly common, with a rare chase.',
    items: [
      { decorationId: 'ember_trace', chance: 40 },
      { decorationId: 'mint_signal', chance: 30 },
      { decorationId: 'pixel_pop', chance: 20 },
      { decorationId: 'soft_static', chance: 8 },
      { decorationId: 'neon_grid', chance: 2 }
    ]
  },
  {
    id: 'neon_pack',
    name: 'Neon Pack',
    price: 1500,
    rarity: 'mixed',
    description: 'Open for one neon decoration. Rare-heavy with an epic spark.',
    items: [
      { decorationId: 'lime_loop', chance: 34 },
      { decorationId: 'violet_comet', chance: 25 },
      { decorationId: 'signal_wave', chance: 20 },
      { decorationId: 'chrome_edge', chance: 14 },
      { decorationId: 'plasma_arc', chance: 7 }
    ]
  },
  {
    id: 'rift_pack',
    name: 'Rift Pack',
    price: 3500,
    rarity: 'mixed',
    description: 'Open for one unstable rift decoration. Epics with a legendary hit.',
    items: [
      { decorationId: 'solar_flare', chance: 35 },
      { decorationId: 'void_pulse', chance: 25 },
      { decorationId: 'crystal_bloom', chance: 18 },
      { decorationId: 'toxic_slime', chance: 14 },
      { decorationId: 'ion_crown', chance: 8 }
    ]
  },
  {
    id: 'forge_pack',
    name: 'Forge Pack',
    price: 8000,
    rarity: 'mixed',
    description: 'Open for one forged decoration. Legendary odds with a mythical ember.',
    items: [
      { decorationId: 'nebula_dust', chance: 36 },
      { decorationId: 'ruby_circuit', chance: 24 },
      { decorationId: 'starforge', chance: 18 },
      { decorationId: 'quantum_ring', chance: 14 },
      { decorationId: 'dragon_core', chance: 8 }
    ]
  },
  {
    id: 'mythic_pack',
    name: 'Mythic Pack',
    price: 12000,
    rarity: 'mixed',
    description: 'Open for one high-power decoration. Mythical pulls are common here.',
    items: [
      { decorationId: 'midnight_sun', chance: 45 },
      { decorationId: 'cosmic_crown', chance: 20 },
      { decorationId: 'phantom_blade', chance: 16 },
      { decorationId: 'time_rift', chance: 12 },
      { decorationId: 'singularity', chance: 7 }
    ]
  },
  {
    id: 'apex_pack',
    name: 'Apex Pack',
    price: 20000,
    rarity: 'mythical',
    description: 'Open for one apex decoration. Premium mythical odds, one item per opening.',
    items: [
      { decorationId: 'zero_gravity', chance: 35 },
      { decorationId: 'celestial_wings', chance: 22 },
      { decorationId: 'apex_storm', chance: 18 },
      { decorationId: 'prism_overdrive', chance: 12 },
      { decorationId: 'eternal_flame', chance: 8 },
      { decorationId: 'magic_mists', chance: 5 }
    ]
  }
];

const SECRET_DECORATION_IDS = new Set(
  DECORATIONS.filter(d => d.hidden && d.category === SECRET_CATEGORY).map(d => d.id)
);

function toClientDecoration(d, quantityOrOwned = 0) {
  const quantity = typeof quantityOrOwned === 'boolean'
    ? (quantityOrOwned ? 1 : 0)
    : Math.max(0, Number(quantityOrOwned) || 0);
  return {
    id: d.id,
    nexalPrice: d.nexalPrice,
    name: d.name,
    description: d.description,
    flavorText: d.flavorText || d.description,
    rarity: d.rarity,
    preview: d.preview,
    category: d.category || null,
    packOnly: !!d.packOnly,
    owned: quantity > 0,
    quantity,
    sellPrice: d.packOnly ? (DECORATION_SELL_PRICES[d.rarity] || 0) : null
  };
}

function toClientPack(pack, ownedQuantities) {
  const totalChance = pack.items.reduce((sum, item) => sum + item.chance, 0);
  const decorations = pack.items
    .map(item => {
      const d = DECORATIONS.find(deco => deco.id === item.decorationId);
      if (!d) return null;
      return {
        ...toClientDecoration(d, ownedQuantities.get(d.id) || 0),
        chance: Math.round((item.chance / totalChance) * 1000) / 10
      };
    })
    .filter(Boolean);
  const ownedCount = decorations.filter(d => d.owned).length;
  const raritySummary = [...new Set(decorations.map(d => d.rarity))].join(' / ');
  return {
    id: pack.id,
    name: pack.name,
    price: pack.price,
    rarity: pack.rarity,
    raritySummary,
    description: pack.description,
    ownedCount,
    totalCount: decorations.length,
    owned: false,
    decorations
  };
}

function getPackDecorationIds(pack) {
  return pack.items
    .map(item => item.decorationId)
    .map(id => DECORATIONS.find(d => d.id === id))
    .filter(Boolean)
    .map(d => d.id);
}

function rollPackItem(pack) {
  const candidates = pack.items
    .map(item => ({
      ...item,
      decoration: DECORATIONS.find(d => d.id === item.decorationId)
    }))
    .filter(item => item.decoration);
  const total = candidates.reduce((sum, item) => sum + item.chance, 0);
  if (!total) return null;

  let roll = Math.random() * total;
  for (const item of candidates) {
    roll -= item.chance;
    if (roll <= 0) return item.decoration;
  }
  return candidates[candidates.length - 1].decoration;
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
    'SELECT decoration_id, COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 GROUP BY decoration_id',
    [req.session.userId]
  );
  const user = await pool.query(
    'SELECT active_decoration FROM users WHERE id=$1',
    [req.session.userId]
  );
  const ownedQuantities = new Map(owned.rows.map(r => [r.decoration_id, r.quantity]));
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({
    decorations: DECORATIONS
      .filter(d => !d.hidden || (d.hidden && ownedQuantities.has(d.id)))
      .map(d => toClientDecoration(d, ownedQuantities.get(d.id) || 0)),
    packs: DECORATION_PACKS.map(pack => toClientPack(pack, ownedQuantities)),
    active: user.rows[0]?.active_decoration || null,
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
});

router.post('/claim-secret', async (req, res) => {
  const secretId = String(req.body.secretId || '').trim();
  const passphrase = String(req.body.passphrase || '').trim().toLowerCase();

  let secretDeco = null;
  const wantsHeheshuis = secretId === HEHESHUIS_SECRET_ID;
  if (secretId) {
    secretDeco = DECORATIONS.find(d => d.id === secretId && SECRET_DECORATION_IDS.has(d.id));
    if (wantsHeheshuis && passphrase !== HEHESHUIS_PASSPHRASE) {
      return res.status(403).json({ error: 'Secret claim denied' });
    }
  } else if (passphrase && passphrase === SECRET_PASSPHRASE) {
    secretDeco = DECORATIONS.find(d => SECRET_DECORATION_IDS.has(d.id));
  }

  if (!secretDeco) {
    return res.status(403).json({ error: 'Secret claim denied' });
  }
  if (passphrase && passphrase !== SECRET_PASSPHRASE && passphrase !== HEHESHUIS_PASSPHRASE) {
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

router.post('/packs/buy', async (req, res) => {
  const { packId } = req.body;
  const pack = DECORATION_PACKS.find(p => p.id === packId);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });

  const rolledDeco = rollPackItem(pack);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    const balance = user.rows[0]?.nexals || 0;
    if (balance < pack.price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough Nexals (need ${pack.price.toLocaleString()}, have ${balance.toLocaleString()})` });
    }
    await client.query('UPDATE users SET nexals = nexals - $1 WHERE id=$2', [pack.price, req.session.userId]);
    await client.query(
      'INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)',
      [uuidv4(), req.session.userId, rolledDeco.id]
    );
    await client.query(`
      INSERT INTO user_pack_stats (user_id, openings) VALUES ($1, 1)
      ON CONFLICT (user_id) DO UPDATE SET openings=user_pack_stats.openings+1
    `, [req.session.userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Pack purchase failed:', err.message);
    return res.status(500).json({ error: 'Pack purchase failed' });
  } finally {
    client.release();
  }

  const updated = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  await syncAchievementFields(req.session.userId, ['decos_owned']);
  res.json({
    success: true,
    nexals: updated.rows[0].nexals,
    granted: [toClientDecoration(rolledDeco, true)]
  });
});

router.post('/sell', async (req, res) => {
  const decorationId = String(req.body.decorationId || '').trim();
  const deco = DECORATIONS.find(d => d.id === decorationId);
  if (!deco || !deco.packOnly) return res.status(400).json({ error: 'Only pack decorations can be sold' });
  const sellPrice = DECORATION_SELL_PRICES[deco.rarity];
  if (!sellPrice) return res.status(400).json({ error: 'This decoration cannot be sold' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query(`
      WITH one_copy AS (
        SELECT id FROM user_decorations
        WHERE user_id=$1 AND decoration_id=$2
        ORDER BY unlocked_at DESC, id DESC
        LIMIT 1
      )
      DELETE FROM user_decorations WHERE id IN (SELECT id FROM one_copy)
      RETURNING id
    `, [req.session.userId, decorationId]);
    if (!removed.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'You do not own this decoration' });
    }
    const remaining = await client.query(
      'SELECT COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 AND decoration_id=$2',
      [req.session.userId, decorationId]
    );
    if (!remaining.rows[0].quantity) {
      await client.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2', [req.session.userId, decorationId]);
    }
    const updated = await client.query(
      'UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals',
      [sellPrice, req.session.userId]
    );
    await client.query('COMMIT');
    res.json({ success: true, nexals: updated.rows[0].nexals, sellPrice, quantity: remaining.rows[0].quantity });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Decoration sale failed:', err.message);
    res.status(500).json({ error: 'Decoration sale failed' });
  } finally {
    client.release();
  }
});

router.get('/stats', async (req, res) => {
  const owned = await pool.query(
    'SELECT decoration_id, COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 GROUP BY decoration_id',
    [req.session.userId]
  );
  const items = owned.rows.map(row => {
    const decoration = DECORATIONS.find(d => d.id === row.decoration_id);
    const sellPrice = decoration?.packOnly ? (DECORATION_SELL_PRICES[decoration.rarity] || 0) : 0;
    return decoration ? { ...toClientDecoration(decoration, row.quantity), totalValue: sellPrice * row.quantity } : null;
  }).filter(Boolean);
  const sellableValue = items.reduce((total, item) => total + item.totalValue, 0);
  const rarityBreakdown = items.reduce((all, item) => {
    all[item.rarity] = (all[item.rarity] || 0) + item.quantity;
    return all;
  }, {});
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({ nexals: user.rows[0]?.nexals || 0, items, sellableValue, rarityBreakdown, uniqueDecorations: items.length, decorationCount: items.reduce((total, item) => total + item.quantity, 0) });
});

router.post('/sell-all', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT decoration_id, COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 GROUP BY decoration_id',
      [req.session.userId]
    );
    let value = 0;
    const sellIds = [];
    for (const row of owned.rows) {
      const decoration = DECORATIONS.find(d => d.id === row.decoration_id);
      if (!decoration?.packOnly) continue;
      value += (DECORATION_SELL_PRICES[decoration.rarity] || 0) * row.quantity;
      sellIds.push(decoration.id);
    }
    if (!sellIds.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No pack decorations to sell' }); }
    await client.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration = ANY($2)', [req.session.userId, sellIds]);
    await client.query('DELETE FROM user_decorations WHERE user_id=$1 AND decoration_id = ANY($2)', [req.session.userId, sellIds]);
    const updated = await client.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [value, req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, soldValue: value, nexals: updated.rows[0].nexals });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not sell your collection' });
  } finally { client.release(); }
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
module.exports.DECORATION_PACKS = DECORATION_PACKS;
