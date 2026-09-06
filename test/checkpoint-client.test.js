const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { unzipSync, zipSync } = require('fflate');
const {
  hardExcluded,
  projectFiles,
  runCheckpointOperation,
  verifyRestoreArchive,
} = require('../lib/checkpoint-client');

test('deployment archive waits through provider processing and does not cancel uploads at 45 seconds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-client-'));
  // Node 18's experimental MockTimers loses pending timers in this clear/tick
  // sequence. Use the same deterministic clock on every supported Node version.
  let clock = 0;
  const timers = new Map();
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const handle = {};
    timers.set(handle, { callback, at: clock + Number(delay) });
    return handle;
  });
  t.mock.method(global, 'clearTimeout', (handle) => timers.delete(handle));
  const advance = (milliseconds) => {
    clock += milliseconds;
    for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timers.has(handle) && timer.at <= clock) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  let polls = 0,
    deployments = 0,
    completed = false,
    failure,
    result;
  try {
    fs.writeFileSync(path.join(root, 'worker.js'), 'export default {fetch(){return new Response("ok")}}');
    t.mock.method(global, 'fetch', async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/checkpoint-uploads'))
        return json({
          checkpoint_id: 'slow',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/slow/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/slow/complete',
        });
      if (pathname.endsWith('/checkpoints/slow')) {
        polls++;
        return json({
          checkpoint_id: 'slow',
          status: polls <= 120 ? 'processing' : 'ready',
          deployable: true,
        });
      }
      advance(45001);
      assert.equal(init.signal.aborted, false, 'an upload, completion or deployment was cancelled locally');
      if (pathname.endsWith('/deploy')) {
        deployments++;
        return json({ deployment_id: 'slow-deployment', status: 'success' });
      }
      return json({ ok: true });
    });
    const pending = runCheckpointOperation('save', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'test-token',
      entrypoint: 'worker.js',
      label: 'slow deployment',
      deploy: true,
    })
      .then(
        (value) => {
          result = value;
        },
        (error) => {
          failure = error;
        }
      )
      .finally(() => {
        completed = true;
      });
    for (let turn = 0; turn < 300 && !completed; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      advance(1000);
    }
    assert.equal(completed, true, JSON.stringify({ polls, deployments, failure: failure?.message }));
    await pending;
    if (failure) throw failure;
    assert.equal(polls, 121);
    assert.equal(deployments, 1);
    assert.equal(result.deployment.deployment_id, 'slow-deployment');
  } finally {
    t.mock.reset();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint archive keeps customer credentials and excludes JoripSpace local metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-client-'));
  const previousFetch = global.fetch;
  const uploaded = [];
  const requests = [];
  try {
    fs.mkdirSync(path.join(root, '.joripspace'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'worker.js'),
      'export default { fetch() { return new Response("ok"); } };\n'
    );
    fs.writeFileSync(path.join(root, 'asset.bin'), Buffer.from([0, 255, 12, 128]));
    fs.writeFileSync(path.join(root, '.env.joripspace'), 'JORIPSPACE_API_TOKEN=never-upload\n');
    fs.writeFileSync(path.join(root, '.dev.vars.local'), 'TOKEN=never-upload\n');
    fs.writeFileSync(path.join(root, '.npmrc'), '//registry.example/:_authToken=never-upload\n');
    fs.writeFileSync(path.join(root, '.pypirc'), 'password=never-upload\n');
    fs.writeFileSync(path.join(root, '_netrc'), 'password never-upload\n');
    fs.writeFileSync(path.join(root, 'private.pem'), 'never-upload\n');
    fs.writeFileSync(path.join(root, 'service-account-prod.json'), '{"private_key":"never-upload"}\n');
    fs.writeFileSync(path.join(root, 'secrets.json'), '{"feature":"ordinary-app-data"}\n');
    fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aws', 'credentials'), 'never-upload\n');
    fs.mkdirSync(path.join(root, 'nested', '.aws'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', '.aws', 'credentials'), 'never-upload\n');
    fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ssh', 'config'), 'never-upload\n');
    fs.writeFileSync(path.join(root, '.joripspace', 'agent-session.json'), '{"api_token":"never"}\n');
    fs.writeFileSync(path.join(root, '.joripspace', 'project'), 'demo\n');
    fs.writeFileSync(path.join(root, '.joripspace', 'project.json'), '{"project_id":"demo"}\n');
    fs.writeFileSync(path.join(root, '.joripspace', 'deploy.json'), '{"entrypoint":"hostile.js"}\n');

    assert.deepEqual(
      projectFiles(root)
        .map(([name]) => name)
        .sort(),
      [
        '.aws/credentials',
        '.dev.vars.local',
        '.npmrc',
        '.pypirc',
        '.ssh/config',
        '_netrc',
        'asset.bin',
        'nested/.aws/credentials',
        'private.pem',
        'secrets.json',
        'service-account-prod.json',
        'worker.js',
      ]
    );

    global.fetch = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname, method: options.method || 'GET' });
      if (pathname.endsWith('/checkpoint-uploads')) {
        return json({
          checkpoint_id: 'checkpoint-1',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/upload-1/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/upload-1/complete',
        });
      }
      if (pathname.includes('/parts/')) {
        uploaded.push(Buffer.from(options.body));
        return json({ ok: true });
      }
      if (pathname.endsWith('/complete')) return json({ status: 'processing' });
      if (pathname.endsWith('/checkpoints/checkpoint-1') && (options.method || 'GET') === 'GET') {
        return json({
          checkpoint_id: 'checkpoint-1',
          sequence: 1,
          status: 'ready',
          deployable: true,
          file_count: 3,
        });
      }
      if (pathname.endsWith('/checkpoints/checkpoint-1/deploy')) {
        return json({ deployment_id: 'deployment-1', status: 'success', url: 'https://demo.example' });
      }
      return json({ message: `unhandled ${pathname}` }, 404);
    };

    const result = await runCheckpointOperation('save', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'project-token',
      entrypoint: 'worker.js',
      label: 'archive deploy',
      deploy: true,
      sourceType: 'deployment',
    });
    assert.equal(result.deployment.deployment_id, 'deployment-1');
    const files = unzipSync(Buffer.concat(uploaded));
    assert.deepEqual(Buffer.from(files['asset.bin']), Buffer.from([0, 255, 12, 128]));
    assert.equal(files['.env.joripspace'], undefined);
    assert.equal(Buffer.from(files['private.pem']).toString('utf8'), 'never-upload\n');
    assert.equal(files['.joripspace/agent-session.json'], undefined);
    assert.equal(files['.joripspace/project'], undefined);
    assert.equal(files['.joripspace/project.json'], undefined);
    assert.equal(
      JSON.parse(Buffer.from(files['.joripspace/deploy.json']).toString('utf8')).entrypoint,
      'worker.js'
    );
    assert.ok(requests.some((request) => request.pathname.endsWith('/parts/1')));
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint restore plan is authoritative for every path, hash, and byte size', () => {
  const worker = Buffer.from('worker');
  const asset = Buffer.from([0, 1, 2]);
  const plan = {
    files: [manifestFile('worker.js', worker), manifestFile('asset.bin', asset)],
  };
  assert.deepEqual(
    verifyRestoreArchive(plan, { 'worker.js': worker, 'asset.bin': asset }).map(([name]) => name),
    ['worker.js', 'asset.bin']
  );
  assert.throws(
    () => verifyRestoreArchive(plan, { 'worker.js': worker, 'asset.bin': asset, 'extra.js': worker }),
    /unplanned file: extra\.js/
  );
  assert.throws(
    () => verifyRestoreArchive(plan, { 'worker.js': worker }),
    /missing planned files: asset\.bin/
  );
  assert.throws(
    () => verifyRestoreArchive(plan, { 'worker.js': Buffer.from('tampered'), 'asset.bin': asset }),
    /byte size check failed|integrity check failed/
  );
  assert.throws(
    () =>
      verifyRestoreArchive(
        { files: [{ ...manifestFile('worker.js', worker), byte_size: worker.byteLength + 1 }] },
        { 'worker.js': worker }
      ),
    /byte size check failed/
  );

  const identity = Buffer.from('{"project_id":"demo"}\n');
  assert.throws(
    () =>
      verifyRestoreArchive(
        {
          files: [
            manifestFile('.joripspace/project.json', identity),
            manifestFile('.JORIPSPACE/PROJECT.JSON', identity),
          ],
        },
        {
          '.joripspace/project.json': identity,
          '.JORIPSPACE/PROJECT.JSON': identity,
        }
      ),
    /duplicate cross-platform path/
  );
});

