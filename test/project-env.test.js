const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  ensureProjectEnvIgnored,
  readDotEnvFile,
  readProjectEnv,
  updateDotEnvFile,
} = require('../lib/project-env');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

test('project env update normalizes duplicate keys, quotes values, and is ignored before use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-'));
  const envPath = path.join(root, '.env.joripspace');
  try {
    fs.writeFileSync(envPath, 'CUSTOM=keep\n  TOKEN = first\nTOKEN="last value"\n');
    ensureProjectEnvIgnored(root);
    updateDotEnvFile(envPath, { TOKEN: 'replacement value', URL: 'https://example.test' });
    const source = fs.readFileSync(envPath, 'utf8');
    assert.equal(source.match(/^TOKEN=/gm).length, 1);
    assert.match(source, /^TOKEN="replacement value"$/m);
    assert.match(source, /^CUSTOM=keep$/m);
    assert.deepEqual(readDotEnvFile(envPath), {
      CUSTOM: 'keep',
      TOKEN: 'replacement value',
      URL: 'https://example.test',
    });
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.env\.joripspace$/m);
    if (process.platform !== 'win32') assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project environment reads are pure and never import or rewrite a legacy session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-source-'));
  const sessionDir = path.join(root, '.joripspace');
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(root, '.env.joripspace'),
      'JORIPSPACE_API_BASE_URL=https://stale-env.example\n'
    );
    fs.writeFileSync(
      path.join(sessionDir, 'agent-session.json'),
      `${JSON.stringify({ api_base_url: 'https://legacy.example', api_token: 'legacy-token' })}\n`
    );
    const envBefore = fs.readFileSync(path.join(root, '.env.joripspace'), 'utf8');
    const sessionBefore = fs.readFileSync(path.join(sessionDir, 'agent-session.json'), 'utf8');
    const read = readProjectEnv(root);
    assert.deepEqual(read, { JORIPSPACE_API_BASE_URL: 'https://stale-env.example' });
    assert.equal(fs.readFileSync(path.join(root, '.env.joripspace'), 'utf8'), envBefore);
    assert.equal(fs.readFileSync(path.join(sessionDir, 'agent-session.json'), 'utf8'), sessionBefore);
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);

    fs.writeFileSync(
      path.join(root, '.env.joripspace'),
      'JORIPSPACE_API_TOKEN=project-token\nJORIPSPACE_API_BASE_URL=https://project.example\n'
    );
    fs.writeFileSync(
      path.join(sessionDir, 'agent-session.json'),
      `${JSON.stringify({ api_base_url: 'https://wrong.example', api_token: 'wrong-token' })}\n`
    );
    const existing = readProjectEnv(root);
    assert.equal(existing.JORIPSPACE_API_TOKEN, 'project-token');
    assert.equal(existing.JORIPSPACE_API_BASE_URL, 'https://project.example');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tracked project environment is rejected before login/link-style reads or legacy migration writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-tracked-'));
  const envPath = path.join(root, '.env.joripspace');
  const sessionDir = path.join(root, '.joripspace');
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const trackedPath = path.join(root, '.ENV.JORIPSPACE');
    fs.writeFileSync(trackedPath, 'JORIPSPACE_API_TOKEN=tracked-token\n');
    fs.writeFileSync(
      path.join(sessionDir, 'agent-session.json'),
      `${JSON.stringify({ api_token: 'legacy-token', api_base_url: 'https://legacy.example' })}\n`
    );
    git(root, ['init']);
    git(root, ['add', '.ENV.JORIPSPACE']);
    const before = fs.readFileSync(trackedPath, 'utf8');
    for (const action of [
      () => ensureProjectEnvIgnored(root),
      () => readProjectEnv(root),
      () => updateDotEnvFile(envPath, { JORIPSPACE_API_TOKEN: 'replacement' }),
    ]) {
      assert.throws(action, (error) => error?.code === 'project_env_tracked');
    }
    assert.equal(fs.readFileSync(trackedPath, 'utf8'), before);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(sessionDir, 'agent-session.json'), 'utf8')).api_token,
      'legacy-token'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a trailing exact ignore overrides a prior project-environment negation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-negation-'));
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), '*.env*\n!.env.joripspace\nkeep.txt\n');
    assert.equal(ensureProjectEnvIgnored(root), true);
    const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').trimEnd().split(/\r?\n/);
    assert.equal(lines.at(-1), '.env.joripspace');
    assert.ok(lines.includes('!.env.joripspace'));
    assert.ok(lines.includes('keep.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project environment writes fail closed when Git metadata cannot be verified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-invalid-git-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    assert.throws(
      () => ensureProjectEnvIgnored(root),
      (error) => error?.code === 'project_env_git_verification_failed'
    );
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connect_token-only legacy project session is not mutated by a connection read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-connect-'));
  const sessionDir = path.join(root, '.joripspace');
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(sessionDir, 'agent-session.json'),
      `${JSON.stringify({ connect_token: 'legacy-connect-token' })}\n`
    );
    const migrated = readProjectEnv(root);
    assert.deepEqual(migrated, {});
    const session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'agent-session.json'), 'utf8'));
    assert.equal(session.connect_token, 'legacy-connect-token');
    assert.equal(fs.existsSync(path.join(root, '.env.joripspace')), false);
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project authentication files refuse symlinks before reading or updating external files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-outside-'));
  const outsideEnv = path.join(outside, 'external.env');
  const outsideIgnore = path.join(outside, 'external.gitignore');
  fs.writeFileSync(outsideEnv, 'JORIPSPACE_API_TOKEN=external-secret\n');
  fs.writeFileSync(outsideIgnore, 'keep-external\n');
  try {
    try {
      fs.symlinkSync(outsideEnv, path.join(root, '.env.joripspace'), 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    assert.throws(() => readProjectEnv(root), /symbolic link or junction/);
    assert.equal(fs.readFileSync(outsideEnv, 'utf8'), 'JORIPSPACE_API_TOKEN=external-secret\n');

    fs.rmSync(path.join(root, '.env.joripspace'), { force: true });
    fs.symlinkSync(outsideIgnore, path.join(root, '.gitignore'), 'file');
    assert.throws(() => ensureProjectEnvIgnored(root), /symbolic link or junction/);
    assert.equal(fs.readFileSync(outsideIgnore, 'utf8'), 'keep-external\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('project authentication rejects portable casing aliases without reading or rewriting them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-project-env-case-'));
  const alias = path.join(root, '.EnV.JoRiPsPaCe');
  try {
    fs.writeFileSync(alias, 'JORIPSPACE_API_TOKEN=must-not-read\n');
    assert.throws(
      () => readProjectEnv(root),
      (error) => error?.code === 'non_canonical_workspace_path'
    );
    assert.equal(fs.readFileSync(alias, 'utf8'), 'JORIPSPACE_API_TOKEN=must-not-read\n');
    assert.deepEqual(fs.readdirSync(root), ['.EnV.JoRiPsPaCe']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
