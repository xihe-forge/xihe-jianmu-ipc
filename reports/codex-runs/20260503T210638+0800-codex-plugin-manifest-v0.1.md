# codex plugin manifest v0.1 ship report

**Time**: 2026-05-03T21:06:38+08  
**Repo**: xihe-jianmu-ipc  
**Scope**: local Codex plugin manifest only; no npm publish, MCP registry publish, marketplace submit, or awesome-codex-plugins PR.

## WebFetch Schema Truth

Primary source: <https://developers.openai.com/codex/plugins/build>

Local cross-check: `C:/Users/jolen/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`

Observed manifest shape:

- Required manifest entry: `.codex-plugin/plugin.json`
- Top-level fields used by the canonical sample: `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `skills`, `hooks`, `mcpServers`, `apps`, `interface`
- Component path convention: relative paths should begin with `./`
- `skills`: relative path to skill directories/files, commonly `./skills/`
- `mcpServers`: relative path to MCP config, commonly `./.mcp.json`
- `hooks`: relative hook config path; omitted in this v0.1 by request
- `apps`: relative app connector manifest path; omitted because this plugin does not bundle an app connector
- `interface` fields from the sample: `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`, `defaultPrompt`, `brandColor`, `composerIcon`, `logo`, `screenshots`
- `name` is described as a kebab-case plugin identifier with no spaces.

Current installed `codex plugin --help` only exposes `marketplace` subcommands (`add`, `upgrade`, `remove`) in this environment; the user-facing quickstart still follows the requested `codex plugin install xihe-forge/jianmu-ipc` entry.

## plugin.json Field Decisions

- `name`: `jianmu-ipc` because the schema says kebab-case identifier; `xihe-forge/jianmu-ipc` is kept as the install source in docs.
- `version`: `0.5.0`, synced with `package.json`.
- `description`: shortened to `Real-time IPC hub for multi-AI-agent communication.`
- `author`, `homepage`, `repository`, `license`: copied from `package.json`, normalized to manifest sample shape.
- `keywords`: copied from package intent plus `websocket`.
- `skills`: `./skills/`, official plugin-root path.
- `mcpServers`: `./.mcp.json`, official plugin-root path.
- `hooks`: omitted for v0.1 by request.
- `apps`: omitted; no app connector in this task.
- `interface`: included to keep marketplace/display metadata complete without adding assets.

MCP config in `./.mcp.json`:

- Server key: `jianmu-ipc`
- Command: `node`
- Args: `["./mcp-server.mjs"]`
- Env: `IPC_DEFAULT_NAME=codex-main`, `IPC_RUNTIME=codex`, `IPC_HUB_HOST=127.0.0.1`, `IPC_PORT=3179`

## Skill Markdown Outline

Files:

- `skills/jianmu-ipc-usage/SKILL.md`: canonical Codex skill layout.
- `.codex-plugin/skills/jianmu-ipc-usage.md`: AC-requested copy.

Outline:

- When to use: cross-session handoff, async messages, status sync, topic routing.
- Basics: `ipc_whoami`, `ipc_send`, `ipc_recent_messages`, `ipc_subscribe`, topic publish.
- Examples: task dispatch, status report, emergency alert.
- Operating notes: stable names, direct vs topic routing, backlog drain on reconnect, reply discipline.

## Acceptance Criteria

- AC1 `.codex-plugin/plugin.json` exists: PASS.
- AC1 schema fields complete for v0.1: PASS with `name/version/description/author/homepage/repository/license/keywords/skills/mcpServers/interface`; `hooks` and `apps` intentionally omitted.
- AC2 `.codex-plugin/skills/jianmu-ipc-usage.md` exists: PASS.
- AC2 examples >= 3: PASS; 3 named examples plus basic command snippets.
- AC2 <= 200 lines: PASS; 79 lines.
- AC3 `.codex-plugin/README.md` exists with quickstart: PASS.
- AC4 top README has Codex Plugin install entry: PASS; 4 lines under `## Codex Plugin`.
- AC5 JSON lint: PASS.
  - `node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json'))"`
  - `.mcp.json` JSON parse also PASS.
- AC6 `node --test`: FAIL in sandbox before assertions.
  - Result: 109 files failed, 0 passed, all with `Error: spawn EPERM` from Node test runner child-process spawn.
  - Follow-up `node bin/run-tests.mjs tests tests/integration tests/e2e`: partially ran 20 assertions PASS, then stopped at `tests/claude-stdin-auto-accept-multi-prompt.test.mjs` with the same `spawn EPERM`.
  - Interpretation: current environment blocks child-process spawn needed by the test harness; no manifest-related assertion failure was observed.

## Next Steps

- npm publish `@xihe-forge/jianmu-ipc@0.5.0` when boss token is available.
- MCP registry publish when registry token/auth flow is available.
- Submit Codex marketplace after boss confirms GitHub repo URL and desired install route.
- Optional v0.2: add hooks only after the no-hook manifest installs cleanly.
- Optional v0.2: add plugin assets (`composerIcon`, `logo`, screenshots) before marketplace submission.
- Re-run full `node --test` outside this sandbox or in CI where child-process spawn is permitted.
- Commit/push after `.git` write permission is restored. Current `.git` ACL denies writes for this sandbox user, so `git config`, `git add`, and commit cannot create lock files.

## EXIT

EXIT 1: implementation files are present and JSON lint passes, but AC6 could not pass in this sandbox because Node child-process spawn is denied. Commit/push also could not run because `.git` write operations are denied by filesystem ACL.
