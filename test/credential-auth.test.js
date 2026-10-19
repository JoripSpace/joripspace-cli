const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

async function fixture(handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-secure-auth-'));
  const a = path.join(root, 'project-a');
  const b = path.join(root, 'project-b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, authorization: request.headers.authorization, body });
    let result = handler?.(request);
    if (!result) {
      result = {
        body:
          request.url === '/v1/auth/connection-code/exchange'
            ? { connect_token: 'synthetic-secret-token' }
            : request.url === '/v1/me/projects'
              ? { account_id: 'account-one', projects: [{ project_slug: 'demo', role: 'owner' }] }
              : request.url.endsWith('/deployments?limit=1')
                ? { deployments: [] }
                : { project_slug: 'demo', status: 'active', deployment: { mode: 'direct' } },
      };
    }
    response.writeHead(result.status || 200, { 'content-type': 'application/json', ...result.headers });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  function run(args, cwd = a, extra = {}) {
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(JORIPSPACE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key))
      );
      Object.assign(env, {
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        JORIPSPACE_TEST_KEYRING_FILE: path.join(root, 'test-keyring.json'),
        ...extra,
      });
      const child = spawn(
        process.execPath,
        [
          '--require',
          path.join(__dirname, 'fixtures/keyring.cjs'),
          path.join(__dirname, '../bin/joripspace.js'),
          ...args,
          '--cwd',
          cwd,
          '--json',
        ],
        { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }
  return {
    root,
    a,
    b,
    calls,
    url,
    run,
    async close() {
      await new Promise((done) => server.close(done));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('one code login is reused by fresh CLI processes and other folders with source-bound metadata', async () => {
  const f = await fixture();
  try {
    for (const [args, cwd] of [
      [['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.a],
      [['me', '--api-url', f.url], f.b],
      [['start', 'demo', '--api-url', f.url], f.b],
      [['get', '--api-url', 'https://must-not-use.invalid'], f.b],
    ]) {
      const result = await f.run(args, cwd);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-token/);
    }
    assert.equal(f.calls.filter((call) => call.url === '/v1/auth/connection-code/exchange').length, 1);
    for (const call of f.calls.slice(1)) assert.equal(call.authorization, 'Bearer synthetic-secret-token');
    for (const directory of [f.a, f.b]) {
      const env = fs.readFileSync(path.join(directory, '.env.joripspace'), 'utf8');
      assert.doesNotMatch(env, /TOKEN|synthetic-secret-token/);
      assert.match(env, /^JORIPSPACE_ACCOUNT_ID=account-one$/m);
      assert.match(env, /^JORIPSPACE_CONNECTION_SOURCE=os-credential-store$/m);
    }
    const nested = path.join(f.b, 'nested');
    fs.mkdirSync(nested);
    assert.equal((await f.run(['get'], nested)).code, 0);
    const unlinked = path.join(f.root, 'unlinked');
    fs.mkdirSync(unlinked);
    const wrongApi = await f.run(['me', '--api-url', 'https://another-api.invalid'], unlinked);
    assert.notEqual(wrongApi.code, 0);
  } finally {
    await f.close();
  }
});

test('login migrates an existing project credential without another code and removes every token key', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(
      path.join(f.a, '.env.joripspace'),
      `CUSTOM=keep\nJORIPSPACE_API_TOKEN=older-secret\nJORIPSPACE_API_TOKEN=synthetic-secret-token\nJORIPSPACE_CONNECT_TOKEN=obsolete-secret\nJORIPSPACE_API_BASE_URL=${f.url}\n`
    );
    const result = await f.run(['login'], f.a, { JORIPSPACE_API_URL: 'https://must-not-use.invalid' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].authorization, 'Bearer synthetic-secret-token');
    const env = fs.readFileSync(path.join(f.a, '.env.joripspace'), 'utf8');
    assert.match(env, /^CUSTOM=keep$/m);
    assert.doesNotMatch(env, /TOKEN|secret/);
    assert.equal((await f.run(['me', '--api-url', f.url], f.b)).code, 0);
  } finally {
    await f.close();
  }
});

for (const failure of ['write', 'readback']) {
  test(`failed secure ${failure} preserves the existing credential without a plaintext fallback or secret output`, async () => {
    const f = await fixture();
    try {
      const envPath = path.join(f.a, '.env.joripspace');
      const original = `CUSTOM=keep\nJORIPSPACE_API_TOKEN=synthetic-secret-token\nJORIPSPACE_API_BASE_URL=${f.url}\n`;
      fs.writeFileSync(envPath, original);
      const result = await f.run(['login'], f.a, { JORIPSPACE_TEST_KEYRING_FAILURE: failure });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).error.code, 'credential_store_unavailable');
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-token/);
      assert.equal(fs.readFileSync(envPath, 'utf8'), original);
      assert.equal(
        fs.readdirSync(f.a).some((name) => /tmp-|bak-/.test(name)),
        false
      );
    } finally {
      await f.close();
    }
  });
}

