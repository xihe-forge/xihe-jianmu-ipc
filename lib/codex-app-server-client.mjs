import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export class InvalidInjectItemSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInjectItemSchemaError';
  }
}

export class CodexAppServerRpcError extends Error {
  constructor(error, request) {
    super(error?.message ?? `JSON-RPC error ${error?.code ?? 'unknown'}`);
    this.name = 'CodexAppServerRpcError';
    this.code = error?.code ?? null;
    this.data = error?.data;
    this.request = request;
  }
}

export function formatInjectItem(text) {
  if (typeof text !== 'string') {
    throw new TypeError('formatInjectItem expects a string');
  }
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function validateInjectItemSchema(item, index = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new InvalidInjectItemSchemaError(`items[${index}] must be a schema 4 message object`);
  }
  if (item.type !== 'message') {
    throw new InvalidInjectItemSchemaError(`items[${index}].type must be "message"`);
  }
  if (item.role !== 'user') {
    throw new InvalidInjectItemSchemaError(`items[${index}].role must be "user"`);
  }
  if (!Array.isArray(item.content) || item.content.length === 0) {
    throw new InvalidInjectItemSchemaError(`items[${index}].content must be a non-empty array`);
  }
  for (let partIndex = 0; partIndex < item.content.length; partIndex += 1) {
    const part = item.content[partIndex];
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new InvalidInjectItemSchemaError(
        `items[${index}].content[${partIndex}] must be an object`,
      );
    }
    if (part.type !== 'input_text') {
      throw new InvalidInjectItemSchemaError(
        `items[${index}].content[${partIndex}].type must be "input_text"`,
      );
    }
    if (typeof part.text !== 'string') {
      throw new InvalidInjectItemSchemaError(
        `items[${index}].content[${partIndex}].text must be a string`,
      );
    }
  }
}

function defaultTrace(line) {
  process.stderr.write(`${line}\n`);
}

function asInput(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, text_elements: [] }];
  }
  throw new TypeError('turn input must be a string or an App Server input array');
}

function isNotification(message) {
  return (
    Boolean(message) &&
    typeof message === 'object' &&
    typeof message.method === 'string' &&
    message.id === undefined
  );
}

