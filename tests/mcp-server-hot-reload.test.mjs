import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('AC-MCP-HOT-RELOAD-001 mcp-server.mjs source change → process.exit(0) hot reload', () => {
  test('AC-MCP-HOT-RELOAD-001-a: createSourceChangeWatcher watch 主文件 + lib/*.mjs 白名单', async () => {
    const { createSourceChangeWatcher } = await import('../mcp-server.mjs');
    assert.equal(typeof createSourceChangeWatcher, 'function', 'createSourceChangeWatcher 必须 export');
  });

  test('AC-MCP-HOT-RELOAD-001-b: 主文件 mtime 变化触发 exitFn(0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hot-reload-'));
    try {
      const mainFile = join(dir, 'mcp-server.mjs');
      const libDir = join(dir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(mainFile, '// initial', 'utf8');

      const exitCalls = [];
      const { createSourceChangeWatcher } = await import('../mcp-server.mjs');
      const watcher = createSourceChangeWatcher({
        rootDir: dir,
        libGlob: ['lib/*.mjs'],
        intervalMs: 50,
        exitFn: (code) => exitCalls.push(code),
        debounceMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(mainFile, '// changed', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 250));
      watcher.stop();

      assert.equal(exitCalls.length, 1, '主文件 mtime 变化应触发 1 次 exit');
      assert.equal(exitCalls[0], 0, 'exit code 应为 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-HOT-RELOAD-001-c: lib/*.mjs 变化也触发 exitFn(0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hot-reload-lib-'));
    try {
      const mainFile = join(dir, 'mcp-server.mjs');
      const libDir = join(dir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(mainFile, '// main', 'utf8');
      const libFile = join(libDir, 'mcp-tools.mjs');
      writeFileSync(libFile, '// initial', 'utf8');

      const exitCalls = [];
      const { createSourceChangeWatcher } = await import('../mcp-server.mjs');
      const watcher = createSourceChangeWatcher({
        rootDir: dir,
        libGlob: ['lib/*.mjs'],
        intervalMs: 50,
        exitFn: (code) => exitCalls.push(code),
        debounceMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(libFile, '// changed', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 250));
      watcher.stop();

      assert.equal(exitCalls.length, 1, 'lib/*.mjs 变化应触发 1 次 exit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-HOT-RELOAD-001-d: debounce 多文件同时变化只触发 1 次 exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hot-reload-debounce-'));
    try {
      const mainFile = join(dir, 'mcp-server.mjs');
      const libDir = join(dir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(mainFile, '// main', 'utf8');
      const libFile1 = join(libDir, 'a.mjs');
      const libFile2 = join(libDir, 'b.mjs');
      writeFileSync(libFile1, '// a', 'utf8');
      writeFileSync(libFile2, '// b', 'utf8');

      const exitCalls = [];
      const { createSourceChangeWatcher } = await import('../mcp-server.mjs');
      const watcher = createSourceChangeWatcher({
        rootDir: dir,
        libGlob: ['lib/*.mjs'],
        intervalMs: 50,
        exitFn: (code) => exitCalls.push(code),
        debounceMs: 200,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(libFile1, '// a changed', 'utf8');
      writeFileSync(libFile2, '// b changed', 'utf8');
      writeFileSync(mainFile, '// main changed', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      watcher.stop();

      assert.equal(exitCalls.length, 1, 'debounce 应合并多文件变化为 1 次 exit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-MCP-HOT-RELOAD-001-e: watcher.stop() 后不再 polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hot-reload-stop-'));
    try {
      const mainFile = join(dir, 'mcp-server.mjs');
      mkdirSync(join(dir, 'lib'), { recursive: true });
      writeFileSync(mainFile, '// main', 'utf8');

      const exitCalls = [];
      const { createSourceChangeWatcher } = await import('../mcp-server.mjs');
      const watcher = createSourceChangeWatcher({
        rootDir: dir,
        libGlob: ['lib/*.mjs'],
        intervalMs: 50,
        exitFn: (code) => exitCalls.push(code),
        debounceMs: 100,
      });

      watcher.stop();
      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(mainFile, '// changed', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(exitCalls.length, 0, 'stop 后不应触发 exit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
