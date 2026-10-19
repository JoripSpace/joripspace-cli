const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { zipSync, unzipSync } = require('fflate');
const { createTemplateCommands } = require('../lib/template-commands');
const { createRemoteCommands } = require('../lib/remote-commands');
const { isProtectedProjectPath, resolveDeploySourceFile } = require('../lib/deploy-files');
const { projectFiles, runCheckpointOperation, safeRestorePath } = require('../lib/checkpoint-client');
const {
  backupAndRemoveProjectPaths,
  resolveProjectDirectoryTarget,
  resolveProjectFileTarget,
} = require('../lib/project-paths');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-security-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  return { base, root };
}

function write(root, name, text = 'synthetic fixture') {
  const target = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function windowsAlias(t, root, name) {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'dir /x /a'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split(/\r?\n/).find((value) => value.trim().endsWith(` ${name}`));
  const alias = line?.trim().split(/\s+/).at(-2);
  if (!alias?.includes('~')) {
    t.skip('NTFS short names unavailable on this volume');
    return null;
  }
  assert.equal(fs.realpathSync.native(path.join(root, alias)), fs.realpathSync.native(path.join(root, name)));
  return alias;
}

function tar(files) {
  const entries = { 'joripspace-template.json': JSON.stringify({ source_root: 'app' }), ...files };
  return gzipSync(
    Buffer.concat(
      Object.entries(entries)
        .flatMap(([name, value]) => {
          const data = Buffer.from(value),
            header = Buffer.alloc(512);
          header.write(`release/${name}`);
          header.write('0000755\0', 100);
          header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
          header[156] = 48;
          return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
        })
        .concat(Buffer.alloc(1024))
    )
  );
}

function template(t, files) {
  t.mock.method(global, 'fetch', async (url) =>
    String(url).endsWith('/claim') ? Response.json({}) : new Response(tar(files))
  );
  return createTemplateCommands({
    requireProjectId: () => 'demo',
    stringFlag: (flags, name) => flags[name] || '',
    booleanFlag: (flags, name) => Boolean(flags[name]),
    resolveConnection: () => ({ apiBaseUrl: 'https://api.test' }),
    requireApiToken: () => 'synthetic-token',
    output: () => {},
  });
}

test('template install rejects an existing directory junction before writing any planned file', async (t) => {
  const { base, root } = fixture(t),
    outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const commands = template(t, { 'app/first.txt': 'safe', 'app/linked/probe.txt': 'remote' });
  for (const force of [false, true]) {
    await assert.rejects(
      commands.install({ dir: root, template: 'demo', 'files-only': true, force }),
      /symbolic link or junction/
    );
    assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
    assert.deepEqual(fs.readdirSync(outside), []);
  }
});

test('template install rejects dangling junctions and portable aliases before any content write', async (t) => {
  const { base, root } = fixture(t);
  fs.symlinkSync(
    path.join(base, 'absent'),
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const commands = template(t, { 'app/first.txt': 'safe', 'app/linked/probe.txt': 'remote' });
  await assert.rejects(
    commands.install({ dir: root, template: 'demo', 'files-only': true }),
    /symbolic link or junction/
  );
  assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
  for (const unsafe of ['CON.txt', 'folder/name.', 'folder/name:stream', '..\\escape']) {
    const other = template(t, { 'app/first.txt': 'safe', [`app/${unsafe}`]: 'remote' });
    await assert.rejects(
      other.install({ dir: root, template: 'demo', 'files-only': true, force: true }),
      /unsafe path/
    );
    assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
  }
  const duplicate = template(t, { 'app/Same.txt': 'a', 'app/same.txt': 'b' });
  await assert.rejects(
    duplicate.install({ dir: root, template: 'demo', 'files-only': true }),
    /duplicate cross-platform path/
  );
});

test('template install rejects final file links and replaces hard links without changing their other name', async (t) => {
  const { base, root } = fixture(t),
    outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'original');
  fs.linkSync(outside, path.join(root, 'hard.txt'));
  const commands = template(t, { 'app/hard.txt': 'new' });
  await commands.install({ dir: root, template: 'demo', 'files-only': true, force: true });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(root, 'hard.txt'), 'utf8'), 'new');
  try {
    fs.symlinkSync(outside, path.join(root, 'link.txt'), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic('file symlinks unavailable; hard-link control passed');
      return;
    }
    throw error;
  }
  const linked = template(t, { 'app/link.txt': 'remote' });
  await assert.rejects(
    linked.install({ dir: root, template: 'demo', 'files-only': true, force: true }),
    /symbolic link or junction/
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
});