function resolveExecutable(command, env = process.env) {
  if (process.platform !== 'win32') return command;
  if (isAbsolute(command) || command.includes('\\') || command.includes('/')) return command;

  const pathEntries = String(env.PATH || env.Path || '')
    .split(delimiter)
    .filter(Boolean);
  const extensions = ['.cmd', '.exe', '.bat', ''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export function resolveSpawnSpec(command, args, env = process.env) {
  const resolvedCommand = resolveExecutable(command, env);
  if (process.platform === 'win32' && /\.cmd$/i.test(resolvedCommand)) {
    const codexJs = join(
      dirname(resolvedCommand),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (existsSync(codexJs)) {
      return { command: process.execPath, args: [codexJs, ...args], shell: false };
    }
  }
  return {
    command: resolvedCommand,
    args,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCommand),
  };
}

function getThreadState(states, threadId) {
  const state = states.get(threadId) ?? {
    status: { type: 'unknown' },
    activeTurnId: null,
  };
  states.set(threadId, state);
  return state;
}

function turnKey(threadId, turnId) {
  return `${threadId}\u0000${turnId}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapturedText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n');
}

function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => textFromContent(part))
      .filter(Boolean)
      .join('');
  }
  if (!isPlainObject(value)) return '';

  const direct =
    typeof value.text === 'string'
      ? value.text
      : typeof value.delta === 'string'
        ? value.delta
        : typeof value.message === 'string'
          ? value.message
          : typeof value.output_text === 'string'
            ? value.output_text
            : '';
  if (direct) return direct;

  if (value.type === 'output_text' && typeof value.text === 'string') return value.text;
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (Array.isArray(value.content)) return textFromContent(value.content);
  if (isPlainObject(value.content)) return textFromContent(value.content);
  return '';
}

function looksLikeAssistantMessage(value) {
  if (!isPlainObject(value)) return false;
  const role = typeof value.role === 'string' ? value.role.toLowerCase() : '';
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  return (
    role === 'assistant' ||
    role === 'agent' ||
    type === 'agent_message' ||
    type === 'agentmessage' ||
    type === 'assistant_message' ||
    type === 'message'
  );
}

function extractAgentMessageText(message) {
  const method = String(message?.method ?? '').toLowerCase();
  const params = isPlainObject(message?.params) ? message.params : {};

  if (method.includes('agentmessage') && method.includes('delta')) {
    return { mode: 'append', text: normalizeCapturedText(params.delta) };
  }
  if (method.includes('agent_message') && method.includes('delta')) {
    return { mode: 'append', text: normalizeCapturedText(params.delta) };
  }

  const likelyAgentMethod =
    method.includes('agentmessage') ||
    method.includes('agent_message') ||
    method.includes('assistant') ||
    method.includes('response_item');

  const candidates = [
    params.agentMessage,
    params.agent_message,
    params.message,
    params.item,
    params.responseItem,
    params.response_item,
    params.event_msg,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      if (likelyAgentMethod) return { mode: 'replace', text: normalizeCapturedText(candidate) };
      continue;
    }
    if (looksLikeAssistantMessage(candidate) || likelyAgentMethod) {
      const text = normalizeCapturedText(textFromContent(candidate));
      if (text) return { mode: 'replace', text };
    }
  }

  if (likelyAgentMethod) {
    const text = normalizeCapturedText(textFromContent(params.content ?? params.text));
    if (text) return { mode: 'replace', text };
  }

  return null;
}

export function createAppServerClient({
  command = 'codex',
  args = ['app-server', '--listen', 'stdio://'],
  cwd = process.cwd(),
  env = process.env,
  child = null,
  spawnFn = spawn,
  requestTimeoutMs = 60_000,
  retryDelaysMs = [100, 250, 500],
  backpressureRetries = 3,
  trace = defaultTrace,
} = {}) {
  const emitter = new EventEmitter();
  const pending = new Map();
  const threadStates = new Map();
  const turnRecords = new Map();
  const turnCompletionWaiters = new Map();
  let closed = false;
  let nextId = 0;

  const spawnSpec = resolveSpawnSpec(command, args, env);
  const childProcess =
    child ??
    spawnFn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spawnSpec.shell,
    });

  function allocateId(forcedId = null) {
    if (forcedId !== null && forcedId !== undefined) {
      nextId = Math.max(nextId, Number(forcedId) + 1);
      return forcedId;
    }
    const id = nextId;
    nextId += 1;
    return id;
  }

  function getTurnRecord(threadId, turnId) {
    const key = turnKey(threadId, turnId);
    const record = turnRecords.get(key) ?? {
      threadId,
      turnId,
      deltaText: '',
      finalText: '',
      completed: false,
      completedAt: null,
    };
    turnRecords.set(key, record);
    return record;
  }

  function snapshotTurnRecord(record, extra = {}) {
    const lastAgentMessage = normalizeCapturedText(record?.finalText || record?.deltaText || '');
    return {
      threadId: record?.threadId ?? null,
      turnId: record?.turnId ?? null,
      completed: Boolean(record?.completed),
      completedAt: record?.completedAt ?? null,
      lastAgentMessage,
      ...extra,
    };
  }

  function resolveTurnCompletionWaiters(record) {
    const key = turnKey(record.threadId, record.turnId);
    const waiters = turnCompletionWaiters.get(key);
    if (!waiters) return;
    turnCompletionWaiters.delete(key);
    const snapshot = snapshotTurnRecord(record);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(snapshot);
    }
  }

  function resolveAllTurnCompletionWaitersOnClose() {
    for (const [key, waiters] of turnCompletionWaiters) {
      const [threadId, turnId] = key.split('\u0000');
      const record = turnRecords.get(key) ?? { threadId, turnId };
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(snapshotTurnRecord(record, { closed: true }));
      }
    }
    turnCompletionWaiters.clear();
  }

  function recordAgentMessage(threadId, turnId, message) {
    if (!threadId || !turnId) return;
    const extracted = extractAgentMessageText(message);
    if (!extracted?.text) return;
    const record = getTurnRecord(threadId, turnId);
    if (extracted.mode === 'append') {
      record.deltaText += extracted.text;
    } else {
      record.finalText = extracted.text;
    }
  }

  function completeTurn(threadId, turnId) {
    if (!threadId || !turnId) return;
    const record = getTurnRecord(threadId, turnId);
    record.completed = true;
    record.completedAt = new Date().toISOString();
    resolveTurnCompletionWaiters(record);
  }

  function updateThreadStateFromNotification(message) {
    const params = message.params ?? {};
    const threadId = params.threadId;
    if (!threadId) return;
    const state = getThreadState(threadStates, threadId);

    if (message.method === 'turn/started') {
      state.activeTurnId = params.turn?.id ?? null;
      if (state.activeTurnId) getTurnRecord(threadId, state.activeTurnId);
      state.status = { type: 'active' };
      return;
    }

    const notificationTurnId = params.turn?.id ?? params.turnId ?? state.activeTurnId ?? null;
    recordAgentMessage(threadId, notificationTurnId, message);

    if (message.method === 'turn/completed') {
      const completedTurnId = params.turn?.id ?? params.turnId ?? state.activeTurnId ?? null;
      completeTurn(threadId, completedTurnId);
      if (!completedTurnId || state.activeTurnId === completedTurnId) {
        state.activeTurnId = null;
      }
      state.status = { type: 'idle' };
      return;
    }
    if (message.method === 'thread/status/changed') {
      state.status = params.status ?? { type: 'unknown' };
      if (params.status?.type === 'idle') {
        state.activeTurnId = null;
      }
      return;
    }
    if (message.method === 'thread/closed') {
      state.activeTurnId = null;
      state.status = { type: 'closed' };
    }
  }

  function handleMessage(message) {
    if (message && Object.hasOwn(message, 'id') && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    if (!isNotification(message)) return;
    updateThreadStateFromNotification(message);
    emitter.emit('notification', message);
  }

  const lineReader = createInterface({ input: childProcess.stdout });
  lineReader.on('line', (line) => {
    if (!line.trim()) return;
    try {
      handleMessage(JSON.parse(line));
    } catch (error) {
      emitter.emit('error', error);
    }
  });

  childProcess.stderr?.on?.('data', (chunk) => {
    emitter.emit('stderr', chunk.toString('utf8'));
  });

  childProcess.once?.('exit', (code, signal) => {
    closed = true;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`codex app-server exited: code=${code} signal=${signal}`));
    }
    pending.clear();
    resolveAllTurnCompletionWaitersOnClose();
    emitter.emit('exit', { code, signal });
  });

  childProcess.once?.('error', (error) => {
    closed = true;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    resolveAllTurnCompletionWaitersOnClose();
    emitter.emit('error', error);
  });

  function sendOnce(request, timeoutMs) {
    if (closed) {
      return Promise.reject(new Error('codex app-server client is closed'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new Error(`timeout waiting for response id=${request.id} method=${request.method}`));
      }, timeoutMs);
      pending.set(request.id, { resolve, reject, timer });
      const line = `${JSON.stringify(request)}\n`;
      trace(`[codex-app-server-client] request ${JSON.stringify(request)}`);
      childProcess.stdin.write(line, 'utf8');
    });
  }

  async function request(method, params = {}, options = {}) {
    const id = allocateId(options.id);
    const payload = { jsonrpc: '2.0', method, id, params };

    for (let attempt = 0; attempt <= backpressureRetries; attempt += 1) {
      const response = await sendOnce(payload, options.timeoutMs ?? requestTimeoutMs);
      if (!response.error) {
        return response.result ?? {};
      }
      const shouldRetry = response.error.code === -32001 && attempt < backpressureRetries;
      if (!shouldRetry) {
        throw new CodexAppServerRpcError(response.error, payload);
      }
      const waitMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0;
      if (waitMs > 0) {
        await delay(waitMs);
      }
    }
    throw new Error('unreachable retry state');
  }

  return {
    get child() {
      return childProcess;
    },

    on(eventName, handler) {
      emitter.on(eventName, handler);
      return this;
    },

    off(eventName, handler) {
      emitter.off(eventName, handler);
      return this;
    },

    async initialize({
      clientInfo = { name: 'xihe-ipc-hub', version: '0.5.0' },
      capabilities = { experimentalApi: true },
    } = {}) {
      return await request('initialize', { clientInfo, capabilities }, { id: 0 });
    },

    async threadStart(params = {}) {
      const result = await request('thread/start', params);
      const thread = result.thread ?? null;
      const threadId = result.threadId ?? thread?.id ?? null;
      if (threadId) {
        const state = getThreadState(threadStates, threadId);
        state.status = thread?.status ?? state.status;
      }
      return { ...result, threadId };
    },

    async threadResume(threadId, params = {}) {
      const result = await request('thread/resume', { threadId, ...params });
      return { ...result, threadId: result.threadId ?? result.thread?.id ?? threadId };
    },

    async threadRead(threadId) {
      const result = await request('thread/read', { threadId });
      const thread = result.thread ?? null;
      const resolvedThreadId = result.threadId ?? thread?.id ?? threadId;
      if (resolvedThreadId) {
        const state = getThreadState(threadStates, resolvedThreadId);
        if (thread?.status) {
          state.status = thread.status;
        }
      }
      return { ...result, threadId: resolvedThreadId };
    },

    threadStatus(threadId) {
      const state = threadStates.get(threadId);
      return {
        threadId,
        status: state?.status ?? { type: 'unknown' },
        activeTurnId: state?.activeTurnId ?? null,
      };
    },

    async turnStart(threadId, input, params = {}) {
      const result = await request('turn/start', { threadId, input: asInput(input), ...params });
      const turnId = result.turnId ?? result.turn?.id ?? null;
      if (turnId) {
        const state = getThreadState(threadStates, threadId);
        state.activeTurnId = turnId;
        state.status = { type: 'active' };
      }
      return { ...result, turnId };
    },

    waitForTurnCompleted(threadId, turnId, { timeoutMs = requestTimeoutMs } = {}) {
      if (!threadId || !turnId) {
        return Promise.resolve({
          threadId: threadId ?? null,
          turnId: turnId ?? null,
          completed: false,
          completedAt: null,
          lastAgentMessage: '',
          timedOut: false,
        });
      }

      const record = getTurnRecord(threadId, turnId);
      if (record.completed) {
        return Promise.resolve(snapshotTurnRecord(record));
      }

      return new Promise((resolve) => {
        const key = turnKey(threadId, turnId);
        const waiters = turnCompletionWaiters.get(key) ?? new Set();
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) turnCompletionWaiters.delete(key);
          resolve(snapshotTurnRecord(record, { timedOut: true }));
        }, timeoutMs);
        timer.unref?.();
        const waiter = { resolve, timer };
        waiters.add(waiter);
        turnCompletionWaiters.set(key, waiters);
      });
    },

    async turnSteer(threadId, expectedTurnId, input, params = {}) {
      return await request('turn/steer', {
        threadId,
        expectedTurnId,
        input: asInput(input),
        ...params,
      });
    },

    async turnInterrupt(threadId, turnId = null, params = {}) {
      return await request('turn/interrupt', {
        threadId,
        ...(turnId ? { turnId } : {}),
        ...params,
      });
    },

    async threadInjectItems(threadId, items) {
      if (!Array.isArray(items)) {
        throw new InvalidInjectItemSchemaError('items must be an array');
      }
      items.forEach((item, index) => validateInjectItemSchema(item, index));
      return await request('thread/inject_items', { threadId, items });
    },

    async threadUnsubscribe(threadId) {
      return await request('thread/unsubscribe', { threadId });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const [, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('codex app-server client closed'));
      }
      pending.clear();
      resolveAllTurnCompletionWaitersOnClose();
      lineReader.close();
      try {
        childProcess.stdin?.end?.();
      } catch {}
      try {
        childProcess.kill?.('SIGTERM');
      } catch {}
    },
  };
}