test('excluded symlinked dependency directories are skipped while included symlinks are rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-links-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-outside-'));
  try {
    fs.writeFileSync(path.join(root, 'worker.js'), 'export default {};\n');
    fs.writeFileSync(path.join(outside, 'outside.js'), 'outside\n');
    try {
      fs.symlinkSync(
        outside,
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    assert.deepEqual(
      projectFiles(root).map(([name]) => name),
      ['worker.js']
    );
    fs.symlinkSync(
      outside,
      path.join(root, 'linked-assets'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(() => projectFiles(root), /symbolic links cannot be included/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('platform exclusions remain while customer credential paths are included', () => {
  for (const relative of [
    'AGENTS.md',
    'CLAUDE.md',
    '.codex/config.toml',
    '.claude/settings.json',
    'aGeNtS.MD',
    'ClAuDe.Md',
    '.CoDeX/Config.toml',
    '.ClAuDe/Settings.json',
    '.AgEnTs/settings.json',
    '.OpEnCoDe/config.json',
    '.EnV.JoRiPsPaCe',
  ]) {
    assert.equal(hardExcluded(relative), true, relative);
  }
  for (const relative of [
    '.envrc',
    '.env-local',
    '.dev.vars.production',
    '.npmrc',
    '.aws/credentials',
    '.ssh/id_ed25519',
    'config/service-account-prod.json',
    'token.json',
    'src/secrets.json',
  ]) {
    assert.equal(hardExcluded(relative), false, relative);
  }
  assert.equal(hardExcluded('src/secretary.js'), false);
  for (const relative of ['src/secret.ts', 'src/session.ts', 'src/token.ts', 'src/credentials.ts']) {
    assert.equal(hardExcluded(relative), false, relative);
    const bytes = Buffer.from('export const value = true;\n');
    assert.doesNotThrow(() =>
      verifyRestoreArchive({ files: [manifestFile(relative, bytes)] }, { [relative]: bytes })
    );
  }
});

test('checkpoint restore preserves the local identity and rejects a different checkpoint identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-identity-'));
  const previousFetch = global.fetch;
  const identityAlias = '.JORIPSPACE/PrOjEcT.JsOn';
  try {
    fs.mkdirSync(path.join(root, '.joripspace'), { recursive: true });
    const localPath = path.join(root, '.joripspace', 'project.json');
    fs.writeFileSync(localPath, '{"project_id":"demo"}\n');
    for (const [label, source] of [
      ['different', '{"project_id":"other-project"}\n'],
      ['missing', '{}\n'],
      ['conflicting', '{"project_id":"demo","project_slug":"other-project"}\n'],
    ]) {
      const remoteIdentity = Buffer.from(source);
      global.fetch = async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/restore-plan')) {
          return json({ files: [manifestFile(identityAlias, remoteIdentity)] });
        }
        if (pathname.endsWith('/download')) {
          return new Response(zipSync({ [identityAlias]: remoteIdentity }));
        }
        return json({}, 404);
      };
      await assert.rejects(
        runCheckpointOperation('restore', {
          workspaceDir: root,
          projectId: 'demo',
          apiBaseUrl: 'https://api.test',
          apiToken: 'project-token',
          checkpointId: `identity-mismatch-${label}`,
        }),
        /does not match the connected project/
      );
    }
    assert.equal(fs.readFileSync(localPath, 'utf8'), '{"project_id":"demo"}\n');
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint restore preserves identity and gitignore for portable casing aliases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-identity-case-'));
  const dataDir = `${root}-data`;
  const previousFetch = global.fetch;
  const identityAlias = '.JORIPSPACE/PrOjEcT.JsOn';
  const gitignoreAlias = '.GiTiGnOrE';
  const remoteIdentity = Buffer.from('{"project_id":"demo","entrypoint":"remote.js"}\n');
  const remoteGitignore = Buffer.from('hostile-ignore\n');
  try {
    fs.mkdirSync(path.join(root, '.joripspace'), { recursive: true });
    const localPath = path.join(root, '.joripspace', 'project.json');
    const gitignorePath = path.join(root, '.gitignore');
    fs.writeFileSync(localPath, '{"project_id":"demo","entrypoint":"worker.js"}\n');
    fs.writeFileSync(path.join(root, '.env.joripspace'), 'JORIPSPACE_API_TOKEN=local-token\n');
    fs.writeFileSync(gitignorePath, 'local-rule\n.env.joripspace\n');
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/restore-plan')) {
        return json({
          files: [manifestFile(identityAlias, remoteIdentity), manifestFile(gitignoreAlias, remoteGitignore)],
        });
      }
      if (pathname.endsWith('/download')) {
        return new Response(zipSync({ [identityAlias]: remoteIdentity, [gitignoreAlias]: remoteGitignore }));
      }
      if (pathname.endsWith('/checkpoint-uploads')) {
        return json({
          checkpoint_id: 'safety-case',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/safety-case/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/safety-case/complete',
        });
      }
      if (pathname.includes('/parts/') || pathname.endsWith('/complete')) return json({});
      if (pathname.endsWith('/checkpoints/safety-case') && (options.method || 'GET') === 'GET') {
        return json({
          checkpoint_id: 'safety-case',
          sequence: 2,
          status: 'ready',
          deployable: false,
          file_count: 2,
        });
      }
      return json({ message: `unhandled ${pathname}` }, 404);
    };

    const result = await runCheckpointOperation('restore', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'project-token',
      checkpointId: 'identity-case',
      apply: true,
      dataDir,
    });
    assert.equal(result.status, 'restored');
    assert.deepEqual(new Set(result.protected_files_skipped), new Set([identityAlias, gitignoreAlias]));
    assert.equal(fs.readFileSync(localPath, 'utf8'), '{"project_id":"demo","entrypoint":"worker.js"}\n');
    assert.equal(fs.readFileSync(gitignorePath, 'utf8'), 'local-rule\n.env.joripspace\n');
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('checkpoint restore preserves the canonical marker and never writes the transient deploy manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-marker-'));
  const dataDir = `${root}-data`;
  const previousFetch = global.fetch;
  const markerAlias = '.JORIPSPACE/PrOjEcT';
  const deployAlias = '.JoRiPsPaCe/DePlOy.JsOn';
  const remoteMarker = Buffer.from('demo\n');
  const remoteDeploy = Buffer.from('{"entrypoint":"worker.js"}\n');
  const worker = Buffer.from('export default {};\n');
  try {
    fs.mkdirSync(path.join(root, '.joripspace'), { recursive: true });
    const markerPath = path.join(root, '.joripspace', 'project');
    fs.writeFileSync(markerPath, 'demo\n');
    fs.writeFileSync(path.join(root, 'local.txt'), 'preserve through restore safety\n');
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/restore-plan')) {
        return json({
          files: [
            manifestFile(markerAlias, remoteMarker),
            manifestFile(deployAlias, remoteDeploy),
            manifestFile('worker.js', worker),
          ],
        });
      }
      if (pathname.endsWith('/download')) {
        return new Response(
          zipSync({ [markerAlias]: remoteMarker, [deployAlias]: remoteDeploy, 'worker.js': worker })
        );
      }
      if (pathname.endsWith('/checkpoint-uploads')) {
        return json({
          checkpoint_id: 'safety-marker',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/safety-marker/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/safety-marker/complete',
        });
      }
      if (pathname.includes('/parts/') || pathname.endsWith('/complete')) return json({});
      if (pathname.endsWith('/checkpoints/safety-marker') && (options.method || 'GET') === 'GET') {
        return json({ checkpoint_id: 'safety-marker', status: 'ready', deployable: false });
      }
      return json({ message: `unhandled ${pathname}` }, 404);
    };

    const result = await runCheckpointOperation('restore', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'project-token',
      checkpointId: 'marker-case',
      apply: true,
      dataDir,
    });
    assert.equal(result.status, 'restored');
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'demo\n');
    assert.equal(fs.existsSync(path.join(root, '.joripspace', 'deploy.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'worker.js'), 'utf8'), 'export default {};\n');
    assert.deepEqual(new Set(result.protected_files_skipped), new Set([markerAlias, deployAlias]));
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('checkpoint restore validates mixed-case canonical marker aliases before preserving them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-marker-mismatch-'));
  const previousFetch = global.fetch;
  const markerAlias = '.JoRiPsPaCe/PROJECT';
  const remoteMarker = Buffer.from('other-project\n');
  try {
    fs.mkdirSync(path.join(root, '.joripspace'), { recursive: true });
    const markerPath = path.join(root, '.joripspace', 'project');
    fs.writeFileSync(markerPath, 'demo\n');
    global.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/restore-plan')) {
        return json({ files: [manifestFile(markerAlias, remoteMarker)] });
      }
      if (pathname.endsWith('/download')) {
        return new Response(zipSync({ [markerAlias]: remoteMarker }));
      }
      return json({}, 404);
    };
    await assert.rejects(
      runCheckpointOperation('restore', {
        workspaceDir: root,
        projectId: 'demo',
        apiBaseUrl: 'https://api.test',
        apiToken: 'project-token',
        checkpointId: 'marker-mismatch',
      }),
      /does not match the connected project/
    );
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'demo\n');
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint restore refuses JoripSpace credentials and agent-control files before writing them', () => {
  for (const relative of [
    'AGENTS.md',
    'aGeNtS.MD',
    'CLAUDE.md',
    'ClAuDe.Md',
    '.codex/config.toml',
    '.CoDeX/Config.toml',
    '.AgEnTs/settings.json',
    '.OpEnCoDe/config.json',
    '.EnV.JoRiPsPaCe',
  ]) {
    const bytes = Buffer.from('untrusted\n');
    assert.throws(
      () => verifyRestoreArchive({ files: [manifestFile(relative, bytes)] }, { [relative]: bytes }),
      /protected file cannot be restored/,
      relative
    );
  }
});

