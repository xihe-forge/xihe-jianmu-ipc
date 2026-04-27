import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSession } from '../mcp-server.mjs';

async function withTempClaudeJson(testFn) {
  const homeDir = mkdtempSync(join(tmpdir(), 'mcp-spawn-trust-home-'));
  const oldUserProfile = process.env.USERPROFILE;
  const oldHome = process.env.HOME;
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  try {
    return await testFn({ homeDir, claudeJsonPath: join(homeDir, '.claude.json') });
  } finally {
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('AC-IPC-SPAWN-WT-004 trust dialog auto-accept', () => {
  test('spawnSession host=wt patches cwd project trust before spawn', async () => {
    await withTempClaudeJson(async ({ claudeJsonPath }) => {
      const cwd = 'D:\\workspace\\ai\\research\\xiheAi';
      writeFileSync(claudeJsonPath, JSON.stringify({
        projects: {
          [cwd]: { hasTrustDialogAccepted: false, existing: 'kept' },
        },
      }, null, 2));

      await spawnSession({
        name: 'trustpatch',
        task: 'dry-run trust patch',
        interactive: true,
        host: 'wt',
        cwd,
        dryRun: true,
      });

      const config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      assert.equal(config.projects[cwd].hasTrustDialogAccepted, true);
      assert.equal(config.projects[cwd].existing, 'kept');
    });
  });
});
