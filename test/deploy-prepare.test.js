const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareDeployment } = require('../lib/deploy-prepare');

test('prepare saves a repeatable build/deploy command and preserves custom scripts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { build: 'node build.mjs', test: 'node --test' } }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(
    path.join(root, 'dist/worker.js'),
    'export default { fetch() { return new Response("ok"); } };'
  );
  const flags = { dir: 'dist', entrypoint: 'worker.js' };
  const write = (file, text) => fs.writeFileSync(file, text);
  const result = prepareDeployment(root, flags, write);
  assert.equal(result.deployed, false);
  const saved = JSON.parse(fs.readFileSync(pkg));
  assert.equal(saved.scripts.test, 'node --test');
  assert.equal(
    saved.scripts['joripspace:deploy'],
    'npm run build && npx --yes @joripspace/cli@latest deploy --cwd . --dir "dist" --entrypoint "worker.js"'
  );
  assert.deepEqual(prepareDeployment(root, flags, write), result);
  for (const dir of ['../outside', 'dist/../../outside', 'dist$(echo)', 'dist%TEMP%', 'dist&echo']) {
    assert.throws(() => prepareDeployment(root, { ...flags, dir }, write));
  }
  saved.scripts['joripspace:deploy'] = 'custom deployment';
  fs.writeFileSync(pkg, JSON.stringify(saved));
  const previous = fs.readFileSync(pkg, 'utf8');
  assert.throws(() => prepareDeployment(root, flags, write), /preserved/);
  assert.equal(fs.readFileSync(pkg, 'utf8'), previous);
  fs.unlinkSync(path.join(root, 'dist/worker.js'));
  assert.throws(() => prepareDeployment(root, flags, write), /Build the project first/);
});
