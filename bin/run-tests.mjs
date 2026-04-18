import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function runFile(filePath) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [filePath], {
      stdio: 'inherit',
    });

    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`test runner terminated by signal ${signal}: ${filePath}`));
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`test runner exited with code ${code}: ${filePath}`));
        return;
      }
      resolveRun();
    });
  });
}

async function runFiles(files, concurrency) {
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= files.length) {
        return;
      }

      await runFile(files[currentIndex]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, files.length));
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error('usage: node bin/run-tests.mjs <dir> [<dir> ...]');
  }

  const files = [];
  for (const target of targets) {
    files.push(...await collectTestFiles(resolve(target)));
  }

  const concurrency = Number.parseInt(process.env.IPC_TEST_CONCURRENCY ?? '4', 10);
  await runFiles(files, Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 4);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
});
