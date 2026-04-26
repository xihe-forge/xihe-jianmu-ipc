import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAtomicHandoverTrigger,
  createContextUsageAutoHandover,
  createMinimalTaskUnitCompleteChecker,
  estimateContextPctFromTranscript,
  hasInFlightCodexTask,
} from '../lib/context-usage-auto-handover.mjs';

function makeAuto(options = {}) {
  let nowValue = options.now ?? 1_000_000;
  const calls = { estimate: 0, trigger: 0 };
  const auto = createContextUsageAutoHandover({
    estimateContextPct: async () => {
      calls.estimate += 1;
      if (options.estimateThrows) throw new Error('estimate failed');
      return options.pct ?? 75;
    },
    isMinimalTaskUnitComplete: () => options.complete ?? true,
    triggerHandover: async () => {
      calls.trigger += 1;
      if (options.triggerThrows) throw new Error('trigger failed');
      return { handover: 'ok' };
    },
    cooldownMs: 1_000,
    now: () => nowValue,
  });
  return {
    auto,
    calls,
    advance: (ms) => {
      nowValue += ms;
    },
  };
}

test('pct <= 50 does not trigger', async () => {
  const { auto, calls } = makeAuto({ pct: 50 });

  assert.deepEqual(await auto.tick(), { skipped: 'under-threshold', pct: 50 });
  assert.equal(calls.trigger, 0);
});

test('pct > 50 + task in progress skips task-in-progress', async () => {
  const { auto, calls } = makeAuto({ pct: 51, complete: false });

  assert.deepEqual(await auto.tick(), { skipped: 'task-in-progress', pct: 51 });
  assert.equal(calls.trigger, 0);
});

test('pct > 50 + minimal task complete triggers handover', async () => {
  const { auto, calls } = makeAuto({ pct: 80, complete: true });

  assert.deepEqual(await auto.tick(), { triggered: true, pct: 80, handover: 'ok' });
  assert.equal(calls.trigger, 1);
});

test('cooldown prevents repeat handover inside window', async () => {
  const { auto, calls } = makeAuto({ pct: 80, complete: true });

  await auto.tick();
  assert.deepEqual(await auto.tick(), { skipped: 'cooldown' });
  assert.equal(calls.trigger, 1);
});

test('cooldown allows repeat handover after window', async () => {
  const { auto, calls, advance } = makeAuto({ pct: 80, complete: true });

  await auto.tick();
  advance(1_001);
  assert.equal((await auto.tick()).triggered, true);
  assert.equal(calls.trigger, 2);
});

test('estimateContextPct throw is swallowed by tick', async () => {
  const { auto, calls } = makeAuto({ estimateThrows: true });

  const result = await auto.tick();
  assert.equal(result.skipped, 'estimate-failed');
  assert.match(result.error, /estimate failed/);
  assert.equal(calls.trigger, 0);
});

test('tick passes sessionRecord into estimateContextPct', async () => {
  const sessionRecord = { name: 'jianmu-pm', pid: 1777 };
  let estimatedSessionRecord = null;
  const auto = createContextUsageAutoHandover({
    threshold: 50,
    estimateContextPct: async (record) => {
      estimatedSessionRecord = record;
      return 51;
    },
    isMinimalTaskUnitComplete: () => true,
    triggerHandover: async () => ({ handover: 'ok' }),
    now: () => 1_000_000,
  });

  assert.equal((await auto.tick(sessionRecord)).triggered, true);
  assert.equal(estimatedSessionRecord, sessionRecord);
});

test('triggerHandover throw does not update cooldown timestamp', async () => {
  const { auto, calls } = makeAuto({ triggerThrows: true });

  const first = await auto.tick();
  const second = await auto.tick();
  assert.equal(first.skipped, 'trigger-failed');
  assert.equal(second.skipped, 'trigger-failed');
  assert.equal(calls.trigger, 2);
});

test('minimal task unit complete when ipc queue and git tree are clean', () => {
  const checker = createMinimalTaskUnitCompleteChecker({
    getPendingOutgoingCount: () => 0,
    isGitTreeClean: () => true,
    hasInFlightCodexTask: () => true,
  });

  assert.equal(checker(), true);
});

test('minimal task unit complete when ipc queue and codex tasks are idle', () => {
  const checker = createMinimalTaskUnitCompleteChecker({
    getPendingOutgoingCount: () => 0,
    isGitTreeClean: () => false,
    hasInFlightCodexTask: () => false,
  });

  assert.equal(checker(), true);
});

test('minimal task unit incomplete when only one of three core signals passes', () => {
  const checker = createMinimalTaskUnitCompleteChecker({
    getPendingOutgoingCount: () => 2,
    isGitTreeClean: () => true,
    hasInFlightCodexTask: () => true,
  });

  assert.equal(checker(), false);
});

test('codex task signal detects in-flight files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runs-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ status: 'in-flight' }));
    assert.equal(hasInFlightCodexTask(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript estimator uses last usage and clamps percent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
  try {
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { usage: { input_tokens: 20_000 } } }),
        JSON.stringify({ usage: { input_tokens: 220_000, cache_read_input_tokens: 10_000 } }),
      ].join('\n'),
    );

    assert.equal(estimateContextPctFromTranscript(transcriptPath, { contextWindow: 200_000 }), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript estimator safely returns 0 for missing transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-missing-'));
  try {
    assert.equal(estimateContextPctFromTranscript(join(dir, 'missing.jsonl')), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript estimator safely returns 0 for unreadable transcript path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-unreadable-'));
  try {
    assert.equal(estimateContextPctFromTranscript(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript estimator falls back to bytes/4 and clamps at 100%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-byte-100-'));
  try {
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, 'x'.repeat(800_000));

    assert.equal(estimateContextPctFromTranscript(transcriptPath, { contextWindow: 200_000 }), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript estimator falls back to bytes/4 at 50% threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-byte-50-'));
  try {
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, 'x'.repeat(400_000));

    assert.equal(estimateContextPctFromTranscript(transcriptPath, { contextWindow: 200_000 }), 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex task signal treats empty reports directory as idle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runs-empty-'));
  try {
    mkdirSync(join(dir, 'nested'));
    assert.equal(hasInFlightCodexTask(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic handover dryRun logs pre-spawn-review and does not rename or spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-dry-run-'));
  try {
    const calls = { rename: 0, spawn: 0, notify: [] };
    const logs = [];
    const trigger = createAtomicHandoverTrigger({
      name: 'jianmu-pm',
      cwd: dir,
      handoverDir: dir,
      now: () => 1_777_232_746_089,
      dryRun: true,
      stderr: (line) => logs.push(line),
      notifyPreSpawnReview: async (review) => calls.notify.push(review),
      renameSession: async () => {
        calls.rename += 1;
        return { ok: true };
      },
      spawnSession: async () => {
        calls.spawn += 1;
        return { spawned: true };
      },
    });

    const result = await trigger();

    assert.equal(result.dryRun, true);
    assert.equal(calls.rename, 0);
    assert.equal(calls.spawn, 0);
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0].session, 'jianmu-pm');
    assert.equal(calls.notify[0].primarySpawn.host, 'vscode-terminal');
    assert.equal(calls.notify[0].fallbackSpawn.host, 'wt');
    assert.ok(logs.some((line) => line.includes('pre-spawn-review dry-run')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

