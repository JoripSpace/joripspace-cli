const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { unzipSync } = require('fflate');
const { runCheckpointOperation } = require('../lib/checkpoint-client');
const { createTemplateCommands } = require('../lib/template-commands');
const { redactAuthError } = require('../lib/auth-redaction');

const TOKEN = 'synthetic-http-security-token';
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-http-security-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('joripspace-http-security-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'worker.js'), 'export default {fetch(){return new Response("ok")}}');
  return root;
}
function write(root, name, contents) {
  const target = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
async function server(t, handler) {
  const requests = [];
  const instance = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const item = {
      url: request.url,
      method: request.method,
      body: Buffer.concat(chunks),
      headers: request.headers,
    };
    requests.push(item);
    await handler(item, response);
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}
function json(response, body = {}, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
async function cli(root, url, args, machine = true) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(JORIPSPACE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)),
  );
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, '../bin/joripspace.js'),
      ...args,
      '--cwd',
      root,
      '--project',
      'audit-demo',
      '--api-url',
      url,
      '--token',
      TOKEN,
      ...(machine ? ['--json'] : []),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

test('inline and archive CLI deployments omit the same ignored credentials from actual request bytes', async (t) => {
  const root = workspace(t);
  write(root, '.gitignore', '*.pem\n.env\nignored/\n!keep.pem\n.env.joripspace\n');
  write(root, '.ignore', 'local-only.txt\n');
  write(root, '.joripspaceignore', 'platform-only.txt\n');
  write(root, '.env', 'SYNTHETIC_ENV=must-not-upload');
  write(root, 'private.pem', 'synthetic-private-key');
  write(root, 'keep.pem', 'public fixture intentionally included');
  write(root, 'ignored/nested.txt', 'must-not-upload');
  write(root, 'local-only.txt', 'must-not-upload');
  write(root, 'platform-only.txt', 'must-not-upload');
  write(root, 'nested/.gitignore', '*.secret\n!public.secret\n');
  write(root, 'nested/private.secret', 'must-not-upload');
  write(root, 'nested/public.secret', 'public fixture intentionally included');
  write(root, '.env.joripspace', 'JORIPSPACE_API_TOKEN=synthetic-local-only');
  let inline, archive;
  const parts = [];
  const api = await server(t, (request, response) => {
    if (request.url.endsWith('/checkpoint-uploads'))
      return json(response, {
        checkpoint_id: 'audit',
        chunk_size: 1_048_576,
        upload_part_url_template: '/parts/{part_number}',
        complete_url: '/complete',
      });
    if (request.url.startsWith('/parts/')) {
      parts.push(request.body);
      return json(response);
    }
    if (request.url.startsWith('/complete')) {
      archive = unzipSync(Buffer.concat(parts));
      return json(response);
    }
    if (request.url.endsWith('/checkpoints/audit'))
      return json(response, { checkpoint_id: 'audit', status: 'ready', deployable: true });
    if (request.url.endsWith('/deploy')) {
      if (request.url === '/v1/projects/audit-demo/deploy') inline = JSON.parse(request.body).files;
      return json(response, { status: 'success', deployment_id: 'audit-deployment' });
    }
    return json(response, {}, 404);
  });
  const args = ['deploy', '--dir', root, '--entrypoint', 'worker.js', '--label', 'security test'];
  const small = await cli(root, api.url, args);
  assert.equal(small.code, 0, small.stderr);
  assert.ok(inline && !archive, 'small source should still use the inline path');
  write(root, 'worker.js', 'export default {};\n//' + 'x'.repeat(17_000));
  const large = await cli(root, api.url, args);
  assert.equal(large.code, 0, large.stderr);
  assert.ok(archive, 'large source should retain the archive path');
  assert.deepEqual(
    Object.keys(inline).sort(),
    Object.keys(archive)
      .filter((name) => !name.startsWith('.joripspace/'))
      .sort(),
  );
  for (const files of [inline, archive]) {
    for (const name of [
      '.env',
      'private.pem',
      'ignored/nested.txt',
      'local-only.txt',
      'platform-only.txt',
      'nested/private.secret',
      '.env.joripspace',
    ]) {
      assert.equal(Object.hasOwn(files, name), false, `${name} must not be uploaded`);
    }
    assert.ok(Object.hasOwn(files, 'keep.pem'));
    assert.ok(Object.hasOwn(files, 'nested/public.secret'));
    assert.doesNotMatch(JSON.stringify(files), /must-not-upload|synthetic-private-key|synthetic-local-only/);
  }
});

