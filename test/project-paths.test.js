const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertNonOverlappingFilePlan,
  backupAndRemoveProjectPaths,
  createExternalBackupRoot,
  safeProjectRelativePath,
} = require('../lib/project-paths');

test('portable project paths reject Windows devices, trailing dots/spaces, colons, and controls', () => {
  for (const value of [
    'CON',
    'con.txt',
    'PRN.js',
    'AUX',
    'NUL.json',
    'COM1.log',
    'LPT9.txt',
    'folder/name.',
    'folder/name ',
    'folder/name:stream',
    'folder/control\u0001.txt',
  ]) {
    assert.throws(() => safeProjectRelativePath(value), /unsafe project file path/, value);
  }
  assert.equal(safeProjectRelativePath('.\\src\\worker.js'), 'src/worker.js');
});

test('file plan checks every ancestor and case-insensitive duplicate', () => {
  assert.throws(() => assertNonOverlappingFilePlan(['a', 'a-b', 'a/b']), /file\/directory collision: a/);
  assert.throws(
    () => assertNonOverlappingFilePlan(['src/A.js', 'src/a.js']),
    /duplicate cross-platform path/
  );
  assert.doesNotThrow(() => assertNonOverlappingFilePlan(['a-b', 'a/b', 'src/c.js']));
});

test('backup destination stays external and source symlinks or junctions are refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-backup-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-backup-outside-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-backup-data-'));
  try {
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'local\n');
    const internalBackup = path.join(root, 'internal-backup');
    fs.mkdirSync(internalBackup);
    assert.throws(
      () => backupAndRemoveProjectPaths(root, ['conflict.txt'], internalBackup),
      /absolute directory outside the workspace/
    );
    assert.equal(fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8'), 'local\n');
    assert.throws(
      () => createExternalBackupRoot(root, 'test', path.join(root, '..data')),
      /must be outside the project workspace/
    );

    const externalBackup = createExternalBackupRoot(root, 'test', dataRoot);
    assert.equal(path.isAbsolute(externalBackup), true);
    assert.equal(path.relative(fs.realpathSync.native(root), externalBackup).startsWith('..'), true);
    try {
      fs.symlinkSync(
        outside,
        path.join(root, 'linked-conflict'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    assert.throws(
      () => backupAndRemoveProjectPaths(root, ['linked-conflict'], externalBackup),
      /symbolic link or junction/
    );
    assert.equal(fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8'), 'local\n');
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(externalBackup), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