test('a locked OS store stops before a network request and exposes no native diagnostics', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    f.calls.length = 0;
    const result = await f.run(['me', '--api-url', f.url], f.a, { JORIPSPACE_TEST_KEYRING_FAILURE: 'read' });
    assert.equal(JSON.parse(result.stderr).error.code, 'credential_store_unavailable');
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /native-secret/);
    const reconnect = await f.run(['login'], f.a, { JORIPSPACE_TEST_KEYRING_FAILURE: 'read' });
    assert.equal(reconnect.code, 0, reconnect.stderr);
    assert.equal(JSON.parse(reconnect.stdout).status, 'browser_connection_required');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

for (const failure of ['unavailable', 'read']) {
  test(`${failure}: login falls back to an ignored project file and logout removes its tokens offline`, async () => {
    const f = await fixture();
    const unavailable = { JORIPSPACE_TEST_KEYRING_FAILURE: failure };
    try {
      const envPath = path.join(f.a, '.env.joripspace');
      fs.writeFileSync(envPath, 'CUSTOM=keep\n');
      const instructions = await f.run(['login', '--api-url', f.url], f.a, unavailable);
      assert.equal(instructions.code, 0, instructions.stderr);
      assert.equal(JSON.parse(instructions.stdout).status, 'browser_connection_required');
      assert.equal(f.calls.length, 0);
      const login = await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.a, unavailable);
      assert.equal(login.code, 0, login.stderr);
      assert.equal(JSON.parse(login.stdout).credential_storage, 'project-env-fallback');
      assert.doesNotMatch(login.stdout + login.stderr, /synthetic-secret-token|native-secret/);
      let contents = fs.readFileSync(envPath, 'utf8');
      assert.match(contents, /^JORIPSPACE_CONNECTION_SOURCE=project-env-fallback$/m);
      assert.equal(contents.match(/^JORIPSPACE_API_TOKEN=/gm).length, 1);
      assert.match(fs.readFileSync(path.join(f.a, '.gitignore'), 'utf8'), /\.env\.joripspace/);
      if (process.platform !== 'win32') assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
      assert.equal((await f.run(['me', '--api-url', 'https://must-not-use.invalid'], f.a, unavailable)).code, 0);
      assert.equal((await f.run(['start', 'demo'], f.a, unavailable)).code, 0);
      assert.equal(f.calls.filter(call => call.url.includes('/exchange')).length, 1);
      fs.appendFileSync(envPath, 'JORIPSPACE_CONNECT_TOKEN=obsolete-secret\nJORIPSPACE_API_TOKEN=synthetic-secret-token\n');
      const callsBeforeLogout = f.calls.length;
      const logout = await f.run(['logout'], f.a, unavailable);
      assert.equal(logout.code, 0, logout.stderr);
      assert.equal(JSON.parse(logout.stdout).os_credential_status, 'unavailable');
      assert.equal(f.calls.length, callsBeforeLogout);
      contents = fs.readFileSync(envPath, 'utf8');
      assert.doesNotMatch(contents, /TOKEN|synthetic-secret-token|obsolete-secret/);
      assert.match(contents, /^CUSTOM=keep$/m);
      assert.match(contents, /^JORIPSPACE_CONNECTION_SOURCE=logged-out$/m);
      assert.notEqual((await f.run(['me'], f.a, unavailable)).code, 0);
      assert.equal(f.calls.length, callsBeforeLogout);
      assert.equal(JSON.parse((await f.run(['login'], f.a, unavailable)).stdout).status, 'browser_connection_required');
      assert.equal(fs.readdirSync(f.a).some(name => /tmp-|bak-/.test(name)), false);
    } finally {
      await f.close();
    }
  });
}

