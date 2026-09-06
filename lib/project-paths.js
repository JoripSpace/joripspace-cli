const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function safeProjectRelativePath(value, errorPrefix = 'unsafe project file path') {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[ .]$/.test(part) ||
          /[<>:"|?*\x00-\x1f]/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
      )
  ) {
    throw new Error(`${errorPrefix}: ${value}`);
  }
  return normalized;
}

function resolveProjectFileTarget(root, value, errorPrefix = 'unsafe project file path') {
  const relative = safeProjectRelativePath(value, errorPrefix);
  const rootPath = realProjectRoot(root);
  const target = path.resolve(rootPath, ...relative.split('/'));
  assertContained(rootPath, target, relative);
  const blockers = [];
  let current = rootPath;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `project path contains a symbolic link or junction: ${parts.slice(0, index + 1).join('/')}`
      );
    }
    const isTarget = index === parts.length - 1;
    if ((!isTarget && !stat.isDirectory()) || (isTarget && !stat.isFile())) {
      blockers.push(parts.slice(0, index + 1).join('/'));
      break;
    }
    assertContained(rootPath, fs.realpathSync.native(current), relative);
  }
  return { blockers, relative, root: rootPath, target };
}

function backupAndRemoveProjectPaths(root, relatives, backupRoot) {
  const selected = minimalPaths(relatives);
  const rootPath = realProjectRoot(root);
  if (!path.isAbsolute(backupRoot)) {
    throw new Error('project backups must use an absolute directory outside the workspace');
  }
  const backupLocation = fs.realpathSync.native(path.resolve(backupRoot));
  const fromWorkspace = path.relative(rootPath, backupLocation);
  if (isContainedRelative(fromWorkspace)) {
    throw new Error('project backups must use an absolute directory outside the workspace');
  }
  const backupStat = fs.lstatSync(backupLocation);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw new Error('project backup target is not a safe directory');
  }
  for (const relative of selected) {
    const location = resolveExistingProjectPath(root, relative);
    if (!location) continue;
    const backup = path.join(backupLocation, ...relative.split('/'));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (location.stat.isDirectory()) {
      fs.cpSync(location.target, backup, { recursive: true, errorOnExist: true });
    } else {
      fs.copyFileSync(location.target, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.rmSync(location.target, { recursive: location.stat.isDirectory(), force: true });
  }
  return selected;
}

function createExternalBackupRoot(workspaceDir, category = 'restore', dataRootOverride = '') {
  const workspace = realProjectRoot(workspaceDir);
  const configuredRoot = String(dataRootOverride || process.env.JORIPSPACE_DATA_DIR || '').trim();
  const dataRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'JoripSpace')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'JoripSpace')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'joripspace');
  const workspaceKey = crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? workspace.toLowerCase() : workspace)
    .digest('hex')
    .slice(0, 20);
  const safeCategory = String(category || 'restore').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(safeCategory)) {
    throw new Error('invalid backup category');
  }
  const resolvedDataRoot = prospectiveRealPath(dataRoot);
  const dataFromWorkspace = path.relative(workspace, resolvedDataRoot);
  if (isContainedRelative(dataFromWorkspace)) {
    throw new Error('JoripSpace user data directory must be outside the project workspace');
  }
  const parent = path.join(resolvedDataRoot, 'backups', workspaceKey, safeCategory);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync.native(parent);
  const fromWorkspace = path.relative(workspace, realParent);
  if (isContainedRelative(fromWorkspace)) {
    throw new Error('JoripSpace user data directory must be outside the project workspace');
  }
  const backupRoot = path.join(
    realParent,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
  );
  fs.mkdirSync(backupRoot, { recursive: false, mode: 0o700 });
  return fs.realpathSync.native(backupRoot);
}

function prospectiveRealPath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const existing = fs.realpathSync.native(current);
  return path.join(existing, ...missing);
}

function resolveProjectDirectoryTarget(root, value) {
  const relative = safeProjectRelativePath(value);
  const rootPath = realProjectRoot(root);
  const target = path.resolve(rootPath, ...relative.split('/'));
  assertContained(rootPath, target, relative);
  let current = rootPath;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `project path contains a symbolic link or junction: ${relative
          .split('/')
          .slice(0, index + 1)
          .join('/')}`
      );
    }
    if (!stat.isDirectory()) throw new Error(`project directory path is blocked by a file: ${relative}`);
    assertContained(rootPath, fs.realpathSync.native(current), relative);
  }
  return { relative, root: rootPath, target };
}

function resolveExistingProjectPath(root, value) {
  const relative = safeProjectRelativePath(value);
  const rootPath = realProjectRoot(root);
  let current = rootPath;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `project path contains a symbolic link or junction: ${parts.slice(0, index + 1).join('/')}`
      );
    }
    assertContained(rootPath, fs.realpathSync.native(current), relative);
    if (index < parts.length - 1 && !stat.isDirectory()) return null;
    if (index === parts.length - 1) return { relative, root: rootPath, stat, target: current };
  }
  return null;
}

function assertNonOverlappingFilePlan(relatives) {
  const paths = new Map();
  for (const relative of relatives) {
    const key = relative.toLowerCase();
    if (paths.has(key)) {
      throw new Error(`project file plan contains a duplicate cross-platform path: ${relative}`);
    }
    paths.set(key, relative);
  }
  for (const relative of paths.values()) {
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/');
      const plannedParent = paths.get(parent.toLowerCase());
      if (plannedParent) {
        throw new Error(`project file plan contains a file/directory collision: ${plannedParent}`);
      }
    }
  }
}

function minimalPaths(relatives) {
  const unique = new Map(relatives.map((relative) => [relative.toLowerCase(), relative]));
  const sorted = [...unique.values()].sort(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)
  );
  return sorted.filter(
    (candidate) =>
      !sorted.some(
        (parent) => parent !== candidate && candidate.toLowerCase().startsWith(`${parent.toLowerCase()}/`)
      )
  );
}

function realProjectRoot(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`project workspace does not exist: ${resolved}`);
  }
  return fs.realpathSync.native(resolved);
}

function assertContained(root, target, relative) {
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`project path escapes the workspace: ${relative}`);
  }
}

function isContainedRelative(relative) {
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

module.exports = {
  assertNonOverlappingFilePlan,
  backupAndRemoveProjectPaths,
  createExternalBackupRoot,
  resolveProjectDirectoryTarget,
  resolveProjectFileTarget,
  safeProjectRelativePath,
};
