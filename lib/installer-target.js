const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function installExecutableAtomically(sourcePath, targetPath, options = {}) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  const platform = options.platform || process.platform;
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('JoripSpace installer source must be a regular file.');
  }

  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const before = executableSnapshot(target);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${suffix}`);
  let backup = '';
  let installed = false;

  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, options.mode ?? 0o755);
    fsyncFile(temporary);
    const copied = fs.lstatSync(temporary);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== sourceStat.size) {
      throw new Error('JoripSpace installer temporary executable failed integrity checks.');
    }
    if (!sameSnapshot(before, executableSnapshot(target))) {
      throw new Error('Installed JoripSpace CLI changed during upgrade.');
    }

    if (platform === 'win32' && before) {
      backup = path.join(directory, `.${path.basename(target)}.previous-${suffix}`);
      fs.renameSync(target, backup);
      try {
        if (typeof options.beforePromote === 'function') options.beforePromote();
        fs.renameSync(temporary, target);
      } catch (error) {
        try {
          if (!fs.existsSync(target)) fs.renameSync(backup, target);
        } catch (rollbackError) {
          throw new Error(
            `JoripSpace CLI upgrade failed and the previous executable remains at ${backup}: ${messageOf(
              rollbackError
            )}`,
            { cause: error }
          );
        }
        backup = '';
        throw error;
      }
    } else {
      if (typeof options.beforePromote === 'function') options.beforePromote();
      fs.renameSync(temporary, target);
    }
    installed = true;
    fsyncDirectory(directory);
    if (backup) {
      try {
        fs.rmSync(backup, { force: true });
        backup = '';
        fsyncDirectory(directory);
      } catch {}
    }
    return { target, replaced: Boolean(before) };
  } finally {
    fs.rmSync(temporary, { force: true });
    if (installed && backup) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {}
    }
  }
}

function executableSnapshot(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Installed JoripSpace CLI target must be a regular file.');
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  };
}

function sameSnapshot(left, right) {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { installExecutableAtomically };