test('fallback login migrates back to the OS store when it becomes available', async () => {
  const f = await fixture();
  try {
    const first = await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.a,
      { JORIPSPACE_TEST_KEYRING_FAILURE: 'unavailable' });
    assert.equal(first.code, 0, first.stderr);
    const recovered = await f.run(['login']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).credential_storage, 'os-credential-store');
    assert.doesNotMatch(fs.readFileSync(path.join(f.a, '.env.joripspace'), 'utf8'), /TOKEN|synthetic-secret-token/);
    assert.equal((await f.run(['me', '--api-url', f.url], f.b)).code, 0);
    assert.equal(f.calls.filter(call => call.url.includes('/exchange')).length, 1);
  } finally {
    await f.close();
  }
});

test('file fallback refuses Git-tracked credentials before exchanging a connection code', async () => {
  const f = await fixture();
  try {
    const envPath = path.join(f.a, '.env.joripspace');
    fs.writeFileSync(envPath, 'CUSTOM=keep\n');
    for (const args of [['init'], ['add', '.env.joripspace']]) {
      const result = spawnSync('git', args, { cwd: f.a, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const result = await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.a,
      { JORIPSPACE_TEST_KEYRING_FAILURE: 'unavailable' });
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stderr).error.code, 'project_env_tracked');
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'CUSTOM=keep\n');
  } finally {
    await f.close();
  }
});

test('logout clears both file and OS tokens for the same account, then OS login is reused across folders', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    const unavailable = { JORIPSPACE_TEST_KEYRING_FAILURE: 'unavailable' };
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.a, unavailable)).code, 0);
    fs.appendFileSync(path.join(f.a, '.env.joripspace'), 'JORIPSPACE_API_TOKEN=other-file-token\n');
    const count = f.calls.length;
    const logout = await f.run(['logout']);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(JSON.parse(logout.stdout).os_credential_status, 'removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'test-keyring.json'), 'utf8')), {});
    assert.doesNotMatch(fs.readFileSync(path.join(f.a, '.env.joripspace'), 'utf8'), /TOKEN|other-file-token|synthetic-secret-token/);
    assert.equal(f.calls.length, count);
    assert.notEqual((await f.run(['me'])).code, 0);
    assert.equal(f.calls.length, count);
    assert.equal((await f.run(['logout'])).code, 0);
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url], f.b)).code, 0);
    assert.equal((await f.run(['me'], f.a)).code, 0);
    assert.equal((await f.run(['me', '--api-url', f.url], f.b)).code, 0);
  } finally {
    await f.close();
  }
});

test('revoked stored tokens stop with 401 and redact echoed credentials from all error fields', async () => {
  let revoked = false;
  const f = await fixture(() =>
    revoked
      ? {
          status: 401,
          body: {
            error: {
              code: 'invalid_token',
              message: 'revoked synthetic-secret-token',
              details: { token: 'synthetic-secret-token', nested: ['synthetic-secret-token'] },
            },
          },
        }
      : null
  );
  try {
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    revoked = true;
    const result = await f.run(['me', '--api-url', f.url], f.b);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.status, 401);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-token/);
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});

test('authenticated requests reject redirects before forwarding a stored credential', async () => {
  let redirected = false;
  const f = await fixture((request) =>
    redirected ? { status: 307, headers: { location: '/redirect-target' }, body: {} } : null
  );
  try {
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    redirected = true;
    const result = await f.run(['me', '--api-url', f.url], f.b);
    assert.equal(result.code, 1);
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.calls.some((call) => call.url === '/redirect-target'),
      false
    );
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-token/);
  } finally {
    await f.close();
  }
});

test('the existing start flow also logs in, logout is offline, and reconnecting restores automatic reuse', async () => {
  const f = await fixture();
  try {
    const instructions = await f.run(['login', '--api-url', f.url]);
    assert.equal(JSON.parse(instructions.stdout).status, 'browser_connection_required');
    assert.equal(f.calls.length, 0);
    const start = await f.run(['start', 'demo', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal((await f.run(['start', 'demo', '--api-url', f.url], f.b)).code, 0);
    const before = f.calls.length;
    const logout = await f.run(['logout'], f.b);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(JSON.parse(logout.stdout).status, 'logged_out');
    assert.equal(f.calls.length, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'test-keyring.json'), 'utf8')), {});
    const blocked = await f.run(['start', 'demo'], f.a);
    assert.equal(JSON.parse(blocked.stderr).error.code, 'connection_required');
    assert.equal(f.calls.length, before);
    assert.equal((await f.run(['logout'], f.b)).code, 0);
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    assert.equal((await f.run(['me'], f.b)).code, 0);
    assert.equal(f.calls.filter((call) => call.url === '/v1/auth/connection-code/exchange').length, 2);
  } finally {
    await f.close();
  }
});

