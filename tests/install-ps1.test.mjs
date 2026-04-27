import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installPs1 = readFileSync(new URL('../bin/install.ps1', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

test('package.json runs install.ps1 from npm postinstall without failing non-Windows installs', () => {
  assert.equal(
    packageJson.scripts.postinstall,
    'powershell -ExecutionPolicy Bypass -File bin/install.ps1 || true',
  );
});

test('install.ps1 detects installed PS5 and PS7 binaries separately', () => {
  assert.match(
    installPs1,
    /'PS5'\s*=\s*Test-Path "\$env:WINDIR\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/,
  );
  assert.match(
    installPs1,
    /'PS7'\s*=\s*\(Test-Path "\$env:ProgramFiles\\PowerShell\\7\\pwsh\.exe"\)\s*-or\s*\(Test-Path "\$env:ProgramFiles\\PowerShell\\7-preview\\pwsh\.exe"\)/,
  );
});

test('install.ps1 maps PS5 and PS7 to distinct profile paths', () => {
  assert.match(installPs1, /\$profilesToInstall\s*=\s*@\(\)/);
  assert.match(
    installPs1,
    /\$profilesToInstall \+= "\$env:USERPROFILE\\Documents\\WindowsPowerShell\\Microsoft\.PowerShell_profile\.ps1"/,
  );
  assert.match(
    installPs1,
    /\$profilesToInstall \+= "\$env:USERPROFILE\\Documents\\PowerShell\\Microsoft\.PowerShell_profile\.ps1"/,
  );
  assert.match(installPs1, /if \(\$shells\['PS5'\]\)/);
  assert.match(installPs1, /if \(\$shells\['PS7'\]\)/);
});

test('install.ps1 exits with a clear error when no PowerShell binary is detected', () => {
  assert.match(installPs1, /if \(\$profilesToInstall\.Count -eq 0\)/);
  assert.match(installPs1, /Write-Error "No PowerShell installed\. Install PowerShell 5 or 7\+: https:\/\/aka\.ms\/powershell"/);
  assert.match(installPs1, /exit 1/);
});

test('install.ps1 installs ipc and ipcx idempotently for each selected profile', () => {
  assert.match(installPs1, /foreach \(\$p in \$profilesToInstall\)/);
  assert.match(
    installPs1,
    /Select-String -Path \$p -Pattern '\^function ipc\\s\*\\\{' -Quiet -ErrorAction SilentlyContinue/,
  );
  assert.match(
    installPs1,
    /Add-Content -Path \$p -Value "`n\$funcCode"/,
  );
  assert.match(
    installPs1,
    /Select-String -Path \$p -Pattern '\^function ipcx' -Quiet -ErrorAction SilentlyContinue/,
  );
  assert.match(
    installPs1,
    /Add-Content -Path \$p -Value "`n\$ipcxFuncCode"/,
  );
});

test('install.ps1 reports selected profiles and detected shells', () => {
  assert.match(installPs1, /Write-Output "Installed to: \$\(\$profilesToInstall -join ', '\)"/);
  assert.match(installPs1, /Write-Output "Detected: PS5=\$\(\$shells\['PS5'\]\) PS7=\$\(\$shells\['PS7'\]\)"/);
});
