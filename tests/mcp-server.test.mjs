import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('mcp-server: import 时不会自动启动 MCP server', async () => {
  const originalName = process.env.IPC_NAME;
  process.env.IPC_NAME = 'unit-test-import';

  const originalWrite = process.stderr.write;
  const logs = [];
  process.stderr.write = ((chunk, encoding, callback) => {
    logs.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    const url = pathToFileURL(resolve('mcp-server.mjs'));
    await import(`${url.href}?test=${Date.now()}`);

    assert.equal(logs.some((line) => line.includes('[ipc] starting MCP server')), false);
    assert.equal(logs.some((line) => line.includes('MCP server ready')), false);
  } finally {
    process.stderr.write = originalWrite;
    if (originalName === undefined) {
      delete process.env.IPC_NAME;
    } else {
      process.env.IPC_NAME = originalName;
    }
  }
});
