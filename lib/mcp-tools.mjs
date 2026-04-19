import {
  getObservationDetail as getObservationDetailDefault,
  recallObservations as recallObservationsDefault,
} from './observation-query.mjs';
import { createMessage } from './protocol.mjs';

// 13 个 MCP 工具定义。保持与现有行为和 schema 一致。
export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'ipc_send',
    description:
      "Send a message to another Claude Code session by name, or broadcast to all with '*'",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: "Target session name, or '*' for broadcast",
        },
        content: {
          type: 'string',
          description: 'Message content',
        },
        topic: {
          type: 'string',
          description: 'Optional topic tag for pub/sub',
        },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'ipc_sessions',
    description: 'List all currently connected Claude Code sessions',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ipc_whoami',
    description: 'Show the current session name and connection status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ipc_subscribe',
    description:
      'Subscribe or unsubscribe to a topic channel. Messages sent with this topic will be delivered to all subscribers.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name to subscribe/unsubscribe' },
        action: {
          type: 'string',
          enum: ['subscribe', 'unsubscribe'],
          description: 'subscribe or unsubscribe',
        },
      },
      required: ['topic', 'action'],
    },
  },
  {
    name: 'ipc_spawn',
    description:
      'Spawn a new Claude Code session. Background mode runs a one-shot task and reports back via IPC. Interactive mode opens a new terminal window.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name for the new session' },
        task: { type: 'string', description: 'Task description or initial prompt for the session' },
        interactive: {
          type: 'boolean',
          description:
            'If true, opens a new terminal window. If false (default), runs in background.',
        },
        model: { type: 'string', description: 'Optional model override (e.g. claude-sonnet-4-6)' },
        host: {
          type: 'string',
          enum: ['wt', 'vscode-terminal', 'external'],
          default: 'external',
          description:
            'Spawn host: wt=Windows Terminal new tab / vscode-terminal=VSCode terminal / external=caller handles',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory for the spawned session. Defaults to caller process.cwd() for backward compatibility.',
        },
      },
      required: ['name', 'task'],
    },
  },
  {
    name: 'ipc_rename',
    description:
      "Change this session's IPC name. Disconnects and reconnects to Hub with the new name.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'New session name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ipc_reconnect',
    description:
      'Change the Hub address and/or port at runtime, then reconnect. Useful when the Hub moves to a different host or port without restarting the MCP server.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description:
            'New Hub host address (e.g. "192.168.1.10" or "127.0.0.1"). Omit to keep current.',
        },
        port: { type: 'number', description: 'New Hub port number. Omit to keep current.' },
      },
    },
  },
  {
    name: 'ipc_task',
    description:
      'Create, update, or list structured tasks. Actions: create (assign task to agent), update (change task status), list (query tasks)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'list'],
          description: 'Action to perform',
        },
        to: { type: 'string', description: 'Target agent name (required for create)' },
        title: { type: 'string', description: 'Task title (required for create)' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'number', description: 'Priority 1-5, default 3' },
        taskId: { type: 'string', description: 'Task ID (required for update)' },
        status: {
          type: 'string',
          enum: ['started', 'completed', 'failed', 'cancelled'],
          description: 'New status (required for update)',
        },
        agent: { type: 'string', description: 'Filter by assigned agent' },
        filterStatus: { type: 'string', description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results, default 20' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ipc_recent_messages',
    description:
      'Retrieve recent messages addressed to this session (or broadcast), persisted even if the session was offline or crashed. Use on cold-start to recover backlog from the dead period.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Session name to query backlog for. Omit to use current session.',
        },
        since: {
          type: 'number',
          description: 'Milliseconds ago to look back. Default 6h (21600000), max 7d.',
        },
        limit: { type: 'number', description: 'Max messages to return. Default 50, max 500.' },
      },
    },
  },
  {
    name: 'ipc_recall',
    description:
      'Query recent project observations from ~/.claude/project-state/<project>/observations.db, with optional filters for session, tool, tags, and keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project slug, "_portfolio", or "*" to search all project observation DBs',
        },
        since: {
          type: 'number',
          description:
            'Milliseconds lookback (<= 7d) or absolute epoch ms lower bound. Defaults to 24h when omitted.',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return, default 50, max 500',
        },
        ipc_name: {
          type: 'string',
          description: 'Optional IPC session name filter',
        },
        tool_name: {
          type: 'string',
          description: 'Optional tool name filter, such as Bash or Edit',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional AND-filtered observation tags',
        },
        keyword: {
          type: 'string',
          description: 'Optional FTS5 keyword query against tool_input/tool_output/tags',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'ipc_observation_detail',
    description:
      'Fetch a single observation row from a project observations.db by id, without truncating tool_input or tool_output.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project slug that owns the target observations.db',
        },
        id: {
          type: 'number',
          description: 'Observation row id from ipc_recall',
        },
      },
      required: ['project', 'id'],
    },
  },
  {
    name: 'ipc_register_session',
    description:
      'Create or update an entry in ~/.claude/sessions-registry.json through the Hub maintainer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'IPC session name to register',
        },
        role: {
          type: 'string',
          description: 'Optional role label for the session',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional project slug list',
        },
        access_scope: {
          type: 'string',
          description: 'Optional access scope. Common values: primary, dynamic, all.',
        },
        cold_start_strategy: {
          type: 'string',
          description: 'Optional cold-start strategy descriptor',
        },
        note: {
          type: 'string',
          description: 'Optional human note stored in the registry entry',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'ipc_update_session',
    description:
      'Update only the projects list for an existing entry in ~/.claude/sessions-registry.json through the Hub maintainer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'IPC session name to update',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement project slug list',
        },
      },
      required: ['name', 'projects'],
    },
  },
];

