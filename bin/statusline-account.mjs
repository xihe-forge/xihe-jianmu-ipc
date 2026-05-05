import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function oauthFromCredentials(credentials) {
  return credentials?.claudeAiOauth ?? credentials?.claude_ai_oauth ?? credentials?.oauth ?? {};
}

export function tokenFingerprint(token) {
  if (!token) return null;
  const tail = String(token).slice(-16);
  return createHash('sha256').update(tail).digest('hex').slice(0, 16);
}

export function accountFingerprint(credentials) {
  return tokenFingerprint(oauthFromCredentials(credentials).refreshToken);
}

function readMarker(markerPath) {
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, 'utf8').trim();
    if (!raw) return null;
    if (raw === 'a' || raw === 'b') return { which: raw };
    const parsed = JSON.parse(raw);
    if (parsed?.which === 'a' || parsed?.which === 'b') return parsed;
  } catch {}
  return null;
}

function resolveByVaultFingerprint(credentials, claudeDir) {
  const currentOauth = oauthFromCredentials(credentials);
  const currentRefreshFingerprint = tokenFingerprint(currentOauth.refreshToken);
  const currentAccessFingerprint = tokenFingerprint(currentOauth.accessToken);
  const vaultDir = join(claudeDir, '.creds-vault');

  for (const which of ['a', 'b']) {
    const vaultPath = join(vaultDir, `account-${which}.json`);
    if (!existsSync(vaultPath)) continue;
    try {
      const vaultCredentials = readJson(vaultPath);
      const vaultOauth = oauthFromCredentials(vaultCredentials);
      const vaultRefreshFingerprint = tokenFingerprint(vaultOauth.refreshToken);
      if (currentRefreshFingerprint && currentRefreshFingerprint === vaultRefreshFingerprint) {
        return which;
      }

      const vaultAccessFingerprint = tokenFingerprint(vaultOauth.accessToken);
      if (currentAccessFingerprint && currentAccessFingerprint === vaultAccessFingerprint) {
        return which;
      }
    } catch {}
  }

  return null;
}

export async function resolveAccount({
  claudeDir = join(homedir(), '.claude'),
} = {}) {
  const markerPath = join(claudeDir, '.current-account');
  const credsPath = join(claudeDir, '.credentials.json');
  if (!existsSync(credsPath)) return null;

  let credentials;
  try {
    credentials = readJson(credsPath);
  } catch {
    return null;
  }

  const marker = readMarker(markerPath);
  const currentFingerprint = accountFingerprint(credentials);
  if (
    marker?.fingerprint &&
    currentFingerprint &&
    marker.fingerprint === currentFingerprint &&
    (marker.which === 'a' || marker.which === 'b')
  ) {
    return marker.which;
  }

  const vaultMatch = resolveByVaultFingerprint(credentials, claudeDir);
  if (vaultMatch) return vaultMatch;

  const sub = oauthFromCredentials(credentials).subscriptionType;
  if (sub === 'max') return 'a';
  if (sub === 'pro') return 'b';
  if ((marker?.which === 'a' || marker?.which === 'b') && !marker?.fingerprint) return marker.which;
  return null;
}

export function renderAccountTag(which) {
  if (which === 'a') return '\x1b[42;30m A \x1b[0m';
  if (which === 'b') return '\x1b[44;97m B \x1b[0m';
  return '\x1b[41;97m ? \x1b[0m';
}

export function findHudScript({ claudeDir = join(homedir(), '.claude') } = {}) {
  const hudDir = join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud');
  try {
    const versions = readdirSync(hudDir)
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
      .sort((a, b) => a.split('.').map(Number).reduce((diff, part, index) => diff || part - b.split('.').map(Number)[index], 0));
    if (versions.length) return join(hudDir, versions[versions.length - 1], 'dist', 'index.js');
  } catch {}
  return null;
}

export function renderCcusageBlockInfo({ claudeDir = join(homedir(), '.claude') } = {}) {
  const cachePath = join(claudeDir, '.statusline-push-cooldown', 'ccusage-block.json');
  try {
    if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < 5000) {
      return formatCcusageBlock(JSON.parse(readFileSync(cachePath, 'utf8')));
    }
    const result = spawnSync(process.execPath, ['-e', `
      import { getTokenStatus } from 'file:///D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/lib/ccusage-adapter.mjs';
      const status = await getTokenStatus({});
      process.stdout.write(JSON.stringify(status));
    `], { encoding: 'utf8', timeout: 1200, windowsHide: true });
    if (result.status !== 0 || !result.stdout) return '';
    const status = JSON.parse(result.stdout);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(status), 'utf8');
    return formatCcusageBlock(status);
  } catch {
    return '';
  }
}

export function formatCcusageBlock(status) {
  if (!status?.ok || status.remaining_pct === null || status.remaining_pct === undefined) return '';
  const resets = status.resets_at ? new Date(status.resets_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '??:??';
  return ` \x1b[36m5h ${status.remaining_pct}% left->${resets}\x1b[0m`;
}

export function pushContextTruth(name, stdinJson, { claudeDir = join(homedir(), '.claude') } = {}) {
  const cooldownPath = join(claudeDir, '.statusline-push-cooldown', `${name}.ts`);
  const now = Date.now();
  try {
    if (existsSync(cooldownPath) && now - statSync(cooldownPath).mtimeMs < 5000) return;
  } catch {}

  const body = JSON.stringify({
    name,
    session_id: stdinJson.session_id,
    transcript_path: stdinJson.transcript_path,
    model: stdinJson.model,
    cost: stdinJson.cost,
    context_window: stdinJson.context_window,
    rate_limits: stdinJson.rate_limits,
    ai_agent: process.env.AI_AGENT,
    claude_project_dir: process.env.CLAUDE_PROJECT_DIR,
    ts: now,
  });

  try {
    mkdirSync(dirname(cooldownPath), { recursive: true });
    closeSync(openSync(cooldownPath, 'a'));
  } catch {}

  const target = new URL(process.env.STATUSLINE_CONTEXT_PUSH_URL || 'http://127.0.0.1:3179/session/context');
  try {
    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      try { process.stderr.write(`[statusline-account] context push failed: ${error?.message ?? error}\n`); } catch {}
    });
    req.write(body);
    req.end();
  } catch (error) {
    try { process.stderr.write(`[statusline-account] context push failed: ${error?.message ?? error}\n`); } catch {}
  }
}

export async function main() {
  let stdinData = '';
  try { stdinData = readFileSync(0, 'utf8'); } catch { stdinData = '{}'; }

  const claudeDir = join(homedir(), '.claude');
  const account = await resolveAccount({ claudeDir });
  const tag = renderAccountTag(account);
  const nodeExe = 'D:\\software\\ide\\nodejs\\node.exe';
  const hudScript = findHudScript({ claudeDir });
  const result = hudScript
    ? spawnSync(nodeExe, [hudScript], { input: stdinData, encoding: 'utf8' })
    : { stdout: '' };
  const hudOut = (result.stdout || '').replace(/\r?\n$/, '');
  const ccusageOut = renderCcusageBlockInfo({ claudeDir });

  try {
    const stdinJson = JSON.parse(stdinData || '{}');
    const ipcName = process.env.IPC_NAME;
    if (ipcName) pushContextTruth(ipcName, stdinJson, { claudeDir });
  } catch (error) {
    try { process.stderr.write(`[statusline-account] context push skipped: ${error?.message ?? error}\n`); } catch {}
  }

  process.stdout.write(`${tag} ${hudOut}${ccusageOut}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stdout.write(`${renderAccountTag(null)} `);
  });
}
