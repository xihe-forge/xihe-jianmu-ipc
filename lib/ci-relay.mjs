import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lark from '@larksuiteoapi/node-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoutesPath = resolve(__dirname, '..', 'ci-routes.json');
const defaultFeishuAppsPath = resolve(__dirname, '..', 'feishu-apps.json');
const defaultMailboxId = 'xihe-ai@lumidrivetech.com';
const defaultInterval = 60000;
const githubSender = 'notifications@github.com';
export const RATE_LIMIT_ERROR_CODE = 15120000;
export const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

// 中继状态保持在模块级，避免影响 hub 主流程。
let relayTimer = null;
let relayRunning = false;
let pollInFlight = false;
let fakeSender = null;
let backoffUntilMs = 0;
let backoffResumeLogged = false;
const processedMessageIds = new Set();

function log(message) {
  process.stderr.write(`[ci-relay] ${message}\n`);
}

function readJsonFile(filePath, label) {
  if (!existsSync(filePath)) {
    log(`${label} not found: ${filePath}`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    log(`failed to load ${label}: ${err?.message ?? err}`);
    return null;
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 飞书邮箱API返回的body_plain_text和body_html是base64编码的
function decodeBase64(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value; // 如果不是base64，原样返回
  }
}

function extractBranchFromDescription(description) {
  const text = normalizeText(description);
  if (!text) return null;

  const branchPatterns = [
    /\bbranch\s+([A-Za-z0-9._/-]+)/i,
    /\bon\s+([A-Za-z0-9._/-]+)/i,
    /\bfor\s+([A-Za-z0-9._/-]+)/i,
    /-\s*([A-Za-z0-9._/-]+)\s*$/,
    /^([A-Za-z0-9._/-]+)$/,
  ];

  for (const pattern of branchPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function parseGitHubCISubject(subject) {
  const normalizedSubject = normalizeText(subject);
  if (!normalizedSubject) return null;

  const bracketMatch = normalizedSubject.match(/^\[([^/\]]+)\/([^\]]+)\]\s+(.+)$/);
  if (!bracketMatch) return null;

  const [, org, repoName, rest] = bracketMatch;
  const isFailure = /\b(?:failed|failure)\b/i.test(rest);
  const runMatch = rest.match(/^Run\s+(failed|failure)\s*:\s*(.+?)\s*-\s*(.+?)\s*\(([^)]+)\)\s*$/i);
  if (runMatch) {
    return {
      org,
      repoName,
      repoFullName: `${org}/${repoName}`,
      statusText: runMatch[1].toLowerCase(),
      workflow: normalizeText(runMatch[2]) || 'CI',
      branch: normalizeText(runMatch[3]) || 'unknown',
      description: normalizeText(runMatch[3]),
      commitHash: normalizeText(runMatch[4]) || null,
      isFailure,
      rawSubject: normalizedSubject,
    };
  }

  const genericMatch = rest.match(/^(.+?)\s*:\s*(.+?)\s*\(([^)]+)\)\s*$/);
  if (!genericMatch) {
    return {
      org,
      repoName,
      repoFullName: `${org}/${repoName}`,
      statusText: isFailure ? 'failed' : '',
      workflow: 'CI',
      branch: 'unknown',
      description: rest,
      commitHash: null,
      isFailure,
      rawSubject: normalizedSubject,
    };
  }

  const description = normalizeText(genericMatch[2]);
  return {
    org,
    repoName,
    repoFullName: `${org}/${repoName}`,
    statusText: isFailure ? 'failed' : '',
    workflow: normalizeText(genericMatch[1]) || 'CI',
    branch: extractBranchFromDescription(description) || 'unknown',
    description,
    commitHash: normalizeText(genericMatch[3]) || null,
    isFailure,
    rawSubject: normalizedSubject,
  };
}

export function extractGitHubActionsUrl(bodyText = '') {
  const match = String(bodyText).match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+/i);
  return match?.[0] ?? null;
}

