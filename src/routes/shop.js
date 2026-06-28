const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SECRET_CATEGORY = '???SECRET???';
const HEHESHUIS_SECRET_ID = 'heheshuis_aura';
const DECORATION_SELL_PRICES = {
  common: 300,
  rare: 650,
  epic: 1200,
  legendary: 1800,
  mythical: 2500,
  ascendent: 6000
};
const NAMEPLATE_SELL_PRICES = {
  common: 250,
  rare: 550,
  epic: 1000,
  legendary: 1600,
  mythical: 2300,
  ascendent: 5500
};

async function syncAchievementFields(userId, fields) {
  try {
    const { ACHIEVEMENTS } = require('./achievements');
    const uuidv4 = require('uuid').v4;
    for (const field of fields) {
      const relevant = ACHIEVEMENTS.filter(a => a.field === field);
      if (!relevant.length) continue;
      let count = 0;
      if (field === 'decos_owned') {
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
  { id: 'singularity', nexalPrice: null, name: 'Singularity', description: 'A tiny black-hole ring pulls light inward.', rarity: 'ascendent', preview: 'singularity', packOnly: true },
  { id: 'celestial_wings', nexalPrice: null, name: 'Celestial Wings', description: 'Bright wing flares open with golden starlight.', rarity: 'mythical', preview: 'celestial_wings', packOnly: true },
  { id: 'apex_storm', nexalPrice: null, name: 'Apex Storm', description: 'A premium storm ring surges with blue-white strikes.', rarity: 'ascendent', preview: 'apex_storm', packOnly: true },
  { id: 'prism_overdrive', nexalPrice: null, name: 'Prism Overdrive', description: 'Prismatic light races around in overdrive.', rarity: 'mythical', preview: 'prism_overdrive', packOnly: true },
  { id: 'eternal_flame', nexalPrice: null, name: 'Eternal Flame', description: 'An everlasting flame crown rolls over the border.', rarity: 'mythical', preview: 'eternal_flame', packOnly: true },
  { id: 'magic_mists', nexalPrice: null, name: 'Magic Mists', description: 'Iridescent violet and cyan mist wraps your avatar in a glossy arcane sphere.', rarity: 'mythical', preview: 'magic_mists', packOnly: true },
  { id: 'event_horizon', nexalPrice: null, name: 'Astral Dominion', description: 'An Ascendent star-crown lattice with aurora ribbons, orbiting jewel glyphs, and a brief constellation bloom.', rarity: 'ascendent', preview: 'event_horizon', packOnly: true },
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

const NAMEPLATES = [
  { id: 'signal_strip', name: 'Signal Strip', description: 'A crisp graphite plate with a live mint signal.', rarity: 'common', style: 'signal' },
  { id: 'ember_line', name: 'Ember Line', description: 'Warm copper rails glow behind your name.', rarity: 'common', style: 'ember' },
  { id: 'polar_label', name: 'Polar Label', description: 'A cool glass label with a clean ice edge.', rarity: 'common', style: 'polar' },
  { id: 'neon_lane', name: 'Neon Lane', description: 'Electric cyan traffic sweeps across a midnight plate.', rarity: 'rare', style: 'neon' },
  { id: 'violet_drive', name: 'Violet Drive', description: 'Violet light races through a split chrome frame.', rarity: 'rare', style: 'violet' },
  { id: 'coral_frequency', name: 'Coral Frequency', description: 'A coral waveform travels behind your display name.', rarity: 'rare', style: 'coral' },
  { id: 'plasma_frame', name: 'Plasma Frame', description: 'A charged plasma pane flashes at its corners.', rarity: 'epic', style: 'plasma' },
  { id: 'toxic_matrix', name: 'Toxic Matrix', description: 'Lime matrix cells pulse beneath smoked glass.', rarity: 'epic', style: 'matrix' },
  { id: 'crystal_wave', name: 'Crystal Wave', description: 'Faceted crystal light refracts through the plate.', rarity: 'epic', style: 'crystal' },
  { id: 'starforge_plate', name: 'Starforge Crest', description: 'Forged gold segments orbit a deep stellar core.', rarity: 'legendary', style: 'starforge' },
  { id: 'solar_regalia', name: 'Solar Regalia', description: 'A royal solar flare crowns your name.', rarity: 'legendary', style: 'solar' },
  { id: 'quantum_banner', name: 'Quantum Banner', description: 'Two phased realities flicker across one banner.', rarity: 'legendary', style: 'quantum' },
  { id: 'dragon_script', name: 'Dragon Script', description: 'Molten scale patterns curl around a volcanic nameplate.', rarity: 'mythical', style: 'dragon' },
  { id: 'mistbound_title', name: 'Mistbound Title', description: 'Arcane cyan and violet vapor rolls through glass.', rarity: 'mythical', style: 'mist' },
  { id: 'chronolock', name: 'Chronolock', description: 'Clockwork marks rewind around a midnight title.', rarity: 'mythical', style: 'chrono' },
  { id: 'singularity_plate', name: 'Singularity Crown', description: 'Bent starlight collapses toward your name.', rarity: 'ascendent', style: 'singularity' },
  { id: 'astral_dominion_plate', name: 'Astral Dominion', description: 'Constellation jewels command an aurora field.', rarity: 'ascendent', style: 'dominion' },
  { id: 'apex_tempest_plate', name: 'Apex Tempest', description: 'A contained superstorm crackles through dark glass.', rarity: 'ascendent', style: 'tempest' }
];

const DECORATION_PACKS = [
  {
    id: 'starter_pack',
    name: 'Starter Pack',
    price: 500,
    rarity: 'mixed',
    description: 'Open for one starter collectible. Mostly common, with a rare chase.',
    items: [
      { decorationId: 'ember_trace', chance: 40 },
      { decorationId: 'mint_signal', chance: 30 },
      { decorationId: 'pixel_pop', chance: 20 },
      { decorationId: 'soft_static', chance: 8 },
      { decorationId: 'neon_grid', chance: 2 },
      { nameplateId: 'signal_strip', chance: 8 },
      { nameplateId: 'ember_line', chance: 6 },
      { nameplateId: 'polar_label', chance: 4 }
    ]
  },
  {
    id: 'neon_pack',
    name: 'Neon Pack',
    price: 1500,
    rarity: 'mixed',
    description: 'Open for one neon collectible. Rare-heavy with an epic spark.',
    items: [
      { decorationId: 'lime_loop', chance: 34 },
      { decorationId: 'violet_comet', chance: 25 },
      { decorationId: 'signal_wave', chance: 20 },
      { decorationId: 'chrome_edge', chance: 14 },
      { decorationId: 'plasma_arc', chance: 7 },
      { nameplateId: 'neon_lane', chance: 7 },
      { nameplateId: 'violet_drive', chance: 5 },
      { nameplateId: 'coral_frequency', chance: 3 }
    ]
  },
  {
    id: 'rift_pack',
    name: 'Rift Pack',
    price: 3500,
    rarity: 'mixed',
    description: 'Open for one unstable rift collectible. Epics with a legendary hit.',
    items: [
      { decorationId: 'solar_flare', chance: 35 },
      { decorationId: 'void_pulse', chance: 25 },
      { decorationId: 'crystal_bloom', chance: 18 },
      { decorationId: 'toxic_slime', chance: 14 },
      { decorationId: 'ion_crown', chance: 8 },
      { nameplateId: 'plasma_frame', chance: 6 },
      { nameplateId: 'toxic_matrix', chance: 4 },
      { nameplateId: 'crystal_wave', chance: 2 }
    ]
  },
  {
    id: 'forge_pack',
    name: 'Forge Pack',
    price: 8000,
    rarity: 'mixed',
    description: 'Open for one forged collectible. Legendary odds with a mythical ember.',
    items: [
      { decorationId: 'nebula_dust', chance: 36 },
      { decorationId: 'ruby_circuit', chance: 24 },
      { decorationId: 'starforge', chance: 18 },
      { decorationId: 'quantum_ring', chance: 14 },
      { decorationId: 'dragon_core', chance: 8 },
      { nameplateId: 'starforge_plate', chance: 5 },
      { nameplateId: 'solar_regalia', chance: 3 },
      { nameplateId: 'quantum_banner', chance: 1.5 }
    ]
  },
  {
    id: 'mythic_pack',
    name: 'Mythic Pack',
    price: 12000,
    rarity: 'mixed',
    description: 'Open for one high-power collectible. Mythical pulls are common here.',
    items: [
      { decorationId: 'midnight_sun', chance: 45 },
      { decorationId: 'cosmic_crown', chance: 20 },
      { decorationId: 'phantom_blade', chance: 16 },
      { decorationId: 'time_rift', chance: 12 },
      { decorationId: 'eternal_flame', chance: 7 },
      { nameplateId: 'dragon_script', chance: 3.5 },
      { nameplateId: 'mistbound_title', chance: 2 },
      { nameplateId: 'chronolock', chance: 0.75 }
    ]
  },
  {
    id: 'apex_pack',
    name: 'Apex Pack',
    price: 20000,
    rarity: 'ascendent',
    description: 'Open for one apex collectible. Premium mythical odds with a nearly impossible Ascendent hit.',
    items: [
      { decorationId: 'zero_gravity', chance: 52.05 },
      { decorationId: 'celestial_wings', chance: 22 },
      { decorationId: 'prism_overdrive', chance: 12 },
      { decorationId: 'eternal_flame', chance: 8 },
      { decorationId: 'magic_mists', chance: 5 },
      { decorationId: 'apex_storm', chance: 0.5 },
      { decorationId: 'event_horizon', chance: 0.25 },
      { decorationId: 'singularity', chance: 0.2 },
      { nameplateId: 'singularity_plate', chance: 0.18 },
      { nameplateId: 'astral_dominion_plate', chance: 0.12 },
      { nameplateId: 'apex_tempest_plate', chance: 0.08 }
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

function toClientNameplate(nameplate, quantityOrOwned = 0) {
  const quantity = Math.max(0, Number(quantityOrOwned) || 0);
  return {
    id: nameplate.id,
    collectibleType: 'nameplate',
    name: nameplate.name,
    description: nameplate.description,
    rarity: nameplate.rarity,
    style: nameplate.style,
    packOnly: true,
    owned: quantity > 0,
    quantity,
    sellPrice: NAMEPLATE_SELL_PRICES[nameplate.rarity] || 0
  };
}

function giftPayload(row) {
  const decoration = row.decoration_id ? DECORATIONS.find(d => d.id === row.decoration_id) : null;
  return {
    id: row.id,
    type: row.gift_type,
    amount: row.nexal_amount || null,
    decoration: decoration ? toClientDecoration(decoration, 1) : null,
    fromUser: {
      id: row.from_user_id,
      username: row.from_username,
      displayName: row.from_display_name
    },
    createdAt: parseInt(row.created_at, 10)
  };
}

async function getGiftForClient(clientOrPool, giftId) {
  const r = await clientOrPool.query(
    `SELECT g.*, u.username AS from_username, u.display_name AS from_display_name
     FROM user_gifts g
     JOIN users u ON u.id=g.from_user_id
     WHERE g.id=$1`,
    [giftId]
  );
  return r.rows[0] ? giftPayload(r.rows[0]) : null;
}

function toClientPack(pack, ownedQuantities, ownedNameplates) {
  const totalChance = pack.items.reduce((sum, item) => sum + item.chance, 0);
  const collectibles = pack.items
    .map(item => {
      const decoration = item.decorationId && DECORATIONS.find(deco => deco.id === item.decorationId);
      const nameplate = item.nameplateId && NAMEPLATES.find(plate => plate.id === item.nameplateId);
      if (!decoration && !nameplate) return null;
      return {
        ...(decoration
          ? { ...toClientDecoration(decoration, ownedQuantities.get(decoration.id) || 0), collectibleType: 'decoration' }
          : toClientNameplate(nameplate, ownedNameplates.get(nameplate.id) || 0)),
        chance: Math.round((item.chance / totalChance) * 10000) / 100
      };
    })
    .filter(Boolean);
  const ownedCount = collectibles.filter(item => item.owned).length;
  const raritySummary = [...new Set(collectibles.map(item => item.rarity))].join(' / ');
  return {
    id: pack.id,
    name: pack.name,
    price: pack.price,
    rarity: pack.rarity,
    raritySummary,
    description: pack.description,
    ownedCount,
    totalCount: collectibles.length,
    owned: false,
    decorations: collectibles.filter(item => item.collectibleType === 'decoration'),
    nameplates: collectibles.filter(item => item.collectibleType === 'nameplate'),
    collectibles
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
      collectible: item.decorationId
        ? DECORATIONS.find(d => d.id === item.decorationId)
        : NAMEPLATES.find(nameplate => nameplate.id === item.nameplateId),
      collectibleType: item.decorationId ? 'decoration' : 'nameplate'
    }))
    .filter(item => item.collectible);
  const total = candidates.reduce((sum, item) => sum + item.chance, 0);
  if (!total) return null;

  let roll = Math.random() * total;
  for (const item of candidates) {
    roll -= item.chance;
    if (roll <= 0) return { collectibleType: item.collectibleType, item: item.collectible };
  }
  const fallback = candidates[candidates.length - 1];
  return { collectibleType: fallback.collectibleType, item: fallback.collectible };
}

// Get all decorations + which ones the user owns
router.get('/', async (req, res) => {
  const [owned, ownedPlates, user] = await Promise.all([
    pool.query(
      'SELECT decoration_id, COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 GROUP BY decoration_id',
      [req.session.userId]
    ),
    pool.query(
      'SELECT nameplate_id, COUNT(*)::int AS quantity FROM user_nameplates WHERE user_id=$1 GROUP BY nameplate_id',
      [req.session.userId]
    ),
    pool.query(
      'SELECT active_decoration, active_nameplate FROM users WHERE id=$1',
      [req.session.userId]
    )
  ]);
  const ownedQuantities = new Map(owned.rows.map(r => [r.decoration_id, r.quantity]));
  const ownedNameplates = new Map(ownedPlates.rows.map(r => [r.nameplate_id, r.quantity]));
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({
    decorations: DECORATIONS
      .filter(d => !d.hidden || (d.hidden && ownedQuantities.has(d.id)))
      .map(d => toClientDecoration(d, ownedQuantities.get(d.id) || 0)),
    nameplates: NAMEPLATES.map(nameplate => toClientNameplate(nameplate, ownedNameplates.get(nameplate.id) || 0)),
    packs: DECORATION_PACKS.map(pack => toClientPack(pack, ownedQuantities, ownedNameplates)),
    active: user.rows[0]?.active_decoration || null,
    activeNameplate: user.rows[0]?.active_nameplate || null,
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
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

router.post('/nameplates/equip', async (req, res) => {
  const nameplateId = String(req.body.nameplateId || '').trim() || null;
  if (nameplateId) {
    if (!NAMEPLATES.some(nameplate => nameplate.id === nameplateId)) {
      return res.status(404).json({ error: 'Nameplate not found' });
    }
    const owned = await pool.query(
      'SELECT id FROM user_nameplates WHERE user_id=$1 AND nameplate_id=$2 LIMIT 1',
      [req.session.userId, nameplateId]
    );
    if (!owned.rows.length) return res.status(403).json({ error: 'You do not own this nameplate' });
  }
  await pool.query('UPDATE users SET active_nameplate=$1 WHERE id=$2', [nameplateId, req.session.userId]);
  res.json({ success: true, activeNameplate: nameplateId });
});

router.post('/gift/nexals', async (req, res) => {
  const toUserId = String(req.body.toUserId || '').trim();
  const amount = Math.floor(parseInt(req.body.amount, 10) || 0);
  if (!toUserId || toUserId === req.session.userId) return res.status(400).json({ error: 'Choose a valid recipient' });
  if (amount < 1 || amount > 1000000) return res.status(400).json({ error: 'Enter a gift amount from 1 to 1,000,000 Nexals' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const friendship = await client.query(
      `SELECT id FROM friendships
       WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)
       LIMIT 1`,
      [req.session.userId, toUserId]
    );
    if (!friendship.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only gift Nexals to friends' });
    }
    const sender = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    const recipient = await client.query('SELECT id, username, display_name FROM users WHERE id=$1 FOR UPDATE', [toUserId]);
    if (!recipient.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }
    if ((sender.rows[0]?.nexals || 0) < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough Nexals for that gift' });
    }
    const updatedSender = await client.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2 RETURNING nexals', [amount, req.session.userId]);
    const giftId = uuidv4();
    await client.query(
      `INSERT INTO user_gifts (id, from_user_id, to_user_id, gift_type, nexal_amount)
       VALUES ($1,$2,$3,'nexals',$4)`,
      [giftId, req.session.userId, toUserId, amount]
    );
    const gift = await getGiftForClient(client, giftId);
    await client.query('COMMIT');
    if (req.io) {
      req.io.to(`user:${req.session.userId}`).emit('nexals_updated', { nexals: updatedSender.rows[0].nexals });
      req.io.to(`user:${toUserId}`).emit('gift_received', gift);
    }
    res.json({ success: true, nexals: updatedSender.rows[0].nexals, gift, recipient: { id: toUserId, username: recipient.rows[0].username, displayName: recipient.rows[0].display_name } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Nexal gift failed:', error.message);
    res.status(500).json({ error: 'Could not send Nexal gift' });
  } finally {
    client.release();
  }
});

router.post('/gift/decoration', async (req, res) => {
  const toUserId = String(req.body.toUserId || '').trim();
  const decorationId = String(req.body.decorationId || '').trim();
  if (!toUserId || toUserId === req.session.userId) return res.status(400).json({ error: 'Choose a valid recipient' });
  const deco = DECORATIONS.find(d => d.id === decorationId);
  if (!deco) return res.status(404).json({ error: 'Decoration not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const friendship = await client.query(
      `SELECT id FROM friendships
       WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)
       LIMIT 1`,
      [req.session.userId, toUserId]
    );
    if (!friendship.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only gift decorations to friends' });
    }
    const recipient = await client.query('SELECT id, username, display_name FROM users WHERE id=$1', [toUserId]);
    if (!recipient.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }
    const copy = await client.query(
      `SELECT ud.id
       FROM user_decorations ud
       LEFT JOIN decoration_auctions da ON da.decoration_row_id=ud.id AND da.status='active'
       WHERE ud.user_id=$1 AND ud.decoration_id=$2 AND da.id IS NULL
       ORDER BY ud.unlocked_at DESC, ud.id DESC
       LIMIT 1
       FOR UPDATE OF ud`,
      [req.session.userId, decorationId]
    );
    if (!copy.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'You do not have an available copy to gift' });
    }
    await client.query('UPDATE user_decorations SET user_id=$1 WHERE id=$2', [toUserId, copy.rows[0].id]);
    const remaining = await client.query('SELECT 1 FROM user_decorations WHERE user_id=$1 AND decoration_id=$2 LIMIT 1', [req.session.userId, decorationId]);
    if (!remaining.rows.length) {
      await client.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2', [req.session.userId, decorationId]);
    }
    const giftId = uuidv4();
    await client.query(
      `INSERT INTO user_gifts (id, from_user_id, to_user_id, gift_type, decoration_id, decoration_row_id)
       VALUES ($1,$2,$3,'decoration',$4,$5)`,
      [giftId, req.session.userId, toUserId, decorationId, copy.rows[0].id]
    );
    const gift = await getGiftForClient(client, giftId);
    await client.query('COMMIT');
    if (req.io) {
      req.io.to(`user:${toUserId}`).emit('gift_received', gift);
    }
    await syncAchievementFields(toUserId, ['decos_owned']);
    res.json({ success: true, gift, decoration: toClientDecoration(deco, 1), recipient: { id: toUserId, username: recipient.rows[0].username, displayName: recipient.rows[0].display_name } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Decoration gift failed:', error.message);
    res.status(500).json({ error: 'Could not send decoration gift' });
  } finally {
    client.release();
  }
});

router.get('/gifts', async (req, res) => {
  const r = await pool.query(
    `SELECT g.*, u.username AS from_username, u.display_name AS from_display_name
     FROM user_gifts g
     JOIN users u ON u.id=g.from_user_id
     WHERE g.to_user_id=$1 AND g.claimed=FALSE
     ORDER BY g.created_at DESC
     LIMIT 25`,
    [req.session.userId]
  );
  res.json({ gifts: r.rows.map(giftPayload) });
});

router.post('/gifts/:giftId/open', async (req, res) => {
  const giftId = String(req.params.giftId || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT g.*, u.username AS from_username, u.display_name AS from_display_name
       FROM user_gifts g
       JOIN users u ON u.id=g.from_user_id
       WHERE g.id=$1 AND g.to_user_id=$2
       FOR UPDATE OF g`,
      [giftId, req.session.userId]
    );
    const gift = r.rows[0];
    if (!gift) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gift not found' });
    }
    if (gift.claimed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Gift already opened' });
    }
    let nexals = null;
    if (gift.gift_type === 'nexals') {
      const updated = await client.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [gift.nexal_amount || 0, req.session.userId]);
      nexals = updated.rows[0].nexals;
    }
    await client.query('UPDATE user_gifts SET claimed=TRUE, claimed_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1', [giftId]);
    await client.query('COMMIT');
    if (typeof nexals === 'number' && req.io) req.io.to(`user:${req.session.userId}`).emit('nexals_updated', { nexals });
    if (gift.gift_type === 'decoration') await syncAchievementFields(req.session.userId, ['decos_owned']);
    res.json({ success: true, gift: giftPayload(gift), nexals });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Open gift failed:', error.message);
    res.status(500).json({ error: 'Could not open gift' });
  } finally {
    client.release();
  }
});

// Buy a decoration with nexals
router.post('/buy', async (req, res) => {
  const { decorationId } = req.body;
  const deco = DECORATIONS.find(d => d.id === decorationId);
  if (!deco) return res.status(404).json({ error: 'Decoration not found' });
  if (deco.hidden) return res.status(403).json({ error: 'This decoration cannot be purchased' });
  if (!deco.nexalPrice) return res.status(403).json({ error: 'This decoration is not available for direct purchase' });

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
  const quantity = Math.min(50, Math.max(1, parseInt(req.body.quantity, 10) || 1));
  const pack = DECORATION_PACKS.find(p => p.id === packId);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });

  const rolledCollectibles = Array.from({ length: quantity }, () => rollPackItem(pack)).filter(Boolean);
  const totalPrice = pack.price * quantity;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    const balance = user.rows[0]?.nexals || 0;
    if (balance < totalPrice) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough Nexals (need ${totalPrice.toLocaleString()}, have ${balance.toLocaleString()})` });
    }
    await client.query('UPDATE users SET nexals = nexals - $1 WHERE id=$2', [totalPrice, req.session.userId]);
    for (const rolled of rolledCollectibles) {
      if (rolled.collectibleType === 'nameplate') {
        await client.query(
          'INSERT INTO user_nameplates (id, user_id, nameplate_id) VALUES ($1,$2,$3)',
          [uuidv4(), req.session.userId, rolled.item.id]
        );
      } else {
        await client.query(
          'INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)',
          [uuidv4(), req.session.userId, rolled.item.id]
        );
      }
    }
    await client.query(`
      INSERT INTO user_pack_stats (user_id, openings) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET openings=user_pack_stats.openings+$2
    `, [req.session.userId, quantity]);
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
    quantity,
    totalPrice,
    granted: rolledCollectibles.map(rolled => rolled.collectibleType === 'nameplate'
      ? toClientNameplate(rolled.item, 1)
      : { ...toClientDecoration(rolled.item, true), collectibleType: 'decoration' })
  });
});

router.post('/nameplates/sell', async (req, res) => {
  const nameplateId = String(req.body.nameplateId || '').trim();
  const nameplate = NAMEPLATES.find(item => item.id === nameplateId);
  if (!nameplate) return res.status(404).json({ error: 'Nameplate not found' });
  const sellPrice = NAMEPLATE_SELL_PRICES[nameplate.rarity] || 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query(`
      WITH one_copy AS (
        SELECT id FROM user_nameplates
        WHERE user_id=$1 AND nameplate_id=$2
        ORDER BY unlocked_at DESC, id DESC
        LIMIT 1
      )
      DELETE FROM user_nameplates WHERE id IN (SELECT id FROM one_copy)
      RETURNING id
    `, [req.session.userId, nameplateId]);
    if (!removed.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'You do not own this nameplate' });
    }
    const remaining = await client.query(
      'SELECT COUNT(*)::int AS quantity FROM user_nameplates WHERE user_id=$1 AND nameplate_id=$2',
      [req.session.userId, nameplateId]
    );
    if (!remaining.rows[0].quantity) {
      await client.query('UPDATE users SET active_nameplate=NULL WHERE id=$1 AND active_nameplate=$2', [req.session.userId, nameplateId]);
    }
    const updated = await client.query(
      'UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals',
      [sellPrice, req.session.userId]
    );
    await client.query('COMMIT');
    res.json({ success: true, nexals: updated.rows[0].nexals, quantity: remaining.rows[0].quantity });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Nameplate sale failed:', error.message);
    res.status(500).json({ error: 'Nameplate sale failed' });
  } finally {
    client.release();
  }
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
    const duplicateCount = decoration?.packOnly ? Math.max(0, row.quantity - 1) : 0;
    return decoration ? { ...toClientDecoration(decoration, row.quantity), totalValue: sellPrice * row.quantity, duplicateCount, duplicateValue: sellPrice * duplicateCount } : null;
  }).filter(Boolean);
  const sellableValue = items.reduce((total, item) => total + item.totalValue, 0);
  const duplicateValue = items.reduce((total, item) => total + item.duplicateValue, 0);
  const duplicateCount = items.reduce((total, item) => total + item.duplicateCount, 0);
  const rarityBreakdown = items.reduce((all, item) => {
    all[item.rarity] = (all[item.rarity] || 0) + item.quantity;
    return all;
  }, {});
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({ nexals: user.rows[0]?.nexals || 0, items, sellableValue, duplicateValue, duplicateCount, rarityBreakdown, uniqueDecorations: items.length, decorationCount: items.reduce((total, item) => total + item.quantity, 0) });
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

router.post('/sell-duplicates', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT decoration_id, COUNT(*)::int AS quantity FROM user_decorations WHERE user_id=$1 GROUP BY decoration_id',
      [req.session.userId]
    );
    let value = 0;
    let soldCount = 0;
    for (const row of owned.rows) {
      const decoration = DECORATIONS.find(d => d.id === row.decoration_id);
      if (!decoration?.packOnly || row.quantity <= 1) continue;
      const duplicates = row.quantity - 1;
      value += (DECORATION_SELL_PRICES[decoration.rarity] || 0) * duplicates;
      soldCount += duplicates;
      await client.query(`
        WITH duplicate_copies AS (
          SELECT id FROM user_decorations
          WHERE user_id=$1 AND decoration_id=$2
          ORDER BY unlocked_at DESC, id DESC
          LIMIT $3
        )
        DELETE FROM user_decorations WHERE id IN (SELECT id FROM duplicate_copies)
      `, [req.session.userId, decoration.id, duplicates]);
    }
    if (!soldCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No duplicate pack decorations to sell' }); }
    const updated = await client.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [value, req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, soldValue: value, soldCount, nexals: updated.rows[0].nexals });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Sell duplicates failed:', error.message);
    res.status(500).json({ error: 'Could not sell duplicate decorations' });
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
