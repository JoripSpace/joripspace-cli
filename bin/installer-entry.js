#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version: VERSION } = require('../package.json');
const { installerFlags, normalizeWindowsPathEntry } = require('../lib/installer-args');
const { installExecutableAtomically } = require('../lib/installer-target');

const invocationArgs = process.argv.slice(2);
const executableName = path.basename(process.execPath).toLowerCase();
const isReleaseSetup = executableName.startsWith('joripspace-setup');
const { wantsHelp, wantsJson, wantsQuiet, wantsVersion } = installerFlags(invocationArgs);
const wantsInstallerHelp = wantsHelp && isReleaseSetup && invocationArgs.every((arg) => arg.startsWith('-'));
const isInstallerInvocation = Boolean(
  process.pkg &&
  isReleaseSetup &&
  (invocationArgs.length === 0 || invocationArgs.every((arg) => arg.startsWith('-')))
);

if (wantsVersion) {
  console.log(wantsJson ? JSON.stringify({ ok: true, version: VERSION }) : VERSION);
} else if (wantsInstallerHelp) {
  console.log(`JoripSpace CLI installer ${VERSION}

Usage:
  ${path.basename(process.execPath)} [--quiet|-quiet] [--json]
  ${path.basename(process.execPath)} --version

The JSON result includes the absolute installed executable path.`);
} else if (isInstallerInvocation) {
  install().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      wantsJson ? JSON.stringify({ ok: false, error: message }) : `JoripSpace installer: ${message}`
    );
    process.exitCode = 1;
  });
} else {
  require('./joripspace.js');
}

async function install() {
  if (!process.pkg) {
    throw new Error('This installer must be run as a packaged JoripSpace release file.');
  }
  const target = executableTarget();
  installExecutableAtomically(process.execPath, target);
  const pathStatus = addToUserPath(path.dirname(target));
  const result = {
    ok: true,
    version: VERSION,
    executable: path.resolve(target),
    path_added: pathStatus.available,
    path_restart_required: process.platform === 'win32' && pathStatus.changed,
  };
  if (!wantsQuiet && !wantsJson) {
    console.error(`Installed JoripSpace CLI at ${result.executable}`);
    if (result.path_restart_required) {
      console.error('Open a new terminal before running joripspace by name.');
    }
  }
  if (wantsJson) console.log(JSON.stringify(result));
}

function executableTarget() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'JoripSpace', 'bin', 'joripspace.exe');
  }
  return path.join(os.homedir(), '.local', 'bin', 'joripspace');
}

function addToUserPath(directory) {
  if (process.platform === 'win32') return addWindowsPath(directory);
  return addUnixPath(directory);
}

function addWindowsPath(directory) {
  const key = 'HKCU\\Environment';
  const query = spawnSync('reg.exe', ['query', key, '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  let existing = parseWindowsPath(query.stdout);
  if (query.status !== 0 || existing === null) {
    const keyQuery = spawnSync('reg.exe', ['query', key], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (keyQuery.status !== 0) return { available: false, changed: false };
    existing = parseWindowsPath(keyQuery.stdout) || '';
  }
  const entries = existing
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedDirectory = normalizeWindowsPathEntry(directory);
  if (entries.some((entry) => normalizeWindowsPathEntry(entry) === normalizedDirectory)) {
    return { available: true, changed: false };
  }
  const next = existing ? `${existing}${existing.endsWith(';') ? '' : ';'}${directory}` : directory;
  const update = spawnSync('reg.exe', ['add', key, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { available: update.status === 0, changed: update.status === 0 };
}

function parseWindowsPath(source) {
  const match = String(source || '').match(/^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/im);
  return match ? match[1].trimEnd() : null;
}

function addUnixPath(directory) {
  const home = os.homedir();
  const shell = path.basename(String(process.env.SHELL || '')).toLowerCase();
  const isFish = process.platform !== 'darwin' && shell === 'fish';
  const preferred =
    process.platform === 'darwin'
      ? path.join(home, '.zprofile')
      : isFish
        ? path.join(home, '.config', 'fish', 'config.fish')
        : shell === 'zsh'
          ? path.join(home, '.zprofile')
          : path.join(home, '.profile');
  const line = isFish ? 'fish_add_path --global $HOME/.local/bin' : 'export PATH="$HOME/.local/bin:$PATH"';
  let source = '';
  let mode = 0o644;
  let existed = false;
  try {
    const stat = fs.lstatSync(preferred);
    if (!stat.isFile() || stat.isSymbolicLink()) return { available: false, changed: false };
    existed = true;
    mode = stat.mode & 0o777;
    source = fs.readFileSync(preferred, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') return { available: false, changed: false };
  }
  if (source.split(/\r?\n/).some((entry) => entry.trim() === line)) {
    return { available: true, changed: false };
  }
  const next = `${source}${source && !source.endsWith('\n') ? '\n' : ''}\n# JoripSpace CLI\n${line}\n`;
  try {
    writeTextAtomically(preferred, next, { expectedSource: existed ? source : null, mode });
  } catch {
    return { available: false, changed: false };
  }
  return { available: true, changed: true };
}

function writeTextAtomically(filePath, source, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const currentSource = readTextIfExists(filePath);
  if (currentSource !== options.expectedSource) {
    throw new Error('Shell profile changed while JoripSpace was updating PATH.');
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', options.mode ?? 0o644);
    fs.writeFileSync(descriptor, source, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, options.mode ?? 0o644);
    if (readTextIfExists(filePath) !== options.expectedSource) {
      throw new Error('Shell profile changed while JoripSpace was updating PATH.');
    }
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
