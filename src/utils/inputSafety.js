function normalizeText(value, { field = 'Text', min = 0, max = 300, multiline = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim();
  const controlPattern = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/;
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${field} must be ${min}-${max} characters`);
  }
  if (controlPattern.test(normalized) || /[<>]/.test(normalized)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  return normalized;
}

function safeDisplayName(value) {
  return normalizeText(value, { field: 'Display name', min: 1, max: 32 });
}

function safeBio(value) {
  if (value == null || value === '') return '';
  return normalizeText(String(value), { field: 'Bio', min: 0, max: 300, multiline: true });
}

function safeServerName(value) {
  return normalizeText(value, { field: 'Server name', min: 1, max: 80 });
}

function safeRoleName(value) {
  return normalizeText(value, { field: 'Role name', min: 1, max: 64 });
}

function safeHexColor(value, fallback = '#8892a4') {
  const color = String(value || fallback).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Color must be a six-digit hex value');
  return color.toLowerCase();
}

function safeMessageContent(value, { field = 'Message', max = 4000 } = {}) {
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const content = value.normalize('NFKC').trim();
  if (!content || content.length > max) throw new Error(`${field} must be 1-${max} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(content)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  const allowedMentions = /<@(?:everyone|here|user:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|role:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})>/gi;
  const withoutMentions = content.replace(allowedMentions, '');
  if (/[<>]/.test(withoutMentions)) {
    throw new Error(`${field} cannot contain HTML-like markup`);
  }
  return content;
}

module.exports = { normalizeText, safeDisplayName, safeBio, safeServerName, safeRoleName, safeHexColor, safeMessageContent };
