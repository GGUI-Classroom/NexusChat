const REPORT_PRESETS = {
  maintenance: { title: 'Nexus Maintenance Notice', label: 'Maintenance' },
  ets: { title: 'Emergency Temporary Shutdown', label: 'ETS' },
  custom: { title: null, label: 'Custom' }
};

let activeReportCache = { loadedAt: 0, report: null };
const CACHE_TTL_MS = 15000;

function normalizeReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    categoryLabel: REPORT_PRESETS[row.category]?.label || 'Report',
    title: row.title,
    message: row.message,
    createdAt: parseInt(row.created_at, 10),
    publishedBy: row.published_by || null
  };
}

async function getActiveReport(pool) {
  const now = Date.now();
  if (now - activeReportCache.loadedAt < CACHE_TTL_MS) return activeReportCache.report;
  const result = await pool.query(
    `SELECT id, category, title, message, published_by, created_at
     FROM system_reports
     WHERE active=TRUE
     ORDER BY created_at DESC
     LIMIT 1`
  );
  activeReportCache = { loadedAt: now, report: normalizeReport(result.rows[0]) };
  return activeReportCache.report;
}

async function getActiveReportForUser(pool, userId) {
  const report = await getActiveReport(pool);
  if (!report || !userId) return report;
  const ack = await pool.query(
    'SELECT id FROM system_report_acknowledgements WHERE report_id=$1 AND user_id=$2 LIMIT 1',
    [report.id, userId]
  );
  return ack.rows.length ? null : report;
}

function clearReportCache() {
  activeReportCache = { loadedAt: 0, report: null };
}

function buildReportPayload(body) {
  const category = String(body.category || '').trim().toLowerCase();
  if (!REPORT_PRESETS[category]) {
    const err = new Error('Choose maintenance, ETS, or custom');
    err.status = 400;
    throw err;
  }
  const message = String(body.message || '').trim().slice(0, 800);
  if (!message) {
    const err = new Error('Report message is required');
    err.status = 400;
    throw err;
  }
  const title = category === 'custom'
    ? String(body.title || '').trim().slice(0, 90)
    : REPORT_PRESETS[category].title;
  if (!title) {
    const err = new Error('Custom reports need a title');
    err.status = 400;
    throw err;
  }
  return { category, title, message };
}

module.exports = { REPORT_PRESETS, buildReportPayload, clearReportCache, getActiveReport, getActiveReportForUser };
