/**
 * tests/helpers/temp-path.mjs — 测试临时文件路径统一管理
 *
 * 按天枢规范，测试产物统一落到 D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/
 * 避免污染 C 盘 Temp 和项目根目录。
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// __dirname = .../xihe-jianmu-ipc/tests/helpers
// ../.. = xihe-jianmu-ipc/
// ../../.. = xiheAi/
// 所以 join(__dirname, '..', '..', '..', 'temp', 'jianmu-ipc') 指向 xiheAi/temp/jianmu-ipc

// 默认：D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/
// 可通过 PROJECT_TEMP 环境变量覆盖
export const TEMP_ROOT =
  process.env.PROJECT_TEMP ||
  join(__dirname, '..', '..', '..', 'temp', 'jianmu-ipc');

mkdirSync(TEMP_ROOT, { recursive: true });

/** 生成唯一的测试SQLite文件路径 */
export function getTempDbPath(suffix = '') {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${suffix ? '-' + suffix : ''}`;
  return join(TEMP_ROOT, `test-${unique}.db`);
}