test('template install retains new directory, collision and ordinary force-overwrite behavior', async (t) => {
  const { root } = fixture(t),
    target = path.join(root, 'new');
  const commands = template(t, { 'app/nested/worker.js': 'new' });
  await commands.install({ dir: target, template: 'demo', 'files-only': true });
  const file = path.join(target, 'nested/worker.js');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  fs.writeFileSync(file, 'local');
  await assert.rejects(commands.install({ dir: target, template: 'demo', 'files-only': true }), /--force/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'local');
  await commands.install({ dir: target, template: 'demo', 'files-only': true, force: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o111, 0o111);
});

test('checkpoint collection applies Git pattern syntax and nested gitignore scope', (t) => {
  const { root } = fixture(t);
  write(
    root,
    '.gitignore',
    '.env\n*.pem\n/root-only.txt\ncache/\n\\#private\n\\!private\nsecret\\ key.txt\n**/hidden?.[ab]\nblocked/\n!blocked/child.txt\nreopen/*\n!reopen/keep/\n!reopen/keep/**\n'
  );
  write(root, 'config/.gitignore', '/scoped.txt\n!allowed.pem\n');
  const excluded = [
    '.env',
    'config/.env',
    'deeper/config/private.pem',
    'root-only.txt',
    'dir/cache/file',
    '#private',
    '!private',
    'secret key.txt',
    'hidden1.a',
    'dir/hidden2.b',
    'blocked/child.txt',
    'reopen/drop.txt',
    'config/scoped.txt',
  ];
  const included = [
    'nested/root-only.txt',
    'cache',
    'dir/hidden22.a',
    'config/allowed.pem',
    'elsewhere/scoped.txt',
    'reopen/keep/file.txt',
    'customer.credentials',
    'private.key',
    'normal/worker.js',
  ];
  for (const name of [...excluded, ...included]) write(root, name);
  const names = new Set(projectFiles(root).map(([name]) => name));
  for (const name of excluded) assert.equal(names.has(name), false, name);
  for (const name of included) assert.equal(names.has(name), true, name);
});

test('checkpoint root ignore file order and hard exclusions survive negation', (t) => {
  const { root } = fixture(t);
  write(root, '.gitignore', '*.txt\n');
  write(root, '.ignore', '!keep.txt\n');
  write(root, '.joripspaceignore', 'keep.txt\n!public.txt\n!.env.joripspace\n!AGENTS.md\n');
  for (const name of ['keep.txt', 'public.txt', '.env.joripspace', 'AGENTS.md']) write(root, name);
  const names = projectFiles(root).map(([name]) => name);
  assert.equal(names.includes('keep.txt'), false);
  assert.equal(names.includes('public.txt'), true);
  assert.equal(names.includes('.env.joripspace'), false);
  assert.equal(names.includes('AGENTS.md'), false);
});

test('checkpoint protected names cannot appear in ancestors, while nested gitignore remains valid', () => {
  for (const name of [
    'AGENTS.md/child',
    '.env.joripspace/child',
    'x/CLAUDE.md/child',
    '.GITIGNORE/child',
    '.joripspace/project/child',
    'x\\AgEnTs.Md\\child',
  ]) {
    assert.throws(() => safeRestorePath(name), /protected file cannot be restored/, name);
  }
  assert.equal(safeRestorePath('nested/.gitignore'), 'nested/.gitignore');
});

function remote(root, files) {
  return createRemoteCommands({
    isProtectedProjectPath,
    requireProjectId: () => 'demo',
    stringFlag: () => '',
    booleanFlag: (flags, name) => Boolean(flags[name]),
    apiRequest: async () => ({ files }),
    projectAuth: () => ({}),
    projectWorkspaceDir: () => root,
    writeTextAtomically: (target, content) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
  });
}

test('deployment force and start backupConflicts preserve protected descendants and earlier conflicts', async (t) => {
  const { base, root } = fixture(t);
  const oldDataDir = process.env.JORIPSPACE_DATA_DIR;
  process.env.JORIPSPACE_DATA_DIR = path.join(base, 'data');
  t.after(() => {
    if (oldDataDir === undefined) delete process.env.JORIPSPACE_DATA_DIR;
    else process.env.JORIPSPACE_DATA_DIR = oldDataDir;
  });
  write(root, 'first.txt', 'first local');
  write(root, 'blocker/nested/AGENTS.md', 'local instructions');
  const commands = remote(root, { 'first.txt': 'remote', blocker: 'remote' });
  for (const options of [{ force: true }, { backupConflicts: true }]) {
    await assert.rejects(
      commands.pullDeploymentSource({}, { output: false, ...options }),
      /protected local path/
    );
    assert.equal(fs.readFileSync(path.join(root, 'first.txt'), 'utf8'), 'first local');
    assert.equal(fs.readFileSync(path.join(root, 'blocker/nested/AGENTS.md'), 'utf8'), 'local instructions');
  }
  const skipped = await remote(root, {
    'AGENTS.md/child': 'remote',
    '.env.joripspace/child': 'remote',
  }).pullDeploymentSource({}, { output: false, force: true });
  assert.equal(skipped.restore.files_written, 0);
  assert.equal(skipped.restore.protected_files_skipped.length, 2);
});

function restoreApi(t, archiveFiles, uploaded = []) {
  const archive = zipSync(archiveFiles);
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/restore-plan'))
      return Response.json({
        files: Object.entries(archiveFiles).map(([name, data]) => ({
          path: name,
          byte_size: data.length,
          content_hash: crypto.createHash('sha256').update(data).digest('base64url'),
        })),
      });
    if (route.endsWith('/download')) return new Response(archive);
    if (route.endsWith('/checkpoint-uploads'))
      return Response.json({
        checkpoint_id: 'safety',
        chunk_size: 1024 * 1024,
        upload_part_url_template: '/parts/{part_number}',
        complete_url: '/complete',
      });
    if (route.startsWith('/parts/')) {
      uploaded.push(options.body);
      return Response.json({});
    }
    if (route.endsWith('/complete')) return Response.json({});
    if (route.endsWith('/checkpoints/safety'))
      return Response.json({ checkpoint_id: 'safety', status: 'ready' });
    throw new Error(`unexpected route: ${route}`);
  });
}

