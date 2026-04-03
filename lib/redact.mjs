/**
 * lib/redact.mjs — Sensitive information filtering
 *
 * Redacts passwords, tokens, API keys, and private keys from text
 * before persisting to SQLite or returning via API.
 */

const SENSITIVE_PATTERNS = [
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /(?:token|secret|api.?key)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
];

export function redactSensitive(text) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
