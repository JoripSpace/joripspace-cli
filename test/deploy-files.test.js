const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCheckpointCommands } = require('../lib/checkpoint-commands');
const {
  assertDeployableProjectPath,
  buildDeployPayload,
  resolveDeploySourceDirectory,
  resolveDeploySourceFile,
} = require('../lib/deploy-files');
const { safeProjectRelativePath } = require('../lib/project-paths');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-deploy-files-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  return { root, workspace, outside };
}

function createDirectoryLink(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('directory links are unavailable');
      return false;
    }
    throw error;
  }
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

test('source, file, dir, and archive staging reject a workspace junction escape', async (t) => {
  const { root, workspace, outside } = fixture();
  try {
    const outsideFile = path.join(outside, 'worker.js');
    const linkedDirectory = path.join(workspace, 'linked');
    fs.writeFileSync(outsideFile, 'export default {}');
    if (!createDirectoryLink(t, outside, linkedDirectory)) return;
    const linkedFile = path.join(linkedDirectory, 'worker.js');

    assert.throws(
      () => buildDeployPayload({ source: linkedFile, cwd: workspace, entrypoint: 'worker.js' }),
      /escapes the workspace through a symbolic link or junction/
    );
    assert.throws(
      () =>
        buildDeployPayload({
          file: `worker.js=${linkedFile}`,
          cwd: workspace,
          entrypoint: 'worker.js',
        }),
      /escapes the workspace through a symbolic link or junction/
    );
    assert.throws(
      () => buildDeployPayload({ dir: linkedDirectory, cwd: workspace, entrypoint: 'worker.js' }),
      /symbolic link or junction/
    );

    const checkpointCommands = createCheckpointCommands({
      arrayFlag,
      assertDeployableProjectPath,
      projectWorkspaceDir: () => workspace,
      resolveDeploySourceDirectory,
      resolveDeploySourceFile,
      safeProjectRelativePath,
      stringFlag,
    });
    await assert.rejects(
      checkpointCommands.deployArchive(
        { source: linkedFile, entrypoint: 'worker.js' },
        'demo',
        'junction source',
        'archive fallback'
      ),
      /escapes the workspace through a symbolic link or junction/
    );
    await assert.rejects(
      checkpointCommands.deployArchive(
        { dir: linkedDirectory, entrypoint: 'worker.js' },
        'demo',
        'junction directory',
        'archive fallback'
      ),
      /symbolic link or junction/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safe explicit outside and customer-secret sources remain supported while wrong types fail', () => {
  const { root, workspace, outside } = fixture();
  try {
    const outsideFile = path.join(outside, 'worker.js');
    fs.writeFileSync(outsideFile, 'export default {}');
    assert.equal(
      buildDeployPayload({ source: outsideFile, cwd: workspace, entrypoint: 'worker.js' }).files['worker.js'],
      'export default {}'
    );
    assert.equal(
      buildDeployPayload({ dir: outside, cwd: workspace, entrypoint: 'worker.js' }).files['worker.js'],
      'export default {}'
    );

    const protectedRoot = path.join(root, '.ssh');
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, 'id_rsa'), 'private material');
    assert.equal(
      buildDeployPayload({ dir: protectedRoot, cwd: workspace, entrypoint: 'id_rsa' }).files.id_rsa,
      'private material'
    );
    assert.throws(() => resolveDeploySourceDirectory(outsideFile, workspace), /regular directory/);
    assert.throws(() => resolveDeploySourceFile(outside, workspace), /regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inline size preflight switches to archive before reading large files', () => {
  const { root, workspace, outside } = fixture();
  const largeFile = path.join(outside, 'large.js');
  const aggregateDirectory = path.join(outside, 'aggregate');
  fs.writeFileSync(largeFile, 'x'.repeat(16_001));
  fs.mkdirSync(aggregateDirectory);
  const aggregateFiles = Array.from({ length: 5 }, (_, index) => {
    const filePath = path.join(aggregateDirectory, `chunk-${index}.js`);
    fs.writeFileSync(filePath, 'x'.repeat(13_000));
    return path.resolve(filePath);
  });

  const watched = new Set([path.resolve(largeFile), ...aggregateFiles]);
  const originalReadFileSync = fs.readFileSync;
  let watchedReads = 0;
  fs.readFileSync = function readFileSync(filePath, ...args) {
    if (watched.has(path.resolve(String(filePath)))) watchedReads += 1;
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(
      () => buildDeployPayload({ source: largeFile, cwd: workspace, entrypoint: 'worker.js' }),
      (error) => error?.code === 'archive_required' && /inline file limit/.test(error.message)
    );
    assert.throws(
      () =>
        buildDeployPayload({
          dir: aggregateDirectory,
          cwd: workspace,
          entrypoint: 'chunk-0.js',
        }),
      (error) => error?.code === 'archive_required' && /inline total limit/.test(error.message)
    );
    assert.equal(watchedReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
