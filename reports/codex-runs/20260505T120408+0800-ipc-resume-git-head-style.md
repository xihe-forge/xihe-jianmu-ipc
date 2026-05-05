# ipc -resume HEAD~N style

## Scope

- Repo: `xihe-jianmu-ipc`
- File: `bin/install.ps1`
- Target: `ipc` PowerShell function
- ship-tier: `e2e-partial 8/28`

## Design

旧设计来自 `dc57aad`：`-resume -1` 表示最新，`-resume -2` 表示次新，按 array reverse index 思路映射 jsonl 倒序列表。

新设计改为 git `HEAD~N` 习惯：

- `ipc <name>`: fresh session
- `ipc <name> -resume`: latest, equivalent to `HEAD~0`
- `ipc <name> -resume 0`: latest
- `ipc <name> -resume 1`: previous session, `HEAD~1`
- `ipc <name> -resume 2`: previous previous session, `HEAD~2`
- `ipc <name> -resume <GUID>`: direct session id

负数写法删除：`-resume -1` / `-resume -2` 不再支持。`dc57aad` 刚 ship，直接 fix-forward，避免两套索引习惯并存。

## PowerShell Implementation

真测结论：

- `[string]$resume` 在 PS5 对 `ipc test-name -resume` 报 `Missing an argument for parameter 'resume'`
- `[switch]$resume` + `[Parameter(ValueFromRemainingArguments=$true)][object[]]$rest` 在 PS5/PS7 都可解析：
  - no `-resume`
  - bare `-resume`
  - `-resume 0`
  - `-resume 1`
  - `-resume -1`

实现采用 `[switch]$resume` + `$rest`。bare `-resume` 默认 `$resumeValue = '0'`。数字按 jsonl `LastWriteTime -Descending` 后的 0-based index 取 session id。GUID 直接透传给 Claude `--resume`。

同时修正 encoded cwd slash regex：PowerShell 实测 `-replace '[\\/]'` 不替换 Windows `\`，改为 `-replace '[/\\]'`，确保路径为 `D--workspace-ai-research-xiheAi`。

## Dogfood Truth Table

环境：

- jsonl dir: `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi`
- jsonl count: `242`
- index 0: `39344cfb-d5fd-4e1f-9173-b9dc514eda37`
- index 1: `80f9b835-55d7-439b-8d86-f2b2c0fd2bcd`
- index 2: `f9ca8eeb-6098-49f4-bf16-c94537497d3b`

| Case | PS5 | PS7 | Truth |
| --- | --- | --- | --- |
| `ipc test-name` | PASS | PASS | fresh, no `--resume` |
| `ipc test-name -resume` | PASS | PASS | `--resume 39344cfb-d5fd-4e1f-9173-b9dc514eda37` |
| `ipc test-name -resume 0` | PASS | PASS | same as bare `-resume` |
| `ipc test-name -resume 1` | PASS | PASS | `--resume 80f9b835-55d7-439b-8d86-f2b2c0fd2bcd` |
| `ipc test-name -resume 2` | PASS | PASS | `--resume f9ca8eeb-6098-49f4-bf16-c94537497d3b` |
| `ipc test-name -resume <GUID>` | PASS | PASS | direct GUID passthrough |
| `ipc test-name -resume 9999` | PASS | PASS | clear out-of-range error |
| `ipc test-name -resume -1` | PASS | PASS | clear negative unsupported error |

## Verification

- PASS: PS5 binding probe confirms `[string]$resume` cannot support bare `-resume`
- PASS: PS5 dogfood 8 cases
- PASS: PS7 dogfood 8 cases
- PASS: static Node assertions for `bin/install.ps1`
- PASS: `node --check bin\claude-stdin-auto-accept.mjs`
- BLOCKED: `node --test tests/install-ps1.test.mjs` fails before assertions with Node test runner `spawn EPERM`
- BLOCKED: `node --test` fails for all discovered test files with Node test runner `spawn EPERM`

## Ship

- Commit: BLOCKED, `.git/index.lock` creation denied by sandbox while running `git add`
- Push status: NOT RUN, no commit was created
- EXIT: 1
