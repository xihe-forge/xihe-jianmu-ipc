import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installPs1 = readFileSync(new URL('../bin/install.ps1', import.meta.url), 'utf8');

test('install.ps1 defines ipcx codex session function', () => {
  assert.match(installPs1, /function ipcx\s*\{/);
  assert.match(installPs1, /codex --dangerously-bypass-approvals-and-sandbox/);
  assert.match(installPs1, /mcp_servers\.jianmu-ipc\.env\.IPC_NAME/);
});

test('install.ps1 checks ipcx with exact line-start anchor', () => {
  assert.match(installPs1, /Select-String[\s\S]*-Pattern '\^function ipcx'/);
  assert.doesNotMatch(installPs1, /-Pattern 'function ipcx'/);
});

test('install.ps1 ipc check does not match ipcx', () => {
  assert.match(
    installPs1,
    /-Pattern '\^function ipc(?:\[\^x\]|\\s(?:\*\\\{)?)'/,
  );
  assert.doesNotMatch(installPs1, /-Pattern 'function ipc'/);
});

test('install.ps1 ipcx keeps nested TOML string quotes escaped', () => {
  assert.match(
    installPs1,
    /mcp_servers\.jianmu-ipc\.env\.IPC_NAME=``"`\$Name``""/,
  );
});
