const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');

const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';
const CACHE_TTL_MS = 60 * 1000;
const LEET_MAP = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
  '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
  '€': 'e', '£': 'l'
};
const CONFUSABLE_MAP = {
  'а': 'a', 'ɑ': 'a', 'α': 'a',
  'Ь': 'b', 'в': 'b', 'β': 'b',
  'с': 'c', 'ϲ': 'c',
  'ԁ': 'd',
  'е': 'e', 'ε': 'e',
  'ɡ': 'g',
  'һ': 'h',
  'і': 'i', 'ї': 'i', 'ι': 'i',
  'ј': 'j',
  'κ': 'k',
  'ӏ': 'l',
  'м': 'm', 'μ': 'm',
  'ո': 'n',
  'о': 'o', 'ο': 'o',
  'р': 'p', 'ρ': 'p',
  'ԛ': 'q',
  'г': 'r',
  'ѕ': 's',
  'т': 't', 'τ': 't',
  'υ': 'u',
  'ν': 'v',
  'ԝ': 'w', 'ω': 'w',
  'х': 'x', 'χ': 'x',
  'у': 'y',
  'ᴢ': 'z'
};

let cachedTerms = null;
let cacheExpiresAt = 0;

function normalizeCharacters(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0-9@$!|+€£]/g, character => LEET_MAP[character] || character)
    .replace(/[^\u0000-\u007f]/g, character => CONFUSABLE_MAP[character] || character)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
}

function normalizeTerm(value) {
  return normalizeCharacters(value).replace(/[^a-z]/g, '');
}

function compileTerm(term, category = 'server') {
  const normalized = normalizeTerm(term);
  if (normalized.length < 3) return null;
  const characters = normalized.split('');
  const buildPattern = omittedIndex => {
    const kept = characters
      .map((character, index) => ({ character, index }))
      .filter(entry => entry.index !== omittedIndex);
    return kept.map((entry, position) => {
      const token = `${entry.character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}{1,6}`;
      if (position === kept.length - 1) return token;
      const skippedConfiguredCharacter = kept[position + 1].index - entry.index > 1;
      return token + (skippedConfiguredCharacter ? '[^a-z0-9]{1,12}' : '[^a-z0-9]{0,12}');
    }).join('');
  };
  const variants = [buildPattern(-1)];
  if (characters.length >= 5) {
    for (let index = 1; index < characters.length - 1; index++) {
      variants.push(buildPattern(index));
    }
  }
  return {
    term: String(term).trim(),
    normalized,
    category,
    pattern: new RegExp(`(^|[^a-z0-9])(?:${variants.join('|')})(?:s)?(?=$|[^a-z0-9])`, 'i')
  };
}

async function getSafetyTerms() {
  if (cachedTerms && Date.now() < cacheExpiresAt) return cachedTerms;
  const result = await pool.query('SELECT term, category FROM global_safety_terms ORDER BY category, term ASC');
  cachedTerms = result.rows.map(row => compileTerm(row.term, row.category)).filter(Boolean);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedTerms;
}

function clearSafetyTermCache() {
  cachedTerms = null;
  cacheExpiresAt = 0;
}

async function findSafetyViolation(content) {
  const normalizedContent = normalizeCharacters(content);
  const terms = await getSafetyTerms();
  return terms.find(entry => entry.pattern.test(normalizedContent)) || null;
}

function findConfiguredViolation(content, terms) {
  const normalizedContent = normalizeCharacters(content);
  return (terms || [])
    .map(term => compileTerm(term))
    .filter(Boolean)
    .find(entry => entry.pattern.test(normalizedContent)) || null;
}

async function createAutomaticSafetyReport({ userId, content, messageType, serverId = null, channelId = null, matchedTerm, category }) {
  await pool.query(
    `INSERT INTO user_reports
      (id, reporter_id, target_user_id, report_type, reason, message_type, message_id, message_content, server_id, channel_id)
     VALUES ($1,$2,$3,'automod',$4,$5,NULL,$6,$7,$8)`,
    [
      uuidv4(),
      NEXUS_GUARD_ID,
      userId,
      `NexusGuard ${contextCategoryLabel(category)} filter matched configured term: ${matchedTerm}`,
      messageType,
      String(content || '').slice(0, 4000),
      serverId,
      channelId
    ]
  );
}

function contextCategoryLabel(category) {
  if (category === 'child_safety') return 'Child Safety';
  if (category === 'nsfw') return 'NSFW';
  return 'Discriminatory Language';
}

async function enforceGlobalSafety(context) {
  const violation = await findSafetyViolation(context.content);
  if (!violation) return null;
  await createAutomaticSafetyReport({ ...context, matchedTerm: violation.term, category: violation.category });
  return violation;
}

module.exports = {
  clearSafetyTermCache,
  enforceGlobalSafety,
  findConfiguredViolation,
  normalizeTerm
};
