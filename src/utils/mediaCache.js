const entries = new Map();
const MAX_BYTES = 48 * 1024 * 1024;
let totalBytes = 0;

function getCachedMedia(key) {
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

function deleteCachedMedia(key) {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.data.length;
  entries.delete(key);
}

function setCachedMedia(key, data, mime = 'application/octet-stream') {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  deleteCachedMedia(key);
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  while (entries.size && totalBytes + buffer.length > MAX_BYTES) {
    deleteCachedMedia(entries.keys().next().value);
  }
  const entry = { data: buffer, mime };
  entries.set(key, entry);
  totalBytes += buffer.length;
  return entry;
}

module.exports = { deleteCachedMedia, getCachedMedia, setCachedMedia };
