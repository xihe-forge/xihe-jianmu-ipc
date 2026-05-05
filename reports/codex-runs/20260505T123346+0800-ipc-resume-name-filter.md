# ipc -resume IPC name filter

## Research

- A grep jsonl content: selected. Real transcript files do not encode IPC name in the GUID filename, but hook/system lines carry stable name markers such as `ipc_name=taiwei-director`.
- B parse jsonl head/system init env: rejected. Some real matches are not in the first lines; director marker was line 68 in the newest director transcript.
- C hub sessions mapping: rejected. Hub `/sessions` is live state and not a complete historical resume index.
- D `~/.claude/sessions-registry.json`: rejected. Registry maps names to roles/projects, not historical sessionId GUIDs.

## JSONL Marker Truth

- `taiwei-director`: newest matching transcript `476814b4-7676-4002-9c13-57e394badb0b.jsonl`, marker `ipc_name=taiwei-director` at line 68, mtime `2026-05-04T16:08:20`.
- `taiwei-tester`: newest matching transcript `12565678-37ff-43e7-9146-f76ecaad1298.jsonl`, marker `ipc_name=taiwei-tester` at line 95, mtime `2026-05-05T12:33:13`.
- CWD latest unrelated transcript was newer than director, so unfiltered mtime selection can resume the wrong IPC name.

## Implementation

- Added generated PowerShell helper `Get-IpcSessionJsonls -Name <name> -JsonlDir <dir>`.
- Helper searches exact markers: `ipc_name=<name>`, `IPC_NAME=<name>`, JSON spellings `ipc_name`, `ipcName`, `IPC_NAME`.
- Fast path uses `rg --files-with-matches --fixed-strings --glob '*.jsonl'`; fallback uses `Select-String -SimpleMatch`.
- `-resume 0/1/N` now indexes only matching jsonl files sorted by mtime descending.
- GUID resume and fresh launch paths are unchanged.
- Missing name now reports: `IPC name '<name>' has no historical session ... Use fresh: ipc <name>`.

## Dogfood

- PS5 fresh: PASS.
- PS5 director `-resume 0`: PASS, selected synthetic director latest.
- PS5 tester `-resume 0`: PASS, selected synthetic tester latest.
- PS5 director `-resume 1`: PASS, selected synthetic director previous.
- PS5 GUID: PASS, direct GUID passed through.
- PS5 out-of-range and missing-name: PASS, clear name-scoped errors.
- PS7 same 7 cases: PASS.
- Real jsonl marker scan: PASS, director and tester resolve to different sessionIds with matching `ipc_name=<name>` markers.
- `node tests/install-ps1.test.mjs`: 16/18 PASS; 2 existing tests failed because Node `spawnSync powershell.exe` is blocked by local EPERM. Direct PowerShell dogfood above covers the generated profile path.

## Ship

- ship-tier: e2e-partial 14/28.
- commit: blocked. `git add` failed because the sandbox denies writes under `.git` (`Unable to create .../.git/index.lock: Permission denied`); direct `.git` write probe also failed with access denied.
- push: blocked by commit failure.
- EXIT 0.
