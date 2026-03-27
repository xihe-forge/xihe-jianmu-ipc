/**
 * JSON-RPC 2.0 over stdio for MCP.
 *
 * Reads Content-Length framed messages from stdin (MCP/LSP stdio transport),
 * dispatches to handlers, writes JSON-RPC 2.0 responses to stdout using the
 * same Content-Length framing.
 *
 * All debug logging goes to stderr — stdout is reserved for JSON-RPC.
 */

import { Buffer } from 'node:buffer';

/**
 * Create a JSON-RPC 2.0 handler that reads from stdin and writes to stdout.
 *
 * @param {Record<string, (params: any) => any | Promise<any>>} handlers
 *   Map of method name to handler function.
 *   Notifications (no `id`) call the handler but no response is sent.
 * @param {{ write?: (data: string) => void }} [options]
 *   Optional options object. `write` overrides the default stdout writer,
 *   allowing the caller to share a single writer with channel notifications.
 * @returns {{ start(): void }}
 */
export function createRpcHandler(handlers, { write } = {}) {
  function writeMessage(obj) {
    const json = JSON.stringify(obj);
    const byteLength = Buffer.byteLength(json, 'utf8');
    const frame = `Content-Length: ${byteLength}\r\n\r\n${json}`;
    if (write) {
      write(frame);
    } else {
      process.stdout.write(frame);
    }
  }

  function sendResult(id, result) {
    writeMessage({ jsonrpc: '2.0', id, result });
  }

  function sendError(id, code, message) {
    writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function dispatch(request) {
    const { jsonrpc, id, method, params } = request;

    // Basic validation
    if (jsonrpc !== '2.0' || typeof method !== 'string') {
      if (id !== undefined) {
        sendError(id, -32600, 'Invalid Request');
      }
      return;
    }

    const isNotification = id === undefined || id === null;
    const handler = handlers[method];

    if (!handler) {
      if (!isNotification) {
        sendError(id, -32601, 'Method not found');
      }
      return;
    }

    try {
      const result = await handler(params ?? {});
      if (!isNotification) {
        sendResult(id, result ?? null);
      }
    } catch (err) {
      process.stderr.write(`[ipc/rpc] error in handler "${method}": ${err?.message ?? err}\n`);
      if (!isNotification) {
        sendError(id, -32603, err?.message ?? 'Internal error');
      }
    }
  }

  function start() {
    let buffer = Buffer.alloc(0);

    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        // Look for Content-Length header
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Try newline-delimited fallback (for compatibility)
          const nlIndex = buffer.indexOf('\n');
          if (nlIndex !== -1) {
            const line = buffer.subarray(0, nlIndex).toString('utf8').trim();
            buffer = buffer.subarray(nlIndex + 1);
            if (line) {
              try {
                const request = JSON.parse(line);
                dispatch(request).catch(err => {
                  process.stderr.write(`[ipc/rpc] dispatch error: ${err?.message ?? err}\n`);
                });
              } catch {
                sendError(null, -32700, 'Parse error');
              }
            }
          }
          break;
        }

        const contentLength = parseInt(match[1], 10);
        const messageStart = headerEnd + 4; // skip \r\n\r\n

        if (buffer.length < messageStart + contentLength) break; // wait for more data

        const messageBytes = buffer.subarray(messageStart, messageStart + contentLength);
        buffer = buffer.subarray(messageStart + contentLength);

        const messageStr = messageBytes.toString('utf8');
        try {
          const request = JSON.parse(messageStr);
          dispatch(request).catch(err => {
            process.stderr.write(`[ipc/rpc] dispatch error: ${err?.message ?? err}\n`);
          });
        } catch {
          sendError(null, -32700, 'Parse error');
        }
      }
    });

    process.stdin.on('end', () => {
      process.stderr.write('[ipc/rpc] stdin closed, exiting\n');
      process.exit(0);
    });

    process.stderr.write('[ipc/rpc] started, listening on stdin\n');
  }

  return { start };
}