test('checkpoint apply refuses recursive replacement containing protected data before removing any conflict', async (t) => {
  const { base, root } = fixture(t);
  write(root, 'first.txt', 'first local');
  write(root, 'blocker/nested/.env.joripspace', 'synthetic local credential');
  restoreApi(t, { 'first.txt': Buffer.from('remote'), blocker: Buffer.from('remote') });
  await assert.rejects(
    runCheckpointOperation('restore', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'synthetic-token',
      checkpointId: 'checkpoint',
      apply: true,
      dataDir: path.join(base, 'data'),
    }),
    /protected local path/
  );
  assert.equal(fs.readFileSync(path.join(root, 'first.txt'), 'utf8'), 'first local');
  assert.equal(
    fs.readFileSync(path.join(root, 'blocker/nested/.env.joripspace'), 'utf8'),
    'synthetic local credential'
  );
});

test('checkpoint upload omits nested ignored credentials from actual archive bytes', async (t) => {
  const { root } = fixture(t),
    uploaded = [];
  write(root, '.gitignore', '.env\n');
  write(root, 'config/.env', 'synthetic secret must stay local');
  write(root, 'worker.js', 'public code');
  restoreApi(t, {}, uploaded);
  await runCheckpointOperation('save', {
    workspaceDir: root,
    projectId: 'demo',
    apiBaseUrl: 'https://api.test',
    apiToken: 'synthetic-token',
    label: 'security regression',
  });
  const entries = unzipSync(Buffer.concat(uploaded));
  assert.equal(Object.hasOwn(entries, 'config/.env'), false);
  assert.equal(Buffer.from(entries['worker.js']).toString(), 'public code');
});

test('explicit deploy sources reject protected name ancestors and retain ordinary external files', (t) => {
  const { base, root } = fixture(t);
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.env.joripspace']) {
    write(root, `${name}/worker.js`, 'code');
    assert.throws(() => resolveDeploySourceFile(path.join(root, name, 'worker.js'), root), /protected file/);
  }
  write(base, 'outside/worker.js', 'code');
  assert.equal(resolveDeploySourceFile(path.join(base, 'outside/worker.js'), root).type, 'file');
});

