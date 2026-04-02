/**
 * lib/audit.mjs — Audit logging
 *
 * Appends structured JSON lines to data/audit.log for security events:
 * session connect/disconnect, auth failures, message routing, HTTP API calls.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = join(__dirname, '..', 'data', 'audit.log');
mkdirSync(dirname(AUDIT_LOG), { recursive: true });

export function audit(event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  try {
    appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch {}
}
