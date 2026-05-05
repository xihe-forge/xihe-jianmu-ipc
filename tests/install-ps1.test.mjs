import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installPs1 = readFileSync(new URL('../bin/install.ps1', import.meta.url), 'utf8');
const installPs1Path = fileURLToPath(new URL('../bin/install.ps1', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function extractHereStringVar(name) {
  const match = installPs1.match(new RegExp(`\\$${name}\\s*=\\s*@"\\r?\\n([\\s\\S]*?)\\r?\\n"@`));
  assert.ok(match, `${name} here-string should exist`);
  return match[1];
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}

function makeTempInstallEnv(tempRoot) {
  const appData = join(tempRoot, 'AppData', 'Roaming');
  const userProfile = join(tempRoot, 'Users', 'test-user');
  mkdirSync(appData, { recursive: true });
  mkdirSync(userProfile, { recursive: true });

  return {
    appData,
    env: {
      ...process.env,
      APPDATA: appData,
      USERPROFILE: userProfile,
    },
    settingsPath: join(appData, 'Code', 'User', 'settings.json'),
  };
}

function runInstallPs1(env) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installPs1Path],
    { encoding: 'utf8', env },
  );

  if (result.error) {
    throw result.error;
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function readSettingsJson(settingsPath) {
  return JSON.parse(stripBom(readFileSync(settingsPath, 'utf8')));
}

function withTempInstallEnv(fn) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jianmu-install-ps1-'));
  try {
    return fn(makeTempInstallEnv(tempRoot));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('install.ps1 defines ipcx codex session function', () => {
  assert.match(installPs1, /function ipcx\s*\{/);
  assert.match(installPs1, /codex-title-wrapper\.mjs/);
  assert.match(installPs1, /--dangerously-bypass-approvals-and-sandbox/);
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

test('install.ps1 ipcx launches Codex from xiheAi root with balanced location restore', () => {
  const ipcxFunc = extractHereStringVar('ipcxFuncCode');

  assert.match(ipcxFunc, /\$projectRoot = 'D:\\workspace\\ai\\research\\xiheAi'/);
  assert.match(ipcxFunc, /Push-Location `?\$projectRoot/);
  assert.match(ipcxFunc, /try\s*\{/);
  assert.match(ipcxFunc, /finally\s*\{\s*Pop-Location\s*\}/);
});

test('install.ps1 ipcx runs Codex through the title wrapper with IPC_NAME in env and config', () => {
  const ipcxFunc = extractHereStringVar('ipcxFuncCode');

  assert.match(ipcxFunc, /\$env:IPC_NAME = `?\$Name/);
  assert.match(ipcxFunc, /\$wrapper = 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc\\bin\\codex-title-wrapper\.mjs'/);
  assert.match(ipcxFunc, /\$codexBin = "`?\$env:APPDATA\\npm\\codex\.cmd"/);
  assert.match(ipcxFunc, /& `?\$node `?\$wrapper `?\$codexBin --dangerously-bypass-approvals-and-sandbox/);
  assert.match(ipcxFunc, /mcp_servers\.jianmu-ipc\.env\.IPC_NAME=``"`\$Name``""/);
});

test('install.ps1 ipcx marks Codex runtime in parent env and MCP config', () => {
  const ipcxFunc = extractHereStringVar('ipcxFuncCode');

  assert.match(ipcxFunc, /\$env:IPC_RUNTIME = 'codex'/);
  assert.match(ipcxFunc, /mcp_servers\.jianmu-ipc\.env\.IPC_RUNTIME=``"codex``""/);
});

test('install.ps1 ipc parses optional -resume through remaining arguments', () => {
  const ipcFunc = extractHereStringVar('funcCode');

  assert.match(ipcFunc, /ValueFromRemainingArguments=`\$true/);
  assert.match(ipcFunc, /\[object\[\]\]`\$rest/);
  assert.match(ipcFunc, /\[switch\]`\$resume/);
  assert.match(ipcFunc, /\$resumeValue = '0'/);
  assert.match(ipcFunc, /\$resumeValue -match '\^\\d\+`\$'/);
  assert.match(ipcFunc, /\$index = \[int\]`\$resumeValue/);
  assert.match(ipcFunc, /-replace '\[\/\\\\\]'/);
  assert.match(ipcFunc, /function Get-IpcSessionJsonls/);
  assert.match(ipcFunc, /"ipc_name=`\$Name"/);
  assert.match(ipcFunc, /Get-Command rg -ErrorAction SilentlyContinue/);
  assert.match(ipcFunc, /--files-with-matches/);
  assert.match(ipcFunc, /--fixed-strings/);
  assert.match(ipcFunc, /Select-String -Path `\$jsonl\.FullName -Pattern `\$markers -SimpleMatch -Quiet/);
  assert.match(ipcFunc, /\$jsonlFiles = @\(Get-IpcSessionJsonls -Name `\$Name -JsonlDir `\$jsonlDir\)/);
  assert.match(ipcFunc, /Sort-Object LastWriteTime -Descending/);
  assert.match(ipcFunc, /has no historical session/);
  assert.match(ipcFunc, /out of range for IPC name/);
  assert.match(ipcFunc, /\$claudeArgs \+= @\('--resume', `\$sessionId\)/);
  assert.match(ipcFunc, /\$claudeArgs \+= @\('--resume', `\$resumeValue\)/);
});

test('install.ps1 ipc rejects old negative -resume indexes clearly', () => {
  const ipcFunc = extractHereStringVar('funcCode');

  assert.match(ipcFunc, /\$resumeValue -match '\^-\\d\+`\$'/);
  assert.match(
    ipcFunc,
    /-resume `\$resumeValue is not supported\. Use -resume 0 for latest, -resume 1 for HEAD~1\./,
  );
  assert.match(
    ipcFunc,
    /Negative indexes like -1 are not supported; use 0 for latest\./,
  );
});

test('package.json publishes the Codex title wrapper used by ipcx', () => {
  assert.ok(packageJson.files.includes('bin/codex-title-wrapper.mjs'));
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
    /Select-String -Path \$p -Pattern 'ValueFromRemainingArguments' -Quiet -ErrorAction SilentlyContinue/,
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

test('install.ps1 patches VSCode tab settings without overwriting existing settings', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell is required for install.ps1 behavior tests');
    return;
  }
  if (process.env.IPC_SKIP_POWERSHELL_SPAWN_TESTS === '1') {
    t.skip('PowerShell child process spawning is blocked in this sandbox');
    return;
  }

  withTempInstallEnv(({ env, settingsPath }) => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ 'workbench.colorTheme': 'Default Dark Modern' }, null, 2),
      'utf8',
    );

    const firstOutput = runInstallPs1(env);
    const firstSettings = readSettingsJson(settingsPath);
    assert.equal(firstSettings['workbench.colorTheme'], 'Default Dark Modern');
    assert.equal(firstSettings['terminal.integrated.tabs.title'], '${sequence}');
    assert.equal(firstSettings['terminal.integrated.tabs.description'], '${sequence}');
    assert.match(firstOutput, /VSCode settings\.json patched/);

    const secondOutput = runInstallPs1(env);
    const secondSettings = readSettingsJson(settingsPath);
    assert.deepEqual(secondSettings, firstSettings);
    assert.match(secondOutput, /VSCode settings\.json already has tabs\.title \+ tabs\.description, skip/);
  });

  withTempInstallEnv(({ env, settingsPath }) => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ 'terminal.integrated.tabs.title': '${cwd}' }, null, 2),
      'utf8',
    );

    runInstallPs1(env);
    const settings = readSettingsJson(settingsPath);
    assert.equal(settings['terminal.integrated.tabs.title'], '${cwd}');
    assert.equal(settings['terminal.integrated.tabs.description'], '${sequence}');
  });
});

test('install.ps1 skips missing or unparsable VSCode settings without failing install', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell is required for install.ps1 behavior tests');
    return;
  }
  if (process.env.IPC_SKIP_POWERSHELL_SPAWN_TESTS === '1') {
    t.skip('PowerShell child process spawning is blocked in this sandbox');
    return;
  }

  withTempInstallEnv(({ env, settingsPath }) => {
    const output = runInstallPs1(env);
    assert.match(output, /VSCode settings\.json not found at .+settings\.json, skip/);
    assert.throws(() => readFileSync(settingsPath, 'utf8'));
  });

  withTempInstallEnv(({ env, settingsPath }) => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const invalidJson = '{\n  // VSCode JSONC comments are not rewritten by install.ps1\n  "workbench.colorTheme": "Default Dark Modern"\n}\n';
    writeFileSync(settingsPath, invalidJson, 'utf8');

    const output = runInstallPs1(env);
    assert.match(output, /Could not parse VSCode settings\.json at[\s\S]+settings\.json, skip/);
    assert.equal(readFileSync(settingsPath, 'utf8'), invalidJson);
  });
});