test(
  'Windows short aliases cannot replace protected files or directories through project path helpers',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const { base, root } = fixture(t);
    write(root, '.env.joripspace', 'synthetic local credential');
    write(root, '.joripspace/project', 'demo');
    write(root, 'first.txt', 'first local');
    const fileAlias = windowsAlias(t, root, '.env.joripspace');
    const directoryAlias = windowsAlias(t, root, '.joripspace');
    if (!fileAlias || !directoryAlias) return;
    for (const name of [
      fileAlias,
      directoryAlias,
      `${directoryAlias}/project`,
      `${directoryAlias}/new.txt`,
    ]) {
      assert.throws(() => resolveProjectFileTarget(root, name), /filesystem alias/);
      assert.throws(() => resolveProjectDirectoryTarget(root, name), /filesystem alias|blocked by a file/);
    }
    const backup = path.join(base, 'backup');
    fs.mkdirSync(backup);
    assert.throws(
      () => backupAndRemoveProjectPaths(root, ['first.txt', fileAlias], backup, isProtectedProjectPath),
      /filesystem alias/
    );
    assert.equal(fs.readFileSync(path.join(root, 'first.txt'), 'utf8'), 'first local');
    assert.equal(fs.readFileSync(path.join(root, '.env.joripspace'), 'utf8'), 'synthetic local credential');
    assert.deepEqual(fs.readdirSync(backup), []);
    write(root, 'ordinary~1.txt', 'ordinary');
    assert.doesNotThrow(() => resolveProjectFileTarget(root, 'ordinary~1.txt'));
    assert.doesNotThrow(() => resolveProjectFileTarget(root, 'FIRST.TXT'));
  }
);

test(
  'Windows short aliases are rejected before template and deployment writes, including force',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const { root } = fixture(t);
    write(root, '.env.joripspace', 'synthetic local credential');
    const alias = windowsAlias(t, root, '.env.joripspace');
    if (!alias) return;
    const commands = template(t, { 'app/first.txt': 'new', [`app/${alias}`]: 'remote' });
    for (const force of [false, true]) {
      await assert.rejects(
        commands.install({ dir: root, template: 'demo', 'files-only': true, force }),
        /filesystem alias/
      );
      assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
    }
    write(root, 'first.txt', 'first local');
    for (const options of [{ force: true }, { backupConflicts: true }]) {
      await assert.rejects(
        remote(root, { 'first.txt': 'remote', [alias]: 'remote' }).pullDeploymentSource(
          {},
          { output: false, ...options }
        ),
        /filesystem alias/
      );
      assert.equal(fs.readFileSync(path.join(root, 'first.txt'), 'utf8'), 'first local');
    }
    assert.equal(fs.readFileSync(path.join(root, '.env.joripspace'), 'utf8'), 'synthetic local credential');
    assert.throws(() => resolveDeploySourceFile(path.join(root, alias), root), /protected file/);
  }
);

test(
  'checkpoint apply refuses a Windows short alias before writes or safety uploads',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const { base, root } = fixture(t),
      uploaded = [];
    write(root, '.env.joripspace', 'synthetic local credential');
    write(root, 'first.txt', 'first local');
    const alias = windowsAlias(t, root, '.env.joripspace');
    if (!alias) return;
    restoreApi(t, { 'first.txt': Buffer.from('remote'), [alias]: Buffer.from('remote') }, uploaded);
    await assert.rejects(
      runCheckpointOperation('restore', {
        workspaceDir: root,
        projectId: 'demo',
        apiBaseUrl: 'https://api.test',
        apiToken: 'synthetic-token',
        checkpointId: 'checkpoint',
        apply: true,
        dataDir: path.join(base, 'data'),
      }),
      /filesystem alias/
    );
    assert.deepEqual(uploaded, []);
    assert.equal(fs.readFileSync(path.join(root, 'first.txt'), 'utf8'), 'first local');
    assert.equal(fs.readFileSync(path.join(root, '.env.joripspace'), 'utf8'), 'synthetic local credential');
  }
);
