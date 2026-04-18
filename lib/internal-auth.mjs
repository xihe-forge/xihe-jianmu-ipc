import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const INTERNAL_TOKEN_FILENAME = '.ipc-internal-token';

export function getInternalTokenPath({ rootDir = process.cwd() } = {}) {
  return resolve(rootDir, INTERNAL_TOKEN_FILENAME);
}

async function readTokenFile(tokenPath, readFileImpl) {
  try {
    const token = (await readFileImpl(tokenPath, 'utf8')).trim();
    return token || null;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadInternalToken({
  rootDir = process.cwd(),
  env = process.env,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  randomUUIDImpl = randomUUID,
} = {}) {
  const envToken = typeof env?.IPC_INTERNAL_TOKEN === 'string'
    ? env.IPC_INTERNAL_TOKEN.trim()
    : '';
  if (envToken) {
    return envToken;
  }

  const tokenPath = getInternalTokenPath({ rootDir });
  const existingToken = await readTokenFile(tokenPath, readFileImpl);
  if (existingToken) {
    return existingToken;
  }

  const generatedToken = randomUUIDImpl();

  try {
    await writeFileImpl(tokenPath, generatedToken, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return generatedToken;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const racedToken = await readTokenFile(tokenPath, readFileImpl);
  if (racedToken) {
    return racedToken;
  }

  throw new Error(`internal token file is empty: ${tokenPath}`);
}

export function isLoopbackAddress(remoteAddress) {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}
