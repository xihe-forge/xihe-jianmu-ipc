import { join } from 'node:path';

const DEFAULT_HOME_DIR = 'C:\\Users\\jolen';

export function getHomeDir({ homeDir = null, env = process.env } = {}) {
  return homeDir || env.USERPROFILE || env.HOME || DEFAULT_HOME_DIR;
}

export function getClaudeDir(options = {}) {
  return join(getHomeDir(options), '.claude');
}

export function getProjectStateDir(options = {}) {
  return join(getClaudeDir(options), 'project-state');
}

export function getObservationDbPath(project, options = {}) {
  return join(getProjectStateDir(options), project, 'observations.db');
}

export function getSessionsRegistryPath(options = {}) {
  return join(getClaudeDir(options), 'sessions-registry.json');
}
