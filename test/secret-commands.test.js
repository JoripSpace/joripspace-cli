const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createStartOnboarding } = require('../lib/start');

const CLI = path.resolve(__dirname, '../bin/joripspace.js');
const PAGE = 'https://joripspace.com/projects/demo/?tab=secrets';

async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, url: request.url, body });
    assert.equal(request.headers.authorization, 'Bearer synthetic-cli-token');
    const result = handler ? handler(request, body) : { body: { status: 'success' } };
    response.writeHead(result.status || 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(JORIPSPACE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  function run(args, input = '') {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'secret', ...args,
        '--project', 'demo', '--api-url', `http://127.0.0.1:${server.address().port}`,
        '--token', 'synthetic-cli-token', '--json'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  return { run, calls };
}

test('set and update create/replace arbitrary values via stdin without returning echoed values', async t => {
  const f = await fixture(t, (_request, body) => ({
    body: { status: 'success', value: body.value, debug: { value: body.value } },
  }));
  const values = ['external-service-key-from-server', '\uFEFF  multiline\r\n시스템에서 만든 값\n '];
  for (const [index, command] of ['set', 'update'].entries()) {
    const result = await f.run([command, '--name', 'provider_key', '--value-stdin'], values[index]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'success', project_id: 'demo', name: 'PROVIDER_KEY', secret_management_url: PAGE,
    });
    assert.ok(!(result.stdout + result.stderr).includes(values[index]));
    assert.deepEqual(f.calls[index], {
      method: 'POST', url: '/v1/projects/demo/secrets', body: { name: 'PROVIDER_KEY', value: values[index] },
    });
  }
});

test('set accepts the 5120-byte boundary and rejects empty, oversized, or invalid UTF-8 input before HTTP', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['set', '--name', 'KEY', '--value-stdin'], 'a'.repeat(5120))).code, 0);
  for (const input of ['', 'a'.repeat(5121), '한'.repeat(1707), Buffer.from([0xff])]) {
    const result = await f.run(['set', '--name', 'KEY', '--value-stdin'], input);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  }
  assert.equal(f.calls.length, 1);
});

test('set rejects command-line values, missing stdin opt-in and invalid names before HTTP', async t => {
  const f = await fixture(t);
  for (const args of [
    ['set', '--name', 'KEY', '--value', 'never-print-this-input'],
    ['set', '--name', 'KEY'],
    ['set', '--name', 'KEY', '--value-stdin', '--value', 'never-print-this-input'],
    ['set', '--name', 'invalid-name', '--value-stdin'],
    ['set', '--value-stdin'],
  ]) {
    const result = await f.run(args, 'stdin-value');
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this-input|stdin-value/);
  }
  assert.equal(f.calls.length, 0);
});

test('server failures never echo complete or partial input values and retain a management link', async t => {
  const secret = 'upstream-private-credential';
  const f = await fixture(t, () => ({ status: 403, body: {
    error: { code: secret, message: `partial: ${secret.slice(0, 12)}`, details: { value: secret } },
  } }));
  const result = await f.run(['update', '--name', 'API_KEY', '--value-stdin'], secret);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes(secret.slice(0, 12)));
  const body = JSON.parse(result.stderr);
  assert.equal(body.error.code, 'secret_set_failed');
  assert.equal(body.error.details.secret_management_url, PAGE);
  assert.equal(body.error.details.http_status, 403);
});

test('generate and list expose the selected project management page; deletion stays web-only', async t => {
  const f = await fixture(t, (request, body) => ({ body: request.url.endsWith('/generate')
    ? { name: body.name, status: 'active', created: false }
    : { secrets: [{ name: 'KEY', status: 'active', updated_at: '2026-10-19T00:00:00.000Z' }] },
  }));
  const generated = await f.run(['generate', '--name', 'KEY']);
  assert.equal(generated.code, 0, generated.stderr);
  assert.equal(JSON.parse(generated.stdout).created, false);
  assert.equal(JSON.parse(generated.stdout).secret_management_url, PAGE);
  const listed = await f.run(['list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).secret_management_url, PAGE);
  const deleted = await f.run(['delete', '--name', 'KEY']);
  assert.notEqual(deleted.code, 0);
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET']);
});

test('start gives agents the project page and explicit creation/replacement instructions', () => {
  const onboarding = createStartOnboarding(CLI, process.cwd(), 'demo');
  assert.equal(onboarding.secret_management_url, PAGE);
  assert.match(onboarding.instructions, /secret set --name NAME --value-stdin --json/);
  assert.match(onboarding.instructions, /external server, provider, or system/);
  assert.match(onboarding.instructions, /clickable link/);
});
