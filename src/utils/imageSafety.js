const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a'))) return 'image/gif';
  if (buffer.subarray(0, 4).equals(Buffer.from('RIFF')) && buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  return null;
}

function safeUploadMime(file) {
  if (!file || !IMAGE_MIMES.has(file.mimetype)) return null;
  const detected = detectImageMime(file.buffer);
  return detected === file.mimetype ? detected : null;
}

function safeStoredImageMime(mime, buffer) {
  const detected = detectImageMime(buffer);
  // Trust the bytes, never a value that was stored from a user-controlled MIME header.
  return detected || null;
}

module.exports = { detectImageMime, safeUploadMime, safeStoredImageMime };
