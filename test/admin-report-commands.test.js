const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '../bin/joripspace.js');
const PRELOAD = path.join(__dirname, 'fixtures/keyring.cjs');
const ID = 'air_' + 'a'.repeat(32);
const SECRET = 'synthetic-admin-credential-for-tests';

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-admin-test-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const call = { url: req.url, method: req.method, admin: req.headers['x-joripspace-admin-token'], authorization: req.headers.authorization, body: text ? JSON.parse(text) : null };
    calls.push(call);
    const value = handler?.(call) || { status: 200, body: { items: [{ report_id: ID, status: 'open', project_id: 'demo', summary: 'Test report', created_at: '2026-11-26T00:00:00Z' }], next_cursor: 'next/page+2=' } };
    res.writeHead(value.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value.body));
  });
  server.keepAliveTimeout = 60_000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const keyring = path.join(root, 'synthetic-keyring.json');
  function run(args, input = '', env = {}, destination = api) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', PRELOAD, CLI, 'admin', ...args, ...(destination ? ['--api-url', destination] : []), '--cwd', workspace, '--json'], {
        cwd: workspace, env: { ...process.env, JORIPSPACE_TEST_KEYRING_FILE: keyring, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', x => { stdout += x; });
      child.stderr.on('data', x => { stderr += x; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { run, calls, workspace, keyring, api };
}

test('administrator login, filtered pagination, detail, status changes and offline logout use the existing API', async t => {
  const f = await fixture(t, call => {
    if (call.method === 'PATCH') return { status: 200, body: { ok: true, report_id: ID, status: call.body.status } };
    if (call.url === `/v1/internal/agent-reports/${ID}`) return { status: 200, body: { report: { report_id: ID, status: 'open', project_id: 'demo', details: 'Details' } } };
  });
  let r = await f.run(['login', '--token-stdin'], SECRET + '\n');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).credential_storage, 'os-credential-store');
  assert.ok(!r.stdout.includes(SECRET));
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(f.keyring))).every(key => key.startsWith('com.joripspace.cli.admin.v1:')));
  r = await f.run(['reports', 'list', '--status', 'open', '--category', 'bug', '--limit', '2', '--cursor', 'next/page+2=']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).next_cursor, 'next/page+2=');
  const query = new URL(f.calls.at(-1).url, f.api).searchParams;
  assert.deepEqual(Object.fromEntries(query), { status: 'open', category: 'bug', limit: '2', cursor: 'next/page+2=' });
  r = await f.run(['reports', 'get', ID]);
  assert.equal(JSON.parse(r.stdout).report.details, 'Details');
  for (const status of ['resolved', 'open', 'dismissed']) {
    r = await f.run(['reports', 'update', ID, '--status', status]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, status);
    assert.deepEqual(f.calls.at(-1).body, { status });
  }
  assert.ok(f.calls.every(call => call.admin === SECRET && call.authorization === undefined));
  const count = f.calls.length;
  assert.equal((await f.run(['logout'])).code, 0);
  assert.equal(f.calls.length, count);
  r = await f.run(['reports', 'list']);
  assert.equal(r.code, 1);
  assert.equal(f.calls.length, count);
  assert.equal(fs.existsSync(path.join(f.workspace, '.env.joripspace')), false);
});

test('admin commands reject invalid IDs, statuses and argument credentials before network access', async t => {
  const f = await fixture(t);
  for (const args of [
    ['reports', 'get', '../other'], ['reports', 'update', ID, '--status', 'done'],
    ['reports', 'list', '--limit', '101'], ['reports', 'list', '--category', 'other'],
    ['reports', 'list', '--token', SECRET], ['login'],
  ]) {
    const r = await f.run(args);
    assert.equal(r.code, 1);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  }
  assert.equal(f.calls.length, 0);
});

test('one-time stdin credentials work without OS storage and neither error responses nor successful output reveal them', async t => {
  let rejected = true;
  const f = await fixture(t, () => rejected
    ? { status: 401, body: { error: { code: 'admin_auth_required', message: SECRET + ' partial-secret' } } }
    : { status: 200, body: { items: [{ summary: SECRET }], next_cursor: null } });
  let r = await f.run(['reports', 'list', '--token-stdin'], SECRET, { JORIPSPACE_TEST_KEYRING_FAILURE: 'unavailable' });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).error.status, 401);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  assert.ok(!r.stderr.includes('partial-secret'));
  rejected = false;
  r = await f.run(['reports', 'list', '--token-stdin'], SECRET, { JORIPSPACE_TEST_KEYRING_FAILURE: 'unavailable' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET));
  assert.equal(fs.existsSync(f.keyring), false);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('failed secure storage verification never falls back to plaintext', async t => {
  const f = await fixture(t);
  const r = await f.run(['login', '--token-stdin'], SECRET, { JORIPSPACE_TEST_KEYRING_FAILURE: 'readback' });
  assert.equal(r.code, 1);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('project files and environment cannot redirect a stored administrator credential', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['login', '--token-stdin'], SECRET)).code, 0);
  const envText = `JORIPSPACE_API_URL=${f.api}\n`;
  fs.writeFileSync(path.join(f.workspace, '.env.joripspace'), envText);
  const count = f.calls.length;
  const r = await f.run(['reports', 'list'], '', { JORIPSPACE_API_URL: f.api }, null);
  assert.equal(r.code, 1);
  assert.equal(f.calls.length, count);
  assert.equal(fs.readFileSync(path.join(f.workspace, '.env.joripspace'), 'utf8'), envText);
});