test('checkpoint apply recursively backs up a directory that conflicts with a planned file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-directory-'));
  const dataDir = `${root}-data`;
  const previousFetch = global.fetch;
  const restored = Buffer.from('restored file\n');
  const archive = zipSync({ blocker: restored });
  try {
    fs.mkdirSync(path.join(root, 'blocker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'blocker', 'local.txt'), 'preserve in backup\n');
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/restore-plan')) return json({ files: [manifestFile('blocker', restored)] });
      if (pathname.endsWith('/download')) return new Response(archive);
      if (pathname.endsWith('/checkpoint-uploads')) {
        return json({
          checkpoint_id: 'safety-1',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/safety/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/safety/complete',
        });
      }
      if (pathname.includes('/parts/') || pathname.endsWith('/complete')) return json({});
      if (pathname.endsWith('/checkpoints/safety-1') && (options.method || 'GET') === 'GET') {
        return json({ checkpoint_id: 'safety-1', sequence: 4, status: 'ready', deployable: false });
      }
      return json({ message: `unhandled ${pathname}` }, 404);
    };
    const result = await runCheckpointOperation('restore', {
      workspaceDir: root,
      projectId: 'demo',
      apiBaseUrl: 'https://api.test',
      apiToken: 'project-token',
      checkpointId: 'restore-1',
      apply: true,
      dataDir,
    });
    assert.equal(result.status, 'restored');
    assert.equal(fs.readFileSync(path.join(root, 'blocker'), 'utf8'), 'restored file\n');
    assert.equal(
      fs.readFileSync(path.join(result.backup_root, 'blocker', 'local.txt'), 'utf8'),
      'preserve in backup\n'
    );
    assert.equal(path.isAbsolute(result.backup_root), true);
    assert.equal(path.relative(root, result.backup_root).startsWith('..'), true);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('checkpoint restore refuses an existing symlink parent before writing outside the project', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-restore-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-checkpoint-restore-outside-'));
  const previousFetch = global.fetch;
  const bytes = Buffer.from('outside write\n');
  try {
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    global.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/restore-plan')) {
        return json({ files: [manifestFile('escape/pwned.txt', bytes)] });
      }
      if (pathname.endsWith('/download')) return new Response(zipSync({ 'escape/pwned.txt': bytes }));
      return json({}, 404);
    };
    await assert.rejects(
      runCheckpointOperation('restore', {
        workspaceDir: root,
        projectId: 'demo',
        apiBaseUrl: 'https://api.test',
        apiToken: 'project-token',
        checkpointId: 'restore-link',
        apply: false,
      }),
      /symbolic link or junction/
    );
    assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false);
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

function manifestFile(name, bytes) {
  return {
    path: name,
    byte_size: bytes.byteLength,
    content_hash: crypto.createHash('sha256').update(bytes).digest('base64url'),
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
