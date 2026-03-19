const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COLORS = [
  { id: 'red',      name: 'Red',       price: 5000,  preview: '#ff4444',  css: 'color:#ff4444' },
  { id: 'orange',   name: 'Orange',    price: 5000,  preview: '#ff8c00',  css: 'color:#ff8c00' },
  { id: 'yellow',   name: 'Yellow',    price: 5000,  preview: '#ffd700',  css: 'color:#ffd700' },
  { id: 'green',    name: 'Green',     price: 5000,  preview: '#3dd68c',  css: 'color:#3dd68c' },
  { id: 'cyan',     name: 'Cyan',      price: 5000,  preview: '#00ccff',  css: 'color:#00ccff' },
  { id: 'blue',     name: 'Blue',      price: 5000,  preview: '#5b6ef5',  css: 'color:#5b6ef5' },
  { id: 'purple',   name: 'Purple',    price: 5000,  preview: '#8b3cf7',  css: 'color:#8b3cf7' },
  { id: 'pink',     name: 'Pink',      price: 5000,  preview: '#ff2d8e',  css: 'color:#ff2d8e' },
  { id: 'white',    name: 'White',     price: 5000,  preview: '#f0f0f0',  css: 'color:#f0f0f0' },
  { id: 'gold',     name: 'Gold',      price: 5000,  preview: '#f5c842',  css: 'color:#f5c842' },
  { id: 'rainbow',  name: 'Rainbow',   price: 15000, preview: 'rainbow',  css: 'rainbow' },
  { id: 'fire',     name: 'Fire Text', price: 15000, preview: 'fire',     css: 'fire' },
  { id: 'galaxy',   name: 'Galaxy',    price: 15000, preview: 'galaxy',   css: 'galaxy' },
];

// GET all colors + owned status
router.get('/', async (req, res) => {
  const owned = await pool.query('SELECT color_id FROM user_colors WHERE user_id=$1', [req.session.userId]);
  const user  = await pool.query('SELECT active_color, nexals FROM users WHERE id=$1', [req.session.userId]);
  const ownedSet = new Set(owned.rows.map(r => r.color_id));
  res.json({
    colors: COLORS.map(c => ({ ...c, owned: ownedSet.has(c.id) })),
    active: user.rows[0]?.active_color || null,
    nexals: user.rows[0]?.nexals || 0,
  });
});

// Buy a color
router.post('/buy', async (req, res) => {
  const { colorId } = req.body;
  const color = COLORS.find(c => c.id === colorId);
  if (!color) return res.status(404).json({ error: 'Color not found' });
  const owned = await pool.query('SELECT id FROM user_colors WHERE user_id=$1 AND color_id=$2', [req.session.userId, colorId]);
  if (owned.rows.length) return res.status(409).json({ error: 'Already owned' });
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.nexals || 0) < color.price) return res.status(400).json({ error: `Not enough Nexals (need ${color.price.toLocaleString()})` });
  await pool.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [color.price, req.session.userId]);
  await pool.query('INSERT INTO user_colors (id,user_id,color_id) VALUES ($1,$2,$3)', [uuidv4(), req.session.userId, colorId]);
  const updated = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({ success: true, nexals: updated.rows[0].nexals, color: { ...color, owned: true } });
});

// Equip / unequip color
router.post('/equip', async (req, res) => {
  const { colorId } = req.body;
  if (colorId) {
    const owned = await pool.query('SELECT id FROM user_colors WHERE user_id=$1 AND color_id=$2', [req.session.userId, colorId]);
    if (!owned.rows.length) return res.status(403).json({ error: 'Not owned' });
  }
  await pool.query('UPDATE users SET active_color=$1 WHERE id=$2', [colorId || null, req.session.userId]);
  res.json({ success: true, active: colorId || null });
});

module.exports = router;
module.exports.COLORS = COLORS;

// ---- FONTS ----
const FONTS = [
  { id: 'bubble', name: 'DynaPuff', price: 15000, description: 'Chunky DynaPuff bubble font' },
  { id: 'vt323', name: 'VT323', price: 10000, description: 'Retro pixel terminal font' },
];

router.get('/fonts', async (req, res) => {
  const owned = await pool.query('SELECT font_id FROM user_fonts WHERE user_id=$1', [req.session.userId]);
  const user  = await pool.query('SELECT active_font, nexals, font_on_username FROM users WHERE id=$1', [req.session.userId]);
  const ownedSet = new Set(owned.rows.map(r => r.font_id));
  res.json({
    fonts: FONTS.map(f => ({ ...f, owned: ownedSet.has(f.id) })),
    active: user.rows[0]?.active_font || null,
    nexals: user.rows[0]?.nexals || 0,
    fontOnUsername: !!user.rows[0]?.font_on_username,
  });
});

router.post('/fonts/buy', async (req, res) => {
  const { fontId } = req.body;
  const font = FONTS.find(f => f.id === fontId);
  if (!font) return res.status(404).json({ error: 'Font not found' });
  const owned = await pool.query('SELECT id FROM user_fonts WHERE user_id=$1 AND font_id=$2', [req.session.userId, fontId]);
  if (owned.rows.length) return res.status(409).json({ error: 'Already owned' });
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.nexals || 0) < font.price) return res.status(400).json({ error: `Not enough Nexals (need ${font.price.toLocaleString()})` });
  await pool.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [font.price, req.session.userId]);
  await pool.query('INSERT INTO user_fonts (id,user_id,font_id) VALUES ($1,$2,$3)', [uuidv4(), req.session.userId, fontId]);
  const updated = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  res.json({ success: true, nexals: updated.rows[0].nexals, font: { ...font, owned: true } });
});

router.post('/fonts/toggle-username', async (req, res) => {
  const { enabled } = req.body;
  await pool.query('UPDATE users SET font_on_username=$1 WHERE id=$2', [!!enabled, req.session.userId]);
  res.json({ success: true, fontOnUsername: !!enabled });
});

router.post('/fonts/equip', async (req, res) => {
  const { fontId } = req.body;
  if (fontId) {
    const owned = await pool.query('SELECT id FROM user_fonts WHERE user_id=$1 AND font_id=$2', [req.session.userId, fontId]);
    if (!owned.rows.length) return res.status(403).json({ error: 'Not owned' });
  }
  await pool.query('UPDATE users SET active_font=$1 WHERE id=$2', [fontId || null, req.session.userId]);
  res.json({ success: true, active: fontId || null });
});
