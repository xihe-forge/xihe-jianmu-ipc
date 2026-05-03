# Jianmu IPC Codex Plugin

## Quickstart

Install the plugin:

```bash
codex plugin install xihe-forge/jianmu-ipc
```

Start the hub:

```bash
npx @xihe-forge/jianmu-ipc start
```

P1 note: the `npx` command depends on `@xihe-forge/jianmu-ipc` being published to npm.

Verify inside Codex:

```text
ipc_whoami()
```

Expected result: the response shows the active session name, normally `codex-main` unless `IPC_NAME` or `IPC_DEFAULT_NAME` was overridden.

## What This Plugin Bundles

- `./.mcp.json`: registers the Jianmu IPC MCP server with `node ./mcp-server.mjs`.
- `./skills/`: teaches Codex when to use `ipc_send`, `ipc_recent_messages`, and `ipc_subscribe`.
- No hooks in v0.1; lifecycle automation is intentionally deferred.