test('logout removes matching current legacy credentials and preserves unrelated session metadata', async () => {
  const f = await fixture();
  try {
    const globalDirectory = path.join(f.root, 'home/.joripspace');
    const projectDirectory = path.join(f.a, '.joripspace');
    fs.mkdirSync(globalDirectory, { recursive: true });
    fs.mkdirSync(projectDirectory);
    const session = {
      api_base_url: f.url,
      api_token: 'synthetic-secret-token',
      account: { account_id: 'account-one' },
      source: 'cli-login',
      guide_checked_at: '2026-10-19T00:00:00Z',
    };
    fs.writeFileSync(path.join(projectDirectory, 'agent-session.json'), JSON.stringify(session));
    fs.writeFileSync(
      path.join(globalDirectory, 'session.json'),
      JSON.stringify({ ...session, keep: 'global-value' })
    );
    fs.writeFileSync(
      path.join(f.a, '.env.joripspace'),
      `CUSTOM=keep\nJORIPSPACE_API_TOKEN=synthetic-secret-token\nJORIPSPACE_API_BASE_URL=${f.url}\nJORIPSPACE_ACCOUNT_ID=account-one\n`
    );
    const result = await f.run(['logout']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(projectDirectory, 'agent-session.json')), false);
    const global = fs.readFileSync(path.join(globalDirectory, 'session.json'), 'utf8');
    assert.doesNotMatch(global, /synthetic-secret-token|"api_token"/);
    assert.equal(JSON.parse(global).keep, 'global-value');
    const env = fs.readFileSync(path.join(f.a, '.env.joripspace'), 'utf8');
    assert.doesNotMatch(env, /synthetic-secret-token|JORIPSPACE_API_TOKEN/);
    assert.match(env, /^CUSTOM=keep$/m);
    assert.equal(JSON.parse((await f.run(['login'])).stdout).status, 'browser_connection_required');
  } finally {
    await f.close();
  }
});

test('failed OS credential deletion reports failure and preserves project authentication metadata', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', f.url])).code, 0);
    const envPath = path.join(f.a, '.env.joripspace');
    const before = fs.readFileSync(envPath, 'utf8');
    const result = await f.run(['logout'], f.a, { JORIPSPACE_TEST_KEYRING_FAILURE: 'delete' });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'credential_store_unavailable');
    assert.equal(fs.readFileSync(envPath, 'utf8'), before);
    assert.doesNotMatch(result.stdout + result.stderr, /native-secret|synthetic-secret-token/);
    assert.equal((await f.run(['me'])).code, 0);
  } finally {
    await f.close();
  }
});

test('logout never claims success while a caller-supplied environment token remains active', async () => {
  const f = await fixture();
  try {
    for (const extra of [
      { JORIPSPACE_API_TOKEN: 'synthetic-secret-token' },
      { JORIPSPACE_CONNECT_TOKEN: 'synthetic-secret-token' },
    ]) {
      const result = await f.run(['logout'], f.a, extra);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).error.code, 'logout_external_token');
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-token/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.a, '.env.joripspace')), false);
  } finally {
    await f.close();
  }
});

test('an existing connected start logs in to the OS store without asking for another code', async () => {
  const f = await fixture();
  try {
    const envPath = path.join(f.a, '.env.joripspace');
    fs.writeFileSync(
      envPath,
      `CUSTOM=keep\nJORIPSPACE_API_TOKEN=synthetic-secret-token\nJORIPSPACE_API_BASE_URL=${f.url}\n`
    );
    const result = await f.run(['start', 'demo']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      f.calls.some((call) => call.url === '/v1/auth/connection-code/exchange'),
      false
    );
    assert.doesNotMatch(fs.readFileSync(envPath, 'utf8'), /synthetic-secret-token|JORIPSPACE_API_TOKEN/);
    assert.equal((await f.run(['me', '--api-url', f.url], f.b)).code, 0);
  } finally {
    await f.close();
  }
});
