# Jianmu IPC Usage

Use Jianmu IPC when work spans more than one AI session or runtime and needs explicit coordination:

- Cross-session handoff: assign work to a named session and ask it to reply.
- Asynchronous messages: send now, let the target drain backlog later.
- Status synchronization: publish progress, blockers, and completion state.
- Topic routing: subscribe to shared channels for build, deploy, review, or alert events.

## Basics

Check identity first:

```text
ipc_whoami()
```

Send a direct message:

```text
ipc_send(to="worker-a", content="Run the focused auth tests and report failures.")
```

Read recent backlog:

```text
ipc_recent_messages(since=3600000, limit=20)
```

Subscribe to a topic:

```text
ipc_subscribe(topic="build-events", action="subscribe")
```

Publish to a topic:

```text
ipc_send(to="*", topic="build-events", content="frontend build started")
```

## Examples

Task dispatch:

```text
ipc_send(
  to="reviewer",
  content="Review the README plugin install section and reply with concrete issues only."
)
```

Status report:

```text
ipc_send(
  to="jianmu-pm",
  content="plugin manifest files are written; running JSON lint and node --test next."
)
```

Emergency alert:

```text
ipc_subscribe(topic="alerts", action="subscribe")
ipc_send(
  to="*",
  topic="alerts",
  content="baseline tests regressed; stop dependent work until the failure is triaged."
)
```

## Operating Notes

- Prefer stable lowercase session names such as `codex-main`, `reviewer`, or `tester-a`.
- Use direct messages for ownership and topics for shared event streams.
- On reconnect or handoff, call `ipc_recent_messages` before starting new work.
- Reply through `ipc_send` when the sender asks for confirmation or a result.
- Keep messages short, actionable, and explicit about expected next action.