export function extractGitHubActor(bodyText = '') {
  const source = String(bodyText);
  const actorPatterns = [
    /\bTriggered by\s+@?([A-Za-z0-9_.-]+)/i,
    /\bactor[:：]\s*@?([A-Za-z0-9_.-]+)/i,
    /\bby\s+@?([A-Za-z0-9_.-]+)\s*(?:\r?\n|$)/i,
  ];

  for (const pattern of actorPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }

  return 'unknown';
}

export function parseGitHubCIEmail(message, messageId = null) {
  const subjectInfo = parseGitHubCISubject(message?.subject);
  if (!subjectInfo?.isFailure) return null;

  const fromAddress = normalizeText(message?.head_from?.mail_address).toLowerCase();
  if (fromAddress !== githubSender) return null;

  const bodySource = [decodeBase64(message?.body_plain_text), decodeBase64(message?.body_html)].filter(Boolean).join('\n');
  return {
    messageId,
    ...subjectInfo,
    fromAddress,
    actionsUrl: extractGitHubActionsUrl(bodySource),
    actor: extractGitHubActor(bodySource),
    internalDate: message?.internal_date ?? null,
  };
}

export function loadCIRoutes(routesPath = defaultRoutesPath) {
  const routes = readJsonFile(routesPath, 'ci-routes.json');
  return routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : null;
}

export function resolveRouteTarget(routes, repoName, repoFullName = '') {
  if (!routes || typeof routes !== 'object') return null;
  return routes[repoName] ?? routes[repoFullName] ?? null;
}

export function buildCIRelayMessage(parsedMail, target, now = Date.now()) {
  return {
    type: 'message',
    from: 'ci-monitor',
    to: target,
    content: `[CI失败] ${parsedMail.repoName} / ${parsedMail.branch}\n触发: ${parsedMail.actor}\n链接: ${parsedMail.actionsUrl ?? '未找到'}`,
    id: `ci-${now}-${Math.random().toString(16).slice(2, 8)}`,
    ts: now,
  };
}

function createFakeSender() {
  return {
    name: 'ci-monitor',
    ws: null,
    inbox: [],
    topics: new Set(),
    connectedAt: Date.now(),
  };
}

function createLarkClient(feishuAppsPath) {
  const feishuApps = readJsonFile(feishuAppsPath, 'feishu-apps.json');
  if (!Array.isArray(feishuApps) || feishuApps.length === 0) {
    log('feishu-apps.json is empty or invalid, CI relay is idle');
    return null;
  }

  const app = feishuApps[0];
  if (!app?.appId || !app?.appSecret) {
    log('feishu-apps.json first item is missing appId/appSecret, CI relay is idle');
    return null;
  }

  return new lark.Client({
    appId: app.appId,
    appSecret: app.appSecret,
  });
}

function extractErrorCode(err) {
  return err?.code ?? err?.response?.data?.code ?? err?.data?.code ?? err?.error?.code ?? null;
}

export function isRateLimitError(err) {
  const code = extractErrorCode(err);
  if (Number(code) === RATE_LIMIT_ERROR_CODE || String(code) === String(RATE_LIMIT_ERROR_CODE)) {
    return true;
  }

  const message = String(err?.msg ?? err?.message ?? err ?? '').toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests');
}

function enterRateLimitBackoff(err, options) {
  const now = options.now();
  backoffUntilMs = now + RATE_LIMIT_BACKOFF_MS;
  backoffResumeLogged = false;
  const resumeAt = new Date(backoffUntilMs).toISOString();
  const detail = err?.msg ?? err?.message ?? `code=${extractErrorCode(err)}`;
  log(`list unread messages rate limited: ${detail}; entering 5min backoff at ${new Date(now).toISOString()}; resumes at ${resumeAt}`);
}

function shouldSkipForBackoff(options) {
  if (backoffUntilMs <= 0) return false;

  const now = options.now();
  if (now < backoffUntilMs) return true;

  if (!backoffResumeLogged) {
    log(`resuming poll at ${new Date(now).toISOString()}`);
    backoffResumeLogged = true;
  }
  backoffUntilMs = 0;
  return false;
}

