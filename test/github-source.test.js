const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GITHUB_SOURCE_SCRIPT } = require('../vendor/core/github-source.cjs');

test('GitHub snapshot keeps original tracked source, config and tests before build with protected files excluded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'joripspace-github-source-'));
  const repo = path.join(root, 'repo');
  const env = ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const previous = Object.fromEntries(env.map((name) => [name, process.env[name]]));
  try {
    await fs.mkdir(repo);
    const original = {
      'src/index.ts': 'export default { fetch() { return new Response("original"); } };',
      'package.json': '{"scripts":{"build":"build-command"}}',
      'package-lock.json': '{"lockfileVersion":3}',
      'wrangler.toml': 'main = "dist/worker.js"',
      'tests/source.test.js': 'original test',
      'docs/guide.md': 'original docs',
      '.gitignore': 'ignored.txt\n',
      '.ignore': 'local.txt\n',
      '.joripspaceignore': 'private.txt\n',
      '.github/workflows/deploy.yml': 'original workflow',
    };
    const excluded = [
      '.env',
      '.env.production',
      '.dev.vars',
      'secret.key',
      'AGENTS.md',
      '.joripspace/token',
      'node_modules/pkg/index.js',
      '.agents/local.md',
      'ignored.txt',
      'local.txt',
      'private.txt',
    ];
    for (const [name, body] of Object.entries({
      ...original,
      ...Object.fromEntries(excluded.map((name) => [name, 'must not be stored'])),
    })) {
      await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await fs.writeFile(path.join(repo, name), body);
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '--force', '.'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'not part of deployed commit');
    Object.assign(process.env, {
      GITHUB_WORKSPACE: repo,
      RUNNER_TEMP: root,
      GITHUB_RUN_ID: 'test',
      GITHUB_RUN_ATTEMPT: '1',
    });
    await import('data:text/javascript;base64,' + Buffer.from(GITHUB_SOURCE_SCRIPT + '\nawait snapshotGithubSource();').toString('base64'));
    await fs.writeFile(path.join(repo, 'src/index.ts'), 'build changed the source');
    const snapshot = path.join(root, 'joripspace-source-test-1');
    for (const [name, body] of Object.entries(original))
      assert.equal(await fs.readFile(path.join(snapshot, name), 'utf8'), body);
    for (const name of [...excluded, 'untracked.txt'])
      await assert.rejects(fs.access(path.join(snapshot, name)), { code: 'ENOENT' });
  } finally {
    for (const name of env) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