function isWsOpen(ws) {
  return ws?.readyState === 1;
}

function toTextResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function toJsonResult(payload, isError = false) {
  return toTextResult(JSON.stringify(payload), isError);
}

function getErrorMessage(err) {
  return err?.message ?? String(err);
}

function assertFunction(ctx, key) {
  if (typeof ctx[key] !== 'function') {
    throw new TypeError(`createMcpTools requires ctx.${key}()`);
  }
  return ctx[key];
}

function isValidSessionName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function isValidSpawnHost(host) {
  return host === 'wt' || host === 'vscode-terminal' || host === 'external';
}

function clampPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  return [
    ...new Set(
      value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * 创建可测试的 MCP 工具工厂。
 * 通过 ctx 注入网络、状态和副作用，避免直接 import entrypoint 时启动服务。
 */
export function createMcpTools(ctx) {
  const getSessionName = assertFunction(ctx, 'getSessionName');
  const setSessionName = assertFunction(ctx, 'setSessionName');
  const getHubHost = assertFunction(ctx, 'getHubHost');
  const setHubHost = assertFunction(ctx, 'setHubHost');
  const getHubPort = assertFunction(ctx, 'getHubPort');
  const setHubPort = assertFunction(ctx, 'setHubPort');
  const getWs = assertFunction(ctx, 'getWs');
  const disconnectWs = assertFunction(ctx, 'disconnectWs');
  const reconnect = assertFunction(ctx, 'reconnect');
  const getPendingOutgoingCount = assertFunction(ctx, 'getPendingOutgoingCount');
  const wsSend = assertFunction(ctx, 'wsSend');
  const httpGet = assertFunction(ctx, 'httpGet');
  const httpPost = assertFunction(ctx, 'httpPost');
  const httpPatch = assertFunction(ctx, 'httpPatch');
  const spawnSession = assertFunction(ctx, 'spawnSession');
  const stderrLog = typeof ctx.stderrLog === 'function' ? ctx.stderrLog : () => {};
  const recallObservations =
    typeof ctx.recallObservations === 'function'
      ? ctx.recallObservations
      : recallObservationsDefault;
  const getObservationDetail =
    typeof ctx.getObservationDetail === 'function'
      ? ctx.getObservationDetail
      : getObservationDetailDefault;
  const DEFAULT_RECENT_SINCE_MS = 6 * 60 * 60 * 1000;
  const MAX_RECENT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_RECENT_LIMIT = 50;
  const MAX_RECENT_LIMIT = 500;

  async function handleToolCall(name, args) {
    // ipc_send
    if (name === 'ipc_send') {
      const { to, content, topic } = args ?? {};
      if (!to || content === undefined || content === null) {
        return toTextResult('ipc_send requires "to" and "content"', true);
      }

      const message = createMessage({
        from: getSessionName(),
        to,
        content: String(content),
        topic: topic ?? null,
      });

      const ws = getWs();
      if (isWsOpen(ws)) {
        ws.send(JSON.stringify(message));
        return toJsonResult({ sent: true, id: message.id, via: 'ws' });
      }

      try {
        const result = await httpPost(`http://${getHubHost()}:${getHubPort()}/send`, {
          from: getSessionName(),
          to,
          content: String(content),
        });
        return toJsonResult({
          accepted: result?.accepted ?? false,
          id: result?.id ?? message.id,
          via: 'http',
          online: result?.online,
          buffered: result?.buffered,
        });
      } catch (err) {
        return toJsonResult(
          {
            delivered: false,
            error: getErrorMessage(err),
            via: 'http_failed',
          },
          true,
        );
      }
    }

    // ipc_sessions
    if (name === 'ipc_sessions') {
      try {
        const response = await httpGet(`http://${getHubHost()}:${getHubPort()}/health`);
        return toJsonResult(response.sessions ?? []);
      } catch (err) {
        stderrLog(`[ipc] ipc_sessions error: ${getErrorMessage(err)}\n`);
        return toTextResult(`Failed to fetch sessions: ${getErrorMessage(err)}`, true);
      }
    }

    // ipc_subscribe
    if (name === 'ipc_subscribe') {
      const { topic, action } = args ?? {};
      if (!topic || !action) {
        return toTextResult('ipc_subscribe requires "topic" and "action"', true);
      }
      if (action !== 'subscribe' && action !== 'unsubscribe') {
        return toTextResult('action must be "subscribe" or "unsubscribe"', true);
      }
      if (!isWsOpen(getWs())) {
        return toJsonResult({ ok: false, error: 'hub not connected' }, true);
      }
      wsSend({ type: action, topic });
      return toJsonResult({ action, topic, ok: true });
    }

    // ipc_whoami
    if (name === 'ipc_whoami') {
      return toJsonResult({
        name: getSessionName(),
        hub_connected: isWsOpen(getWs()),
        hub: `${getHubHost()}:${getHubPort()}`,
        pending_outgoing: getPendingOutgoingCount(),
      });
    }

    // ipc_spawn
    if (name === 'ipc_spawn') {
      const { name: sessionName, task, interactive, model, host, cwd } = args ?? {};
      if (!sessionName || !task) {
        return toTextResult('ipc_spawn requires "name" and "task"', true);
      }

      if (!isValidSessionName(sessionName)) {
        return toTextResult(
          `Invalid session name "${sessionName}": only letters, numbers, underscore and hyphen allowed`,
          true,
        );
      }

      if (host !== undefined && !isValidSpawnHost(host)) {
        return toTextResult(
          `Invalid host "${host}": must be one of wt, vscode-terminal, external`,
          true,
        );
      }

      try {
        const sessions = await httpGet(`http://${getHubHost()}:${getHubPort()}/sessions`);
        const existing =
          Array.isArray(sessions) && sessions.find((session) => session.name === sessionName);
        if (existing) {
          return toTextResult(
            `Session "${sessionName}" is already online. Use a different name or wait for it to disconnect.`,
            true,
          );
        }
      } catch {
        // Hub 不可达时保留原行为：继续尝试 spawn，由 Hub 在连接时拒绝重名。
      }

      try {
        const spawnArgs = {
          name: sessionName,
          task,
          interactive: !!interactive,
          model,
          cwd,
        };
        if (host !== undefined) {
          spawnArgs.host = host;
        }
        const result = await spawnSession(spawnArgs);
        return toJsonResult(result);
      } catch (err) {
        return toTextResult(`Failed to spawn session: ${getErrorMessage(err)}`, true);
      }
    }

    // ipc_rename
    if (name === 'ipc_rename') {
      const { name: newName } = args ?? {};
      if (!newName) {
        return toTextResult('ipc_rename requires "name"', true);
      }

      if (!isValidSessionName(newName)) {
        return toTextResult(
          `Invalid session name "${newName}": only letters, numbers, underscore and hyphen allowed`,
          true,
        );
      }

      const oldName = getSessionName();
      setSessionName(newName);
      disconnectWs();
      reconnect();

      stderrLog(`[ipc] renamed: ${oldName} → ${newName}\n`);
      return toJsonResult({ renamed: true, from: oldName, to: newName });
    }

    // ipc_reconnect
    if (name === 'ipc_reconnect') {
      const { host, port } = args ?? {};
      if (host === undefined && port === undefined) {
        return toTextResult('ipc_reconnect requires at least one of "host" or "port"', true);
      }

      const oldHub = `${getHubHost()}:${getHubPort()}`;
      if (host !== undefined) setHubHost(host);
      if (port !== undefined) setHubPort(Number(port));
      const newHub = `${getHubHost()}:${getHubPort()}`;

      disconnectWs();
      reconnect();

      stderrLog(`[ipc] reconnecting: ${oldHub} → ${newHub}\n`);
      return toJsonResult({
        reconnecting: true,
        from: oldHub,
        to: newHub,
        session: getSessionName(),
      });
    }

    // ipc_task
    if (name === 'ipc_task') {
      const {
        action,
        to,
        title,
        description,
        priority,
        taskId,
        status,
        agent,
        filterStatus,
        limit,
      } = args ?? {};
      if (!action) {
        return toTextResult('ipc_task requires "action"', true);
      }

      if (action === 'create') {
        if (!to || !title) {
          return toTextResult('ipc_task create requires "to" and "title"', true);
        }
        try {
          const result = await httpPost(`http://${getHubHost()}:${getHubPort()}/task`, {
            from: getSessionName(),
            to,
            title,
            description: description ?? '',
            priority: priority ?? 3,
          });
          return toJsonResult(result);
        } catch (err) {
          return toTextResult(`Failed to create task: ${getErrorMessage(err)}`, true);
        }
      }

      if (action === 'update') {
        if (!taskId || !status) {
          return toTextResult('ipc_task update requires "taskId" and "status"', true);
        }
        try {
          const result = await httpPatch(
            `http://${getHubHost()}:${getHubPort()}/tasks/${encodeURIComponent(taskId)}`,
            { status },
          );
          return toJsonResult(result);
        } catch (err) {
          return toTextResult(`Failed to update task: ${getErrorMessage(err)}`, true);
        }
      }

      if (action === 'list') {
        try {
          const params = new URLSearchParams();
          if (agent) params.set('agent', agent);
          if (filterStatus) params.set('status', filterStatus);
          params.set('limit', String(limit ?? 20));
          const result = await httpGet(
            `http://${getHubHost()}:${getHubPort()}/tasks?${params.toString()}`,
          );
          return toJsonResult(result);
        } catch (err) {
          return toTextResult(`Failed to list tasks: ${getErrorMessage(err)}`, true);
        }
      }

      return toTextResult(`Unknown action: ${action}`, true);
    }

    // ipc_recent_messages
    if (name === 'ipc_recent_messages') {
      const sessionName = args?.name || getSessionName();
      const since = clampPositiveInteger(args?.since, DEFAULT_RECENT_SINCE_MS, MAX_RECENT_SINCE_MS);
      const limit = clampPositiveInteger(args?.limit, DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT);

      try {
        const params = new URLSearchParams({
          name: sessionName,
          since: String(since),
          limit: String(limit),
        });
        const result = await httpGet(
          `http://${getHubHost()}:${getHubPort()}/recent-messages?${params.toString()}`,
        );
        return toJsonResult({
          messages: result?.messages ?? [],
          count: Array.isArray(result?.messages) ? result.messages.length : 0,
          since: result?.since ?? since,
          limit: result?.limit ?? limit,
        });
      } catch (err) {
        return toTextResult(`Failed to fetch recent messages: ${getErrorMessage(err)}`, true);
      }
    }

    // ipc_recall
    if (name === 'ipc_recall') {
      const project = typeof args?.project === 'string' ? args.project.trim() : '';
      if (!project) {
        return toJsonResult({ ok: false, error: 'project is required' }, true);
      }

      if (args?.tags !== undefined && args?.tags !== null && !Array.isArray(args.tags)) {
        return toJsonResult({ ok: false, error: 'tags must be an array of strings' }, true);
      }

      try {
        const result = recallObservations({
          project,
          since: args?.since ?? null,
          limit: clampPositiveInteger(args?.limit, 50, 500),
          ipc_name: typeof args?.ipc_name === 'string' ? args.ipc_name.trim() || null : null,
          tool_name: typeof args?.tool_name === 'string' ? args.tool_name.trim() || null : null,
          tags: normalizeStringArray(args?.tags),
          keyword: typeof args?.keyword === 'string' ? args.keyword.trim() || null : null,
        });
        return toJsonResult(result, result?.ok === false);
      } catch (err) {
        return toJsonResult(
          {
            ok: false,
            error: getErrorMessage(err),
            project,
          },
          true,
        );
      }
    }

    // ipc_observation_detail
    if (name === 'ipc_observation_detail') {
      const project = typeof args?.project === 'string' ? args.project.trim() : '';
      const id = Number(args?.id);
      if (!project) {
        return toJsonResult({ ok: false, error: 'project is required' }, true);
      }
      if (!Number.isFinite(id) || id <= 0) {
        return toJsonResult({ ok: false, error: 'id must be a positive number', project }, true);
      }

      try {
        const result = getObservationDetail({
          project,
          id: Math.trunc(id),
        });
        return toJsonResult(result, result?.ok === false);
      } catch (err) {
        return toJsonResult(
          {
            ok: false,
            error: getErrorMessage(err),
            project,
            id: Math.trunc(id),
          },
          true,
        );
      }
    }

    // ipc_register_session
    if (name === 'ipc_register_session') {
      const sessionName = typeof args?.name === 'string' ? args.name.trim() : '';
      if (!sessionName) {
        return toJsonResult({ ok: false, error: 'name is required' }, true);
      }
      if (
        args?.projects !== undefined &&
        args?.projects !== null &&
        !Array.isArray(args.projects)
      ) {
        return toJsonResult({ ok: false, error: 'projects must be an array of strings' }, true);
      }

      try {
        const payload = {
          name: sessionName,
          ...(args?.role !== undefined
            ? { role: typeof args.role === 'string' ? args.role.trim() || null : null }
            : {}),
          ...(args?.projects !== undefined
            ? { projects: normalizeStringArray(args.projects) }
            : {}),
          ...(args?.access_scope !== undefined
            ? {
                access_scope:
                  typeof args.access_scope === 'string' ? args.access_scope.trim() || null : null,
              }
            : {}),
          ...(args?.cold_start_strategy !== undefined
            ? {
                cold_start_strategy:
                  typeof args.cold_start_strategy === 'string'
                    ? args.cold_start_strategy.trim() || null
                    : null,
              }
            : {}),
          ...(args?.note !== undefined
            ? { note: typeof args.note === 'string' ? args.note.trim() || null : null }
            : {}),
          requested_by: getSessionName(),
        };
        const result = await httpPost(
          `http://${getHubHost()}:${getHubPort()}/registry/register`,
          payload,
        );
        return toJsonResult(result, result?.ok === false);
      } catch (err) {
        return toJsonResult(
          {
            ok: false,
            error: getErrorMessage(err),
            name: sessionName,
          },
          true,
        );
      }
    }

    // ipc_update_session
    if (name === 'ipc_update_session') {
      const sessionName = typeof args?.name === 'string' ? args.name.trim() : '';
      if (!sessionName) {
        return toJsonResult({ ok: false, error: 'name is required' }, true);
      }
      if (!Array.isArray(args?.projects)) {
        return toJsonResult({ ok: false, error: 'projects must be an array of strings' }, true);
      }

      try {
        const result = await httpPost(`http://${getHubHost()}:${getHubPort()}/registry/update`, {
          name: sessionName,
          projects: normalizeStringArray(args.projects),
          requested_by: getSessionName(),
        });
        return toJsonResult(result, result?.ok === false);
      } catch (err) {
        return toJsonResult(
          {
            ok: false,
            error: getErrorMessage(err),
            name: sessionName,
          },
          true,
        );
      }
    }

    return toTextResult(`Unknown tool: ${name}`, true);
  }

  return {
    tools: MCP_TOOL_DEFINITIONS,
    listTools() {
      return { tools: MCP_TOOL_DEFINITIONS };
    },
    handleToolCall,
  };
}