async function pollMailbox(routeMessage, options) {
  if (shouldSkipForBackoff(options)) {
    return;
  }

  if (pollInFlight) {
    log('previous poll still running, skipping this cycle');
    return;
  }

  pollInFlight = true;
  try {
    const client = options.createClient ? options.createClient(options.feishuAppsPath) : createLarkClient(options.feishuAppsPath);
    if (!client) return;

    const routes = loadCIRoutes(options.routesPath);
    if (!routes) {
      log('ci-routes.json missing or invalid, skipping this cycle');
      return;
    }

    let listRes;
    try {
      listRes = await client.mail.userMailboxMessage.list({
        params: {
          page_size: 20,
          folder_id: 'INBOX',
          only_unread: true,
        },
        path: {
          user_mailbox_id: options.mailboxId,
        },
      });
    } catch (err) {
      if (isRateLimitError(err)) {
        enterRateLimitBackoff(err, options);
        return;
      }
      throw err;
    }

    if ((listRes?.code ?? 0) !== 0) {
      if (isRateLimitError(listRes)) {
        enterRateLimitBackoff(listRes, options);
        return;
      }
      log(`list unread messages failed: ${listRes?.msg ?? `code=${listRes?.code}`}`);
      return;
    }

    const messageIds = Array.isArray(listRes?.data?.items) ? listRes.data.items : [];
    if (messageIds.length === 0) return;

    // 每封邮件独立处理，单封失败不能中断整轮轮询。
    for (const messageId of messageIds) {
      if (!messageId || processedMessageIds.has(messageId)) continue;

      try {
        const getRes = await client.mail.userMailboxMessage.get({
          path: {
            user_mailbox_id: options.mailboxId,
            message_id: messageId,
          },
        });

        if ((getRes?.code ?? 0) !== 0) {
          log(`get message failed: ${messageId} ${getRes?.msg ?? `code=${getRes?.code}`}`);
          continue;
        }

        const message = getRes?.data?.message;
        const parsedMail = parseGitHubCIEmail(message, messageId);
        processedMessageIds.add(messageId);

        if (!parsedMail) continue;

        const target = resolveRouteTarget(routes, parsedMail.repoName, parsedMail.repoFullName);
        if (!target) {
          log(`no route for repo ${parsedMail.repoName}`);
          continue;
        }

        const relayMessage = buildCIRelayMessage(parsedMail, target);
        routeMessage(relayMessage, fakeSender ?? createFakeSender());
        log(`forwarded ${parsedMail.repoName} -> ${target}`);
      } catch (err) {
        log(`message cycle failed for ${messageId}: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    log(`poll cycle failed: ${err?.message ?? err}`);
  } finally {
    pollInFlight = false;
  }
}

export function startCIRelay(routeMessage, options = {}) {
  if (relayRunning) return;
  if (typeof routeMessage !== 'function') {
    log('routeMessage is not a function, CI relay not started');
    return;
  }

  const relayOptions = {
    interval: options.interval ?? defaultInterval,
    routesPath: options.routesPath ? resolve(options.routesPath) : defaultRoutesPath,
    mailboxId: options.mailboxId ?? defaultMailboxId,
    feishuAppsPath: options.feishuAppsPath ? resolve(options.feishuAppsPath) : defaultFeishuAppsPath,
    createClient: options.createClient,
    now: options.now ?? Date.now,
  };

  fakeSender = createFakeSender();
  relayRunning = true;
  backoffUntilMs = 0;
  backoffResumeLogged = false;

  void pollMailbox(routeMessage, relayOptions);
  relayTimer = setInterval(() => {
    void pollMailbox(routeMessage, relayOptions);
  }, relayOptions.interval);
  relayTimer.unref?.();

  log(`started, mailbox=${relayOptions.mailboxId}, interval=${relayOptions.interval}ms`);
}

export function stopCIRelay() {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }

  relayRunning = false;
  pollInFlight = false;
  fakeSender = null;
  backoffUntilMs = 0;
  backoffResumeLogged = false;
  log('stopped');
}
