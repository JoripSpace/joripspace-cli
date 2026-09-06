const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProjectFileTarget } = require('./project-paths');

const PROJECT_ENV_FILE = '.env.joripspace';
function readProjectEnv(workspaceDir) {
  assertProjectEnvUntracked(workspaceDir);
  const envPath = managedProjectFilePath(workspaceDir, PROJECT_ENV_FILE);
  return readDotEnvFile(envPath);
}

function readDotEnvFile(filePath) {
  const values = {};
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      values[key] = parseDotEnvValue(trimmed.slice(index + 1));
    }
  } catch {}
  return values;
}

function updateDotEnvFile(filePath, updates) {
  if (path.basename(filePath).toLowerCase() === PROJECT_ENV_FILE) {
    const workspaceDir = path.dirname(filePath);
    assertProjectEnvUntracked(workspaceDir);
    ensureProjectEnvIgnored(workspaceDir);
    filePath = managedProjectFilePath(workspaceDir, PROJECT_ENV_FILE);
  }
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch {}
  const pending = new Map(
    Object.entries(updates).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  const written = new Set();
  const next = lines
    .filter((line, index) => index < lines.length - 1 || line !== '')
    .flatMap((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!match || !pending.has(match[1])) return [line];
      if (written.has(match[1])) return [];
      const value = pending.get(match[1]);
      written.add(match[1]);
      return [`${match[1]}=${formatDotEnvValue(value)}`];
    });
  for (const [key, value] of pending) {
    if (!written.has(key)) next.push(`${key}=${formatDotEnvValue(value)}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${next.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  replaceFileAtomically(temporaryPath, filePath);
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

function parseDotEnvValue(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed;
  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function formatDotEnvValue(value) {
  const source = String(value);
  if (/^[^\s#'"\\]+$/.test(source)) return source;
  return `"${source.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

function ensureProjectEnvIgnored(workspaceDir) {
  assertProjectEnvUntracked(workspaceDir);
  const filePath = managedProjectFilePath(workspaceDir, '.gitignore');
  const ignored = git(workspaceDir, ['check-ignore', '--no-index', '--quiet', '--', PROJECT_ENV_FILE]);
  if (ignored.status === 0) return false;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter((line) => line.trim() !== PROJECT_ENV_FILE);
  while (lines.at(-1) === '') lines.pop();
  lines.push(PROJECT_ENV_FILE);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${lines.join('\n')}\n`, 'utf8');
  replaceFileAtomically(temporaryPath, filePath);
  const verified = git(workspaceDir, ['check-ignore', '--no-index', '--quiet', '--', PROJECT_ENV_FILE]);
  if (verified.status !== 0 && findGitMetadata(workspaceDir)) {
    const error = new Error(`${PROJECT_ENV_FILE} is not effectively ignored by Git`);
    error.code = 'project_env_not_ignored';
    throw error;
  }
  return true;
}

function assertProjectEnvUntracked(workspaceDir) {
  const tracked = git(workspaceDir, ['ls-files', '--error-unmatch', '--', `:(icase)${PROJECT_ENV_FILE}`]);
  if (tracked.status === 0) {
    const error = new Error(
      `${PROJECT_ENV_FILE} is tracked by Git. Remove it from the index before storing a token: git rm --cached -- ${PROJECT_ENV_FILE}`
    );
    error.code = 'project_env_tracked';
    throw error;
  }
  if (tracked.status !== 1 && findGitMetadata(workspaceDir)) {
    const error = new Error(`Git could not verify that ${PROJECT_ENV_FILE} is untracked`);
    error.code = 'project_env_git_verification_failed';
    throw error;
  }
  assertCanonicalProjectEnvCasing(workspaceDir);
}

function assertCanonicalProjectEnvCasing(workspaceDir) {
  const matches = fs
    .readdirSync(path.resolve(workspaceDir))
    .filter((entry) => entry.toLowerCase() === PROJECT_ENV_FILE);
  if (!matches.length) return;
  if (matches.length !== 1 || matches[0] !== PROJECT_ENV_FILE) {
    const error = new Error(`${PROJECT_ENV_FILE} must use canonical lowercase casing`);
    error.code = 'non_canonical_workspace_path';
    throw error;
  }
}

function findGitMetadata(workspaceDir) {
  let current = path.resolve(workspaceDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function git(workspaceDir, args) {
  return spawnSync('git', ['-C', path.resolve(workspaceDir), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function replaceFileAtomically(temporaryPath, filePath) {
  try {
    fs.renameSync(temporaryPath, filePath);
    return;
  } catch (error) {
    const backupPath = `${filePath}.bak-${process.pid}-${Date.now()}`;
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
      fs.renameSync(temporaryPath, filePath);
      fs.rmSync(backupPath, { force: true });
      return;
    } catch {
      try {
        if (fs.existsSync(backupPath) && !fs.existsSync(filePath)) fs.renameSync(backupPath, filePath);
      } catch {}
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

function removeGitignoreEntries(workspaceDir, entries) {
  const filePath = managedProjectFilePath(workspaceDir, '.gitignore');
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  const removals = new Set(entries);
  const lines = existing.split(/\r?\n/).filter((line) => !removals.has(line.trim()));
  while (lines.at(-1) === '') lines.pop();
  const next = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  if (next === existing) return;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, next);
  replaceFileAtomically(temporaryPath, filePath);
}

function managedProjectFilePath(workspaceDir, relative) {
  const location = resolveProjectFileTarget(workspaceDir, relative);
  if (location.blockers.length) {
    throw new Error(`managed project file path is blocked: ${location.blockers.join(', ')}`);
  }
  return location.target;
}

module.exports = {
  PROJECT_ENV_FILE,
  assertProjectEnvUntracked,
  ensureProjectEnvIgnored,
  readDotEnvFile,
  readProjectEnv,
  removeGitignoreEntries,
  updateDotEnvFile,
};