test('checkpoint uploads reject cross-origin and same-origin redirects before sending another request', async (t) => {
  const root = workspace(t);
  const destination = await server(t, (_request, response) => json(response));
  for (const status of [301, 302, 303, 307, 308]) {
    const source = await server(t, (request, response) => {
      if (request.url.endsWith('/checkpoint-uploads'))
        return json(response, {
          checkpoint_id: 'audit',
          chunk_size: 1_048_576,
          upload_part_url_template: '/parts/{part_number}',
          complete_url: '/complete',
        });
      response.writeHead(status, { location: `${destination.url}/capture` });
      response.end();
    });
    const result = await cli(root, source.url, ['checkpoint', 'save', '--label', 'audit']);
    assert.equal(result.code, 1);
    assert.equal(source.requests.length, 2);
    assert.equal(destination.requests.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));
  }
  const same = await server(t, (_request, response) => {
    response.writeHead(307, { location: '/redirect-target' });
    response.end();
  });
  const result = await cli(root, same.url, ['checkpoint', 'save', '--label', 'audit']);
  assert.equal(result.code, 1);
  assert.equal(same.requests.length, 1);
});

test('authenticated template requests reject redirects and CLI errors never echo credentials', async (t) => {
  const root = workspace(t);
  const destination = await server(t, (_request, response) => json(response));
  const redirecting = await server(t, (_request, response) => {
    response.writeHead(307, { location: `${destination.url}/capture` });
    response.end();
  });
  const redirect = await cli(root, redirecting.url, [
    'install-template',
    '--template',
    'audit-template',
    '--dir',
    root,
    '--files-only',
  ]);
  assert.equal(redirect.code, 1);
  assert.equal(redirecting.requests.length, 1);
  assert.equal(destination.requests.length, 0);
  const failure = await server(t, (_request, response) =>
    json(
      response,
      {
        error: { code: `denied-${TOKEN}`, message: `denied ${TOKEN}`, details: { [TOKEN]: [TOKEN] } },
      },
      401,
    ),
  );
  for (const args of [
    ['checkpoint', 'save', '--label', 'audit'],
    ['install-template', '--template', 'audit-template', '--dir', root, '--files-only'],
  ]) {
    for (const machine of [true, false]) {
      const result = await cli(root, failure.url, args, machine);
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));
      assert.match(result.stderr, /REDACTED/);
      if (machine && args[0] === 'checkpoint') assert.equal(JSON.parse(result.stderr).error.status, 401);
    }
  }
});

test('checkpoint and template network failures redact known credentials', async (t) => {
  const root = workspace(t);
  t.mock.method(global, 'fetch', async () => {
    throw new Error(`network failure ${TOKEN}`);
  });
  await assert.rejects(
    runCheckpointOperation('save', {
      workspaceDir: root,
      projectId: 'audit-demo',
      apiBaseUrl: 'https://api.test',
      apiToken: TOKEN,
      label: 'audit',
    }),
    (error) => error.code === 'request_failed' && !error.message.includes(TOKEN),
  );
  const templates = createTemplateCommands({
    requireProjectId: () => 'audit-demo',
    stringFlag: (flags, name) => flags[name] || '',
    booleanFlag: () => false,
    resolveConnection: () => ({ apiBaseUrl: 'https://api.test' }),
    requireApiToken: () => TOKEN,
  });
  await assert.rejects(
    templates.install({ template: 'audit-template', dir: root }),
    (error) => !error.message.includes(TOKEN),
  );
});

test('shared credential redaction covers nested fields, keys and overlapping tokens without mutating input', () => {
  const input = {
    code: 'denied',
    message: 'token-long token',
    details: { 'token-long': ['token-long', 'token', 401, null] },
  };
  const safe = redactAuthError(input, ['token', 'token-long', undefined]);
  assert.equal(safe.code, 'denied');
  assert.equal(safe.message, '[REDACTED] [REDACTED]');
  assert.deepEqual(safe.details, { '[REDACTED]': ['[REDACTED]', '[REDACTED]', 401, null] });
  assert.match(input.message, /token-long/);
});
