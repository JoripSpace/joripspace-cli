const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { applyGitBundle, createTemplateCommands } = require('../lib/template-commands');

test('bundle channel preserves origin and merges a later official descendant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-template-bundle-test-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    git(source, ['init', '-b', 'main']);
    configureIdentity(source);
    fs.writeFileSync(path.join(source, 'worker.js'), 'export default { version: 1 };\n');
    git(source, ['add', 'worker.js']);
    git(source, ['commit', '-m', 'template v1']);
    const firstHead = git(source, ['rev-parse', 'main']).trim();
    const firstBundle = path.join(root, 'v1.bundle');
    git(source, ['bundle', 'create', firstBundle, 'refs/heads/main']);

    git(target, ['init', '-b', 'main']);
    configureIdentity(target);
    git(target, ['remote', 'add', 'origin', 'https://github.com/user/project.git']);
    applyGitBundle(
      target,
      'sample-template',
      fs.readFileSync(firstBundle),
      metadata(firstBundle, firstHead, 'version_1'),
      false
    );

    assert.equal(
      git(target, ['config', '--get', 'remote.origin.url']).trim(),
      'https://github.com/user/project.git'
    );
    assert.equal(
      git(target, ['config', '--get', 'remote.upstream.url']).trim(),
      '.git/joripspace/upstream.bundle'
    );
    assert.equal(
      git(target, ['config', '--get', 'remote.upstream.fetch']).trim(),
      'refs/heads/main:refs/remotes/upstream/main'
    );
    assert.equal(fs.existsSync(path.join(target, '.git', 'joripspace', 'upstream.bundle')), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, '.joripspace', 'template.json'), 'utf8')).schema_version,
      3
    );

    fs.writeFileSync(path.join(source, 'worker.js'), 'export default { version: 2 };\n');
    git(source, ['add', 'worker.js']);
    git(source, ['commit', '-m', 'template v2']);
    const secondHead = git(source, ['rev-parse', 'main']).trim();
    const secondBundle = path.join(root, 'v2.bundle');
    git(source, ['bundle', 'create', secondBundle, 'refs/heads/main']);
    const result = applyGitBundle(
      target,
      'sample-template',
      fs.readFileSync(secondBundle),
      metadata(secondBundle, secondHead, 'version_2'),
      true
    );

    assert.equal(result.updated, true);
    assert.equal(
      normalizeLines(fs.readFileSync(path.join(target, 'worker.js'), 'utf8')),
      'export default { version: 2 };\n'
    );
    assert.equal(git(target, ['rev-parse', 'refs/remotes/upstream/main']).trim(), secondHead);
    assert.equal(
      git(target, ['config', '--get', 'remote.origin.url']).trim(),
      'https://github.com/user/project.git'
    );
    assert.equal(git(target, ['status', '--porcelain']).trim(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('template pull checks availability and requires explicit consent before bundle download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-template-consent-test-'));
  const originalFetch = global.fetch;
  try {
    fs.mkdirSync(path.join(root, '.joripspace'));
    fs.writeFileSync(
      path.join(root, '.joripspace', 'template.json'),
      JSON.stringify({ slug: 'sample', git_head_sha: 'a'.repeat(40) })
    );
    const requests = [];
    global.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).includes('/git-update?'))
        return Response.json({ update_available: true, version: '2.0.0' });
      throw new Error('bundle must not be requested before consent');
    };
    const commands = createCommands();
    await assert.rejects(commands.pull({ dir: root, template: 'sample' }), /--yes/);
    assert.equal(
      requests.some((url) => url.includes('/git-bundle-grants?')),
      false
    );
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files-only template installation skips the bundle grant and copies the archive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-template-files-only-test-'));
  const originalFetch = global.fetch;
  try {
    const repository = path.join(root, 'repository-root');
    const source = path.join(repository, 'template');
    const target = path.join(root, 'target');
    const archive = path.join(root, 'template.tar.gz');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(repository, 'joripspace-template.json'),
      JSON.stringify({ source_root: 'template', entrypoint: 'worker.js' })
    );
    fs.writeFileSync(path.join(source, 'worker.js'), 'export default { filesOnly: true };\n');
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'repository-root'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (packed.status !== 0) throw new Error(String(packed.stderr || packed.stdout || 'tar failed').trim());
    const requests = [];
    global.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/claim')) return Response.json({ ok: true });
      if (String(url).includes('/download?')) return new Response(fs.readFileSync(archive), { status: 200 });
      throw new Error(`unexpected request: ${url}`);
    };
    let outputValue;
    let deployOptions;
    await createCommands({
      deployCode: async (_flags, options) => {
        deployOptions = options;
        return { deployment_id: 'deployment_1', status: 'deployed' };
      },
      output: (_flags, value) => {
        outputValue = value;
      },
    }).install({
      template: 'sample-template',
      dir: target,
      'files-only': true,
      deploy: true,
      json: true,
    });
    assert.equal(
      normalizeLines(fs.readFileSync(path.join(target, 'worker.js'), 'utf8')),
      'export default { filesOnly: true };\n'
    );
    assert.equal(
      requests.some((url) => url.includes('/git-bundle-grants?')),
      false
    );
    assert.deepEqual(deployOptions, { output: false });
    assert.equal(outputValue.status, 'installed');
    assert.equal(outputValue.files, 1);
    assert.equal(outputValue.deployment.deployment_id, 'deployment_1');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createCommands(overrides = {}) {
  const connection = { apiToken: 'test-token', apiBaseUrl: 'https://api.example.test' };
  return createTemplateCommands({
    requireProjectId: () => 'sample-project',
    stringFlag: (flags, name) => String(flags[name] || ''),
    resolveConnection: () => connection,
    requireApiToken: (_flags, resolved) => {
      assert.equal(resolved, connection);
      return resolved.apiToken;
    },
    booleanFlag: (flags, name) => Boolean(flags[name]),
    output: (_flags, value, humanPrinter) => humanPrinter(value),
    deployCode: async () => {
      throw new Error('test must not deploy');
    },
    ...overrides,
  });
}

function metadata(bundlePath, head, versionId) {
  return {
    bundle_sha256: crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex'),
    git_head_sha: head,
    git_ref: 'refs/heads/main',
    template_id: 'template_sample',
    version_id: versionId,
    version: versionId === 'version_1' ? '1.0.0' : '1.1.0',
  };
}

function configureIdentity(directory) {
  git(directory, ['config', 'user.name', 'Template Test']);
  git(directory, ['config', 'user.email', 'template-test@example.com']);
}
function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'git failed').trim());
  return String(result.stdout || '');
}
function normalizeLines(value) {
  return String(value).replace(/\r\n/g, '\n');
}
