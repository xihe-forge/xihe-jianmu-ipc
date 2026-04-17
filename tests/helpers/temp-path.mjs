/**
 * tests/helpers/temp-path.mjs — 测试临时文件路径统一管理
 *
 * 按天枢规范，测试产物统一落到 D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/
 * 避免污染 C 盘 Temp 和项目根目录。
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// __dirname = .../xihe-jianmu-ipc/tests/helpers
// ../.. = xihe-jianmu-ipc/
// ../../.. = xiheAi/
// 所以 join(__dirname, '..', '..', '..', 'temp', 'jianmu-ipc') 指向 xiheAi/temp/jianmu-ipc

// 默认优先沿用原约定路径；如果当前环境对该目录不可写，则回退到仓库内 .tmp。
const preferredTempRoot =
  process.env.PROJECT_TEMP ||
  join(__dirname, '..', '..', '..', 'temp', 'jianmu-ipc');
const fallbackTempRoot = join(__dirname, '..', '..', '.tmp', 'jianmu-ipc');

function resolveTempRoot() {
  for (const root of [preferredTempRoot, fallbackTempRoot]) {
    try {
      mkdirSync(root, { recursive: true });
      const probePath = join(root, `.write-probe-${process.pid}-${Date.now()}`);
      writeFileSync(probePath, 'ok');
      rmSync(probePath, { force: true });
      return root;
    } catch {
      // 当前候选目录不可写时继续尝试下一个目录。
    }
  }

  throw new Error('无法创建可写的测试临时目录');
}

export const TEMP_ROOT = resolveTempRoot();

/** 生成唯一的测试SQLite文件路径 */
export function getTempDbPath(suffix = '') {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${suffix ? '-' + suffix : ''}`;
  return join(TEMP_ROOT, `test-${unique}.db`);
}
