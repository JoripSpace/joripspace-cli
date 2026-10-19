const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.resolve(__dirname, '../bin/joripspace.js');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-interaction-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const openerLog = path.join(root, 'opener.jsonl');
  const preload = path.join(root, 'terminal.cjs');
  // Exercise real readline over pipes while controlling TTY detection and blocking browser launches.
  fs.writeFileSync(
    preload,
    `
    const fs = require('node:fs');
    const { EventEmitter } = require('node:events');
    const tty = process.env.JORIPSPACE_TEST_TTY === '1';
    Object.defineProperty(process.stdin, 'isTTY', { value: tty });
    Object.defineProperty(process.stdout, 'isTTY', { value: tty });
    require('node:child_process').spawn = (file, args) => {
      fs.appendFileSync(process.env.JORIPSPACE_TEST_OPENER_LOG, JSON.stringify({ file, args }) + '\\n');
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    };
  `
  );
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, body });
    const result =
      request.url === '/v1/auth/connection-code/exchange'
        ? { connect_token: 'synthetic-interaction-token' }
        : request.url === '/v1/projects'
          ? { project_id: 'my-demo', project_slug: 'my-demo', default_url: 'https://my-demo.example' }
          : request.url === '/v1/me/projects'
            ? { account_id: 'interaction-account', projects: [{ project_slug: 'demo', role: 'owner' }] }
            : request.url.endsWith('/deployments?limit=1')
              ? { deployments: [] }
              : { project_slug: 'demo', status: 'active', deployment: { mode: 'direct' } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  function run(args, { tty = false, json = true, answer, eof = false, agreements } = {}) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(JORIPSPACE_|NODE_OPTIONS$|NODE_PATH$|FORCE_COLOR$)/i.test(key)
      )
    );
    Object.assign(env, {
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      JORIPSPACE_TEST_KEYRING_FILE: path.join(root, 'keyring.json'),
      JORIPSPACE_TEST_TTY: tty ? '1' : '0',
      JORIPSPACE_TEST_OPENER_LOG: openerLog,
      FORCE_COLOR: '0',
    });
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--require',
          path.join(__dirname, 'fixtures/keyring.cjs'),
          '--require',
          preload,
          CLI,
          ...args,
          '--cwd',
          workspace,
          '--api-url',
          url,
          ...(json ? ['--json'] : []),
        ],
        { cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stdout = '',
        stderr = '',
        answered = false,
        agreementIndex = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI waited for input: ${args.join(' ')}`));
      }, 8000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (!answered && stdout.includes('연결 코드: ') && (answer !== undefined || eof)) {
          answered = true;
          child.stdin.end(eof ? undefined : `${answer}\n`);
        }
        const count = (stdout.match(/Do you agree\? \[y\/N\]: /g) || []).length;
        if (agreements && count > agreementIndex && agreementIndex < agreements.length) {
          const value = agreements[agreementIndex++];
          if (value === null || agreementIndex === agreements.length) {
            child.stdin.end(value === null ? undefined : `${value}\n`);
          } else child.stdin.write(`${value}\n`);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      // Keep stdin open: machine commands must finish without waiting for EOF.
    });
  }
  return {
    root,
    workspace,
    calls,
    run,
    browserCalls: () =>
      fs.existsSync(openerLog)
        ? fs
            .readFileSync(openerLog, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

test('terminal login accepts a connection code and reuses its saved login without another prompt', async (t) => {
  const f = await fixture(t);
  const first = await f.run(['login'], { tty: true, json: false, answer: 'abcd-efgh-jkmn-pqrs' });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /연결 코드: /);
  assert.doesNotMatch(first.stdout + first.stderr, /synthetic-interaction-token/);
  assert.equal(JSON.parse(f.calls[0].body).code, 'ABCD-EFGH-JKMN-PQRS');
  assert.equal(f.browserCalls().length, 1);
  const again = await f.run(['login'], { tty: true, json: false });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /연결 코드: /);
  assert.equal(f.browserCalls().length, 1);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/exchange')).length, 1);
  assert.equal((await f.run(['me'], { tty: true })).code, 0);
  const metadata = fs.readFileSync(path.join(f.workspace, '.env.joripspace'), 'utf8');
  assert.doesNotMatch(metadata, /TOKEN|synthetic-interaction-token/);
});

test('terminal start still accepts a connection code and continues into project onboarding', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['start', 'demo'], { tty: true, json: false, answer: 'abcd-efgh-jkmn-pqrs' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /연결 코드: /);
  assert.match(result.stdout, /Started project: demo/);
  assert.equal(f.browserCalls().length, 1);
  assert.equal((await f.run(['start', 'demo'])).code, 0);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/exchange')).length, 1);
});

test('login and start never prompt or open a browser for JSON agents, even with a TTY', async (t) => {
  const f = await fixture(t);
  for (const tty of [false, true]) {
    const login = await f.run(['login'], { tty });
    assert.equal(login.code, 0, login.stderr);
    assert.equal(JSON.parse(login.stdout).status, 'browser_connection_required');
    const start = await f.run(['start', 'demo'], { tty });
    assert.equal(start.code, 2);
    assert.equal(start.stdout, '');
    const error = JSON.parse(start.stderr).error;
    assert.equal(error.code, 'connection_required');
    assert.match(error.details.login_command, /login --code/);
    assert.match(error.details.resume_command, /start .*demo.*--json/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.browserCalls(), []);
  const connected = await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs'], { tty: true });
  assert.equal(connected.code, 0, connected.stderr);
  assert.equal(JSON.parse(connected.stdout).account_id, 'interaction-account');
  const resumed = await f.run(['start', 'demo'], { tty: true });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).ok, true);
  assert.deepEqual(f.browserCalls(), []);
});

test('piped login and start finish with guidance even without JSON or stdin EOF', async (t) => {
  const f = await fixture(t);
  const login = await f.run(['login'], { json: false });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /login --code/);
  const start = await f.run(['start', 'demo'], { json: false });
  assert.equal(start.code, 2);
  assert.doesNotMatch(login.stdout + start.stdout, /연결 코드: /);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.browserCalls(), []);
});

test('empty, invalid, and cancelled terminal code entry never reports a successful connection', async (t) => {
  const f = await fixture(t);
  for (const command of [['login'], ['start', 'demo']]) {
    for (const input of [{ answer: '' }, { answer: 'invalid' }, { eof: true }]) {
      const result = await f.run(command, { tty: true, json: false, ...input });
      assert.notEqual(result.code, 0, `${command.join(' ')}: ${JSON.stringify(input)}`);
      assert.notEqual(result.stderr, '');
    }
  }
  assert.deepEqual(f.calls, []);
});

test('every command entry point returns JSON or a JSON error without input in a TTY agent session', async (t) => {
  const f = await fixture(t);
  const commands = [...fs.readFileSync(CLI, 'utf8').matchAll(/^    case '([^']+)':/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'version');
  assert.ok(commands.length > 40);
  for (const name of commands) {
    const result = await f.run([name], { tty: true });
    if (result.code === 0) {
      assert.equal(result.stderr, '', name);
      assert.doesNotThrow(() => JSON.parse(result.stdout), name);
    } else {
      assert.equal(result.stdout, '', name);
      const error = JSON.parse(result.stderr);
      assert.equal(error.ok, false, name);
      assert.equal(typeof error.error.code, 'string', name);
    }
  }
  assert.deepEqual(f.browserCalls(), []);
});

test('Free creation returns translatable agreements to a TTY agent and creates only after explicit flags', async (t) => {
  const f = await fixture(t);
  for (const extra of [[], ['--yes'], ['--agree-noncommercial', '--agree-billing']]) {
    const result = await f.run(['create', '--name', 'my-demo', ...extra], { tty: true });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    const details = JSON.parse(result.stderr).error.details;
    assert.equal(details.agreements.length, 3);
    assert.equal(details.language, 'en');
    assert.match(details.agent_instruction, /user's language/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs'])).code, 0);
  const metadata = fs.readFileSync(path.join(f.workspace, '.env.joripspace'), 'utf8');
  const result = await f.run(
    ['create', '--name', ' MY-DEMO ', '--agree-noncommercial', '--agree-billing', '--agree-retention'],
    { tty: true }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project_slug, 'my-demo');
  const creates = f.calls.filter((call) => call.url === '/v1/projects');
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0].body), {
    name: 'my-demo',
    free_project_noncommercial_agreement: true,
    billing_agreement: true,
    free_project_retention_agreement: true,
  });
  assert.equal(fs.readFileSync(path.join(f.workspace, '.env.joripspace'), 'utf8'), metadata);
  assert.equal(fs.existsSync(path.join(f.workspace, '.joripspace')), false);
  assert.deepEqual(f.browserCalls(), []);
});

test('terminal Free creation asks all three English agreements and proceeds only after three yes answers', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['login', '--code', 'abcd-efgh-jkmn-pqrs'])).code, 0);
  const result = await f.run(['create', '--name', 'my-demo'], {
    tty: true,
    json: false,
    agreements: ['yes', 'yes', 'yes'],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/Do you agree\?/g) || []).length, 3);
  assert.match(result.stdout, /personal and non-commercial/);
  assert.match(result.stdout, /without automatic additional charges/);
  assert.match(result.stdout, /30 days or more/);
  assert.equal(f.calls.filter((call) => call.url === '/v1/projects').length, 1);
});

test('declined, empty, or cancelled terminal agreements never send a create request', async (t) => {
  const f = await fixture(t);
  for (const agreements of [['no'], [''], ['yes', 'no'], ['yes', 'yes', 'no'], [null]]) {
    const result = await f.run(['create', '--name', 'my-demo'], { tty: true, json: false, agreements });
    assert.notEqual(result.code, 0);
    assert.notEqual(result.stderr, '');
  }
  assert.deepEqual(f.calls, []);
});
