/**
 * feishu-worker.mjs — Child process for a single Feishu WSClient
 *
 * Each Feishu app runs in its own fork() to avoid Lark SDK global state
 * interference when multiple WSClient instances coexist.
 *
 * Receives config via FEISHU_APP_CONFIG env var (JSON).
 * Sends messages to parent via process.send().
 */

import * as Lark from '@larksuiteoapi/node-sdk';

const app = JSON.parse(process.env.FEISHU_APP_CONFIG);

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      process.send({ type: 'feishu_message', app: app.name, data });
    } catch (err) {
      process.stderr.write(`[feishu-worker:${app.name}] send error: ${err?.message}\n`);
    }
  },
});

const wsClient = new Lark.WSClient({
  appId: app.appId,
  appSecret: app.appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher }).then(() => {
  process.stderr.write(`[feishu-worker:${app.name}] WSClient connected\n`);
  process.send({ type: 'connected', app: app.name });
}).catch(err => {
  process.stderr.write(`[feishu-worker:${app.name}] WSClient FAILED: ${err?.message}\n`);
});
