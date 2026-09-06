const fs = require('node:fs');
const path = require('node:path');
const { safeProjectRelativePath } = require('./project-paths');

const INLINE_FILE_LIMIT = 16_000;
const INLINE_TOTAL_LIMIT = 64_000;
const IGNORED_DIRS = new Set([
  '.git',
  '.joripspace',
  '.wrangler',
  '.cache',
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.opencode',
  'coverage',
  'node_modules',
  'tmp',
  'temp',
]);
const PROTECTED_FILE_NAMES = new Set(['agents.md', 'claude.md']);
const PROTECTED_SOURCE_DIRS = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.git',
  '.joripspace',
  '.opencode',
  '.wrangler',
  'node_modules',
]);

function buildDeployPayload(flags) {
  const source = stringFlag(flags, 'source');
  if (source) {
    const fileName = safeProjectRelativePath(stringFlag(flags, 'entrypoint') || path.basename(source));
    assertDeployableProjectPath(fileName);
    const resolved = resolveDeploySourceFile(source, stringFlag(flags, 'cwd'));
    return buildInlineDeployPayload(fileName, new Map([[fileName, resolved]]));
  }
  const directory = stringFlag(flags, 'dir');
  if (directory) {
    const rawEntrypoint = stringFlag(flags, 'entrypoint');
    if (!rawEntrypoint) throw new Error('deploy --dir requires --entrypoint');
    const entrypoint = safeProjectRelativePath(rawEntrypoint);
    const resolvedDirectory = resolveDeploySourceDirectory(directory, stringFlag(flags, 'cwd'));
    const files = new Map();
    for (const file of walkFiles(resolvedDirectory.path)) {
      const relative = safeProjectRelativePath(toPosix(path.relative(resolvedDirectory.path, file.path)));
      files.set(relative, file);
    }
    if (!files.has(entrypoint)) {
      throw new Error(`entrypoint not found in --dir: ${entrypoint}`);
    }
    return buildInlineDeployPayload(entrypoint, files);
  }
  const mappings = arrayFlag(flags, 'file');
  if (mappings.length) {
    const rawEntrypoint = stringFlag(flags, 'entrypoint');
    if (!rawEntrypoint) throw new Error('deploy --file requires --entrypoint');
    const entrypoint = safeProjectRelativePath(rawEntrypoint);
    const files = new Map();
    for (const mapping of mappings) {
      const [name, filePath] = splitFileMapping(mapping);
      const relative = safeProjectRelativePath(name);
      assertDeployableProjectPath(relative);
      files.set(relative, resolveDeploySourceFile(filePath, stringFlag(flags, 'cwd')));
    }
    if (!files.has(entrypoint)) {
      throw new Error(`entrypoint not found in --file mappings: ${entrypoint}`);
    }
    return buildInlineDeployPayload(entrypoint, files);
  }
  throw new Error('deploy requires --source, --dir, or --file');
}

function buildInlineDeployPayload(entrypoint, sources) {
  let expectedTotal = 0;
  for (const [fileName, source] of sources) {
    if (source.size > INLINE_FILE_LIMIT) {
      throw archiveRequired(`deploy source exceeds the inline file limit (${fileName})`);
    }
    expectedTotal += source.size;
  }
  if (expectedTotal > INLINE_TOTAL_LIMIT) {
    throw archiveRequired('deploy source exceeds the inline total limit');
  }

  const buffered = [];
  let actualTotal = 0;
  for (const [fileName, source] of sources) {
    const bytes = fs.readFileSync(source.path);
    if (bytes.byteLength > INLINE_FILE_LIMIT) {
      throw archiveRequired(`deploy source exceeds the inline file limit (${fileName})`);
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > INLINE_TOTAL_LIMIT) {
      throw archiveRequired('deploy source exceeds the inline total limit');
    }
    if (bytes.includes(0)) {
      throw archiveRequired(`deploy source contains binary data (${fileName})`);
    }
    buffered.push([fileName, bytes]);
  }

  const files = {};
  for (const [fileName, bytes] of buffered) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw archiveRequired(`deploy source contains binary data (${fileName})`);
    }
    files[fileName] = text;
  }
  return { entrypoint, files };
}

function walkFiles(root, base = path.resolve(root)) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    const relative = toPosix(path.relative(base, fullPath));
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
    if (isProtectedProjectPath(relative)) continue;
    if (entry.isDirectory()) files.push(...walkFiles(fullPath, base));
    else if (entry.isFile()) files.push(resolveDeploySourceFile(fullPath, base));
  }
  return files;
}

function assertDeployableProjectPath(value) {
  const relative = safeProjectRelativePath(value);
  if (isProtectedProjectPath(relative)) throw new Error(`protected file cannot be deployed: ${relative}`);
}

function assertDeployableSourceFilePath(value, workspaceDir = '') {
  resolveDeploySourceFile(value, workspaceDir);
}

function resolveDeploySourceFile(value, workspaceDir = '') {
  return resolveDeploySource(value, workspaceDir, 'file');
}

function resolveDeploySourceDirectory(value, workspaceDir = '') {
  return resolveDeploySource(value, workspaceDir, 'directory');
}

function resolveDeploySource(value, workspaceDir, expectedType) {
  const source = path.resolve(value);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`protected deploy source cannot be a symbolic link or junction: ${value}`);
  }
  if (expectedType === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`deploy source must be a regular ${expectedType}: ${value}`);
  }

  const realSource = fs.realpathSync.native(source);
  const realStat = fs.lstatSync(realSource);
  if (realStat.isSymbolicLink() || (expectedType === 'file' ? !realStat.isFile() : !realStat.isDirectory())) {
    throw new Error(`deploy source must be a regular ${expectedType}: ${value}`);
  }

  if (workspaceDir) {
    const workspace = path.resolve(workspaceDir);
    const realWorkspace = fs.realpathSync.native(workspace);
    if (isContainedPath(workspace, source) && !isContainedPath(realWorkspace, realSource)) {
      throw new Error(`deploy source escapes the workspace through a symbolic link or junction: ${value}`);
    }
  }

  if (isProtectedSourcePath(source) || isProtectedSourcePath(realSource)) {
    throw new Error(`protected file cannot be used as deploy source: ${value}`);
  }
  return { path: realSource, size: realStat.size, type: expectedType };
}

function isProtectedSourcePath(value) {
  const resolved = path.resolve(value);
  const baseName = path.basename(resolved);
  const parts = resolved.replace(/\\/g, '/').toLowerCase().split('/');
  return isProtectedProjectPath(baseName) || parts.some((part) => PROTECTED_SOURCE_DIRS.has(part));
}

function isContainedPath(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isProtectedProjectPath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
  const parts = normalized.split('/');
  const baseName = parts.at(-1) || '';
  return (
    parts.some((part) => IGNORED_DIRS.has(part)) ||
    baseName === '.env.joripspace' ||
    PROTECTED_FILE_NAMES.has(baseName) ||
    baseName.endsWith('.log')
  );
}

function archiveRequired(message) {
  const error = new Error(message);
  error.code = 'archive_required';
  return error;
}

function stringFlag(flags, name) {
  const value = flags[name];
  return Array.isArray(value) ? String(value.at(-1)) : typeof value === 'string' ? value : '';
}

function arrayFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function splitFileMapping(value) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) throw new Error('--file must use name=path');
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

module.exports = {
  assertDeployableProjectPath,
  assertDeployableSourceFilePath,
  buildDeployPayload,
  isProtectedProjectPath,
  resolveDeploySourceDirectory,
  resolveDeploySourceFile,
};
