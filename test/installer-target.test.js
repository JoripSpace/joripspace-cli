const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installExecutableAtomically } = require('../lib/installer-target');

test('installer atomically upgrades an existing executable in a Korean path with spaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '조립스페이스 설치 경로 '));
  try {
    const source = path.join(root, '새 설치.exe');
    const target = path.join(root, '사용자 폴더', 'JoripSpace', 'bin', 'joripspace.exe');
    fs.writeFileSync(source, 'new-cli-bytes');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old-cli-bytes');

    const result = installExecutableAtomically(source, target, { platform: 'win32' });

    assert.equal(result.target, target);
    assert.equal(result.replaced, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new-cli-bytes');
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.joripspace.exe.')),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer rolls back to the existing executable when Windows promotion fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-installer-rollback-'));
  try {
    const source = path.join(root, 'setup.exe');
    const target = path.join(root, 'bin', 'joripspace.exe');
    fs.writeFileSync(source, 'new-cli-bytes');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'known-good-cli');

    assert.throws(
      () =>
        installExecutableAtomically(source, target, {
          platform: 'win32',
          beforePromote: () => {
            throw new Error('simulated interruption');
          },
        }),
      /simulated interruption/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'known-good-cli');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['joripspace.exe']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects a linked target without changing the link destination', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-installer-link-'));
  try {
    const source = path.join(root, 'setup.exe');
    const destination = path.join(root, 'outside');
    const target = path.join(root, 'bin', 'joripspace.exe');
    fs.writeFileSync(source, 'new-cli-bytes');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'sentinel.txt'), 'preserve-me');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(destination, target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') return t.skip('symlink creation is unavailable');
      throw error;
    }

    assert.throws(
      () => installExecutableAtomically(source, target, { platform: 'win32' }),
      /target must be a regular file/
    );
    assert.equal(fs.readFileSync(path.join(destination, 'sentinel.txt'), 'utf8'), 'preserve-me');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
