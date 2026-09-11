const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.resolve(__dirname, '..', 'bin', 'joripspace.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-cli-contract-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.joripspace'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.joripspace', 'project'), 'demo\n');
  return { root, workspace };
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function apiServer(handler) {
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const result = await handler(request, body);
    response.writeHead(result?.status || 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result?.body ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function writeConnection(workspace, apiUrl) {
  fs.writeFileSync(
    path.join(workspace, '.env.joripspace'),
    `JORIPSPACE_API_TOKEN=stale\nJORIPSPACE_API_BASE_URL="${apiUrl}"\nJORIPSPACE_API_TOKEN='project-token'\n`
  );
}

test('agent report submits platform diagnostics through the CLI-only API route', async () => {
  const { root, workspace } = fixture();
  let received;
  const api = await apiServer((request, body) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/projects/demo/agent-reports');
    assert.equal(request.headers.authorization, 'Bearer project-token');
    assert.equal(request.headers['x-joripspace-session-context'], 'cli');
    received = body;
    return { status: 201, body: { ok: true, report_id: 'air_test', status: 'open' } };
  });
  try {
    writeConnection(workspace, api.url);
    const result = await runCli([
      'report', '--cwd', workspace, '--category', 'bug', '--summary', '빈 저장소 연결 실패',
      '--details', 'start가 실패했습니다.', '--expected', '저장소 초기화', '--actual', 'clone 오류',
      '--error-code', 'github_repository_sync_conflict', '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).report_id, 'air_test');
    assert.equal(received.category, 'bug');
    assert.equal(received.summary, '빈 저장소 연결 실패');
    assert.equal(received.error_code, 'github_repository_sync_conflict');
    assert.equal(received.runtime_version, process.version);
    assert.equal(received.platform_name, process.platform);
    assert.doesNotMatch(result.stdout + result.stderr, /project-token/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('realtime v2 management uses the project credential and encoded key cursor without exposing it', async () => {
  const { root, workspace } = fixture();
  const calls = [];
  const api = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer project-token');
    calls.push([request.method, request.url]);
    return { body: { status: 'active' } };
  });
  try {
    writeConnection(workspace, api.url);
    for (const args of [
      ['status'], ['activate'], ['rotate'], ['disable'],
      ['keys', '--cursor', 'key+cursor/='], ['revoke-key', '--kid', 'key_1'], ['deletion'],
    ]) {
      const result = await runCli(['realtime-v2', ...args, '--cwd', workspace, '--json']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'active');
      assert.doesNotMatch(result.stdout + result.stderr, /project-token/);
    }
    const base = '/v1/projects/demo/realtime-v2';
    assert.deepEqual(calls, [
      ['GET', base], ['POST', base + '/activate'], ['POST', base + '/rotate'],
      ['POST', base + '/disable'], ['GET', base + '/keys?after=key%2Bcursor%2F%3D'],
      ['DELETE', base + '/keys/key_1'], ['GET', base + '/deletion'],
    ]);
    const invalid = await runCli(['realtime-v2', 'revoke-key', '--kid', '../other', '--cwd', workspace, '--json']);
    assert.notEqual(invalid.code, 0);
    assert.equal(calls.length, 7);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('github prepare writes only the connection workflow for an empty remote', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer project-token');
    if (request.url === '/v1/projects/demo') {
      return {
        body: {
          project_id: 'demo',
          project_slug: 'demo',
          deployment: {
            mode: 'github_actions',
            connection_id: 'build_connection_test',
            repository: 'example/project',
            branch: 'main',
            trigger_type: 'branch',
            trigger_ref: 'main',
            workflow_path: '.github/workflows/joripspace-build_connection_test.yml',
            source_status: 'empty',
          },
        },
      };
    }
    return { status: 404, body: { message: `unhandled ${request.url}` } };
  });
  try {
    writeConnection(workspace, api.url);
    fs.writeFileSync(path.join(workspace, 'worker.js'), 'export default { fetch() { return new Response("ok"); } };\n');
    const init = require('node:child_process').spawnSync('git', ['-C', workspace, 'init', '--initial-branch', 'main'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const remote = require('node:child_process').spawnSync(
      'git',
      ['-C', workspace, 'remote', 'add', 'origin', 'https://github.com/example/project.git'],
      { encoding: 'utf8' }
    );
    assert.equal(remote.status, 0, remote.stderr);
    const result = await runCli(['github', 'prepare', '--cwd', workspace, '--json']);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'prepared');
    assert.equal(body.entrypoint, 'worker.js');
    const workflow = fs.readFileSync(path.join(workspace, ...body.workflow_path.split('/')), 'utf8');
    assert.match(workflow, /JORIPSPACE_CONNECTION_ID: "build_connection_test"/u);
    assert.match(workflow, /JORIPSPACE_ENTRYPOINT: "worker.js"/u);
    assert.match(workflow, /done < <\(find \./u);
    assert.doesNotMatch(workflow, /\n\+/u);
    assert.equal(fs.existsSync(path.join(workspace, 'README.md')), false);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deployment history and detail expose the failing commit and source location', async () => {
  const {root,workspace}=fixture();
  const failure={deployment_id:'dep-failed',status:'failed',error_stage:'github_build',error_code:'github_failure',error_details:'src/app.ts:12:4 SyntaxError',github:{commit_sha:'a'.repeat(40),run_attempt:2,run_url:'https://github.com/owner/repo/actions/runs/123'}};
  const calls=[];
  const api=await apiServer(request=>{calls.push(request.url);return {body:request.url.includes('?')?{deployments:[failure]}:failure};});
  try {
    writeConnection(workspace,api.url);
    for(const args of [['deployments','--include-failure-details'],['deployment','get','--deployment','dep-failed']]) {
      const result=await runCli([...args,'--cwd',workspace,'--json']);
      assert.equal(result.code,0,result.stderr);
      assert.match(result.stdout,/src\/app.ts:12:4/);assert.match(result.stdout,/aaaaaaaa/);
    }
    assert.deepEqual(calls,['/v1/projects/demo/deployments?include_failure_details=true','/v1/projects/demo/deployments/dep-failed']);
  } finally {await api.close();fs.rmSync(root,{recursive:true,force:true});}
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(root, args) {
  const result = require('node:child_process').spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

test('project connection parsing uses the final quoted value and keeps token/API URL source-bound', async () => {
  const { root, workspace } = fixture();
  let primaryCalls = 0;
  let alternateCalls = 0;
  const primary = await apiServer((request) => {
    primaryCalls += 1;
    assert.equal(request.headers.authorization, 'Bearer project-token');
    return { body: { project_id: 'demo', project_slug: 'demo', status: 'active' } };
  });
  const alternate = await apiServer(() => {
    alternateCalls += 1;
    return { body: { project_id: 'wrong' } };
  });
  try {
    writeConnection(workspace, primary.url);
    const result = await runCli(['get', '--cwd', workspace, '--api-url', alternate.url, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).project_id, 'demo');
    assert.equal(primaryCalls, 1);
    assert.equal(alternateCalls, 0);
  } finally {
    await primary.close();
    await alternate.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start uses the project environment connection as one record and secures its ignore rule', async () => {
  const { root, workspace } = fixture();
  let alternateCalls = 0;
  const primary = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer project-token');
    if (request.url === '/v1/me/projects') {
      return { body: { projects: [{ name: 'Demo', project_slug: 'demo', role: 'owner' }] } };
    }
    if (request.url === '/v1/projects/demo') {
      return { body: { project_slug: 'demo', status: 'active', deployment: { mode: 'direct' } } };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') {
      return { body: { deployments: [] } };
    }
    return { status: 404, body: { message: `unhandled ${request.url}` } };
  });
  const alternate = await apiServer(() => {
    alternateCalls += 1;
    return { status: 500, body: { message: 'project token must not use a process URL' } };
  });
  try {
    writeConnection(workspace, primary.url);
    assert.equal(fs.existsSync(path.join(workspace, '.gitignore')), false);
    const result = await runCli(['start', 'Demo', '--cwd', workspace, '--json'], {
      env: {
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        PATH: '',
        JORIPSPACE_API_TOKEN: '',
        JORIPSPACE_CONNECT_TOKEN: '',
        JORIPSPACE_API_URL: alternate.url,
        JORIPSPACE_API_BASE_URL: '',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(alternateCalls, 0);
    assert.equal(
      fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8').trimEnd().split(/\r?\n/).at(-1),
      '.env.joripspace'
    );
  } finally {
    await primary.close();
    await alternate.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP parity CLI commands reach their project endpoints', async () => {
  const { root, workspace } = fixture();
  const calls = [];
  const api = await apiServer((request, body) => {
    calls.push({ url: request.url, method: request.method, body });
    if (request.url === '/v1/knowledge/search?q=deploy&limit=2') return { body: { results: [] } };
    if (request.url === '/v1/templates') return { body: { templates: [] } };
    if (request.url.endsWith('/secrets/generate')) return { body: { name: body.name, generated: true } };
    if (request.url.endsWith('/secrets')) return { body: { secrets: [] } };
    if (request.url.endsWith('/crons')) return { body: { crons: [] } };
    if (request.url.endsWith('/domains')) return { body: { domains: [] } };
    if (request.url.endsWith('/mail/status'))
      return { body: { mail: { configured: false, status: 'missing' } } };
    return { status: 404, body: { error: { message: `unhandled: ${request.url}` } } };
  });
  try {
    writeConnection(workspace, api.url);
    const commands = [
      ['knowledge', 'search', '--query', 'deploy', '--limit', '2'],
      ['template', 'list'],
      ['secret', 'generate', '--name', 'SESSION_SECRET'],
      ['secret', 'list'],
      ['crons'],
      ['domains'],
      ['mail', 'status'],
    ];
    for (const command of commands) {
      const result = await runCli([...command, '--cwd', workspace, '--json']);
      assert.equal(result.code, 0, `${command.join(' ')}: ${result.stderr}`);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        '/v1/knowledge/search?q=deploy&limit=2',
        '/v1/templates',
        '/v1/projects/demo/secrets/generate',
        '/v1/projects/demo/secrets',
        '/v1/projects/demo/crons',
        '/v1/projects/demo/domains',
        '/v1/projects/demo/mail/status',
      ]
    );
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deploy includes customer-sensitive files, excludes platform files, and requires explicit storage input', async () => {
  const { root, workspace } = fixture();
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'worker.js'),
    'export default { fetch() { return new Response("ok"); } };\n'
  );
  fs.writeFileSync(path.join(source, '.env.production'), 'API_KEY=do-not-send\n');
  fs.writeFileSync(path.join(source, '.dev.vars.local'), 'API_KEY=do-not-send\n');
  fs.writeFileSync(path.join(source, '.npmrc'), 'token=do-not-send\n');
  fs.writeFileSync(path.join(source, '.pypirc'), 'password=do-not-send\n');
  fs.writeFileSync(path.join(source, '_netrc'), 'password do-not-send\n');
  fs.writeFileSync(path.join(source, 'private.pem'), 'private\n');
  fs.writeFileSync(path.join(source, 'service-account-prod.json'), '{"private_key":"do-not-send"}\n');
  fs.writeFileSync(path.join(source, 'secrets.json'), '{"feature":"ordinary-app-data"}\n');
  for (const moduleName of ['secret.ts', 'session.ts', 'token.ts', 'credentials.ts']) {
    fs.writeFileSync(path.join(source, moduleName), 'export const value = true;\n');
  }
  fs.mkdirSync(path.join(source, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(source, '.aws', 'credentials'), 'do-not-send\n');
  fs.mkdirSync(path.join(source, 'nested', '.aws'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', '.aws', 'credentials'), 'do-not-send\n');
  fs.mkdirSync(path.join(source, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(source, '.ssh', 'config'), 'do-not-send\n');
  fs.mkdirSync(path.join(source, '.AgEnTs'), { recursive: true });
  fs.writeFileSync(path.join(source, '.AgEnTs', 'settings.json'), '{"protected":true}\n');
  fs.mkdirSync(path.join(source, '.OpEnCoDe'), { recursive: true });
  fs.writeFileSync(path.join(source, '.OpEnCoDe', 'config.json'), '{"protected":true}\n');
  let deployBody;
  let deployCalls = 0;
  const api = await apiServer((request, body) => {
    if (request.url === '/v1/projects/demo/deploy') {
      deployCalls += 1;
      deployBody = body;
      return {
        body: {
          deployment_id: 'dep-1',
          status: 'success',
          url: 'https://demo.example',
          warnings: [
            {
              code: 'possible_embedded_secret',
              file_name: '.env.production',
              detection_type: 'sensitive_file_path',
              message:
                '민감정보 가능성 경고: .env.production (sensitive_file_path). 고객 책임으로 파일을 포함해 배포를 계속했습니다.',
            },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });
  try {
    writeConnection(workspace, api.url);
    const deploy = await runCli([
      'deploy',
      '--cwd',
      workspace,
      '--dir',
      source,
      '--entrypoint',
      '.\\worker.js',
      '--label',
      'safe deploy',
      '--json',
    ]);
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.equal(JSON.parse(deploy.stdout).warnings[0].file_name, '.env.production');
    assert.doesNotMatch(deploy.stdout, /do-not-send/);
    assert.equal(deployBody.entrypoint, 'worker.js');
    assert.deepEqual(Object.keys(deployBody.files).sort(), [
      '.aws/credentials',
      '.dev.vars.local',
      '.env.production',
      '.npmrc',
      '.pypirc',
      '.ssh/config',
      '_netrc',
      'credentials.ts',
      'nested/.aws/credentials',
      'private.pem',
      'secret.ts',
      'secrets.json',
      'service-account-prod.json',
      'session.ts',
      'token.ts',
      'worker.js',
    ]);
    const projectEnv = path.join(workspace, '.env.joripspace');
    for (const aliasArgs of [
      ['--source', projectEnv, '--entrypoint', 'worker.js'],
      ['--file', `worker.js=${projectEnv}`, '--entrypoint', 'worker.js'],
    ]) {
      const blocked = await runCli([
        'deploy',
        '--cwd',
        workspace,
        ...aliasArgs,
        '--label',
        'blocked credential alias',
        '--json',
      ]);
      assert.equal(blocked.code, 1);
      assert.equal(blocked.stdout, '');
      assert.match(
        JSON.parse(blocked.stderr).error.message,
        /protected file cannot be used as deploy source/
      );
    }
    assert.equal(deployCalls, 1);
    const missing = await runCli(['storage', 'put', '--cwd', workspace, '--key', 'empty', '--json']);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stderr).error.message, 'storage put requires --file or --text');
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary requests use 25 seconds while deployments have no arbitrary response deadline', async () => {
  const { root, workspace } = fixture();
  const source = path.join(root, 'worker.js');
  const preload = path.join(root, 'capture-timeout.cjs');
  fs.writeFileSync(source, 'export default { fetch() { return new Response("ok"); } };\n');
  fs.writeFileSync(
    preload,
    `const originalSetTimeout = global.setTimeout;\n` +
      `global.setTimeout = (callback, milliseconds, ...args) => { global.__requestTimeout = milliseconds; return originalSetTimeout(callback, 60000, ...args); };\n` +
      `global.fetch = async () => Response.json({ observed_timeout: global.__requestTimeout, deployment_id: 'dep-timeout', status: 'success' });\n`
  );
  const env = {
    JORIPSPACE_API_TOKEN: 'timeout-token',
    JORIPSPACE_API_URL: 'https://timeout.test',
    NODE_OPTIONS: `--require=${preload}`,
  };
  try {
    const project = await runCli(['get', '--cwd', workspace, '--json'], { cwd: root, env });
    assert.equal(project.code, 0, project.stderr);
    assert.equal(JSON.parse(project.stdout).observed_timeout, 25_000);

    const storage = await runCli(
      ['storage', 'put', '--cwd', workspace, '--key', 'plain.txt', '--text', 'plain', '--json'],
      { cwd: root, env }
    );
    assert.equal(storage.code, 0, storage.stderr);
    assert.equal(JSON.parse(storage.stdout).observed_timeout, 25_000);

    const deploy = await runCli(
      ['deploy', '--cwd', workspace, '--source', source, '--label', 'timeout contract', '--json'],
      { cwd: root, env }
    );
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.equal(JSON.parse(deploy.stdout).observed_timeout, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inline source and file mappings use canonical project paths', async () => {
  const { root, workspace } = fixture();
  const source = path.join(root, 'worker.js');
  fs.writeFileSync(source, 'export default {};\n');
  const bodies = [];
  const api = await apiServer((request, body) => {
    if (request.url === '/v1/projects/demo/deploy') {
      bodies.push(body);
      return { body: { deployment_id: `dep-${bodies.length}`, status: 'success' } };
    }
    return { status: 404, body: {} };
  });
  try {
    writeConnection(workspace, api.url);
    for (const args of [
      ['--source', source, '--entrypoint', '.\\worker.js'],
      ['--file', `.\\nested\\worker.js=${source}`, '--entrypoint', './nested/worker.js'],
    ]) {
      const result = await runCli([
        'deploy',
        '--cwd',
        workspace,
        ...args,
        '--label',
        'canonical paths',
        '--json',
      ]);
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(
      bodies.map((body) => ({ entrypoint: body.entrypoint, keys: Object.keys(body.files) })),
      [
        { entrypoint: 'worker.js', keys: ['worker.js'] },
        { entrypoint: 'nested/worker.js', keys: ['nested/worker.js'] },
      ]
    );
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web-only commands fail before making an API request and emit JSON errors', async () => {
  const { root, workspace } = fixture();
  let calls = 0;
  const api = await apiServer(() => {
    calls += 1;
    return { body: {} };
  });
  try {
    writeConnection(workspace, api.url);
    const result = await runCli(['create', '--name', 'nope', '--cwd', workspace, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'invalid_arguments');
    assert.match(error.message, /웹 화면/);
    assert.equal(calls, 0);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JSON HTTP errors preserve API code, status, and details on stderr only', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer(() => ({
    status: 409,
    body: {
      error: {
        code: 'project_conflict',
        message: 'conflict',
        details: { existing_project: 'other' },
      },
    },
  }));
  try {
    writeConnection(workspace, api.url);
    const result = await runCli(['get', '--cwd', workspace, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: {
        code: 'project_conflict',
        message: 'conflict',
        status: 409,
        details: { existing_project: 'other' },
      },
    });
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid connection-token placeholders are rejected before network access', async () => {
  const { root, workspace } = fixture();
  try {
    for (const token of ['Bearer real-looking', 'dummy', 'test', 'token', 'undefined', 'null']) {
      const result = await runCli(['login', '--connect-token', token, '--cwd', workspace, '--json']);
      assert.equal(result.code, 1, token);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'invalid_arguments');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login and link reject a tracked project environment before network access', async () => {
  const { root, workspace } = fixture();
  let calls = 0;
  const api = await apiServer(() => {
    calls += 1;
    return { body: {} };
  });
  try {
    const envPath = path.join(workspace, '.env.joripspace');
    fs.writeFileSync(envPath, 'JORIPSPACE_API_TOKEN=tracked-token\n');
    git(workspace, ['init']);
    git(workspace, ['add', '.env.joripspace']);
    const before = fs.readFileSync(envPath, 'utf8');
    for (const command of [
      ['login', '--connect-token', 'valid-connect-token', '--cwd', workspace, '--api-url', api.url, '--json'],
      [
        'link',
        '--project',
        'demo',
        '--token',
        'valid-connect-token',
        '--cwd',
        workspace,
        '--api-url',
        api.url,
        '--json',
      ],
    ]) {
      const result = await runCli(command);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'project_env_tracked');
    }
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(envPath, 'utf8'), before);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit token ignores process-environment API URL while environment token keeps its URL', async () => {
  const { root, workspace } = fixture();
  const preload = path.join(root, 'fetch-preload.cjs');
  fs.writeFileSync(
    preload,
    `global.fetch = async (url, options = {}) => new Response(JSON.stringify({ project_id: new URL(url).origin, authorization: options.headers.Authorization }), { status: 200, headers: { 'content-type': 'application/json' } });\n`
  );
  const baseEnv = {
    NODE_OPTIONS: `--require=${preload}`,
    JORIPSPACE_API_URL: 'https://process-env.example',
    JORIPSPACE_API_BASE_URL: '',
  };
  try {
    const explicit = await runCli(['get', '--cwd', workspace, '--token', 'explicit-token', '--json'], {
      env: { ...baseEnv, JORIPSPACE_API_TOKEN: '' },
    });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(JSON.parse(explicit.stdout).project_id, 'https://api.joripspace.com');
    assert.equal(JSON.parse(explicit.stdout).authorization, 'Bearer explicit-token');

    const environment = await runCli(['get', '--cwd', workspace, '--json'], {
      env: { ...baseEnv, JORIPSPACE_API_TOKEN: 'environment-token' },
    });
    assert.equal(environment.code, 0, environment.stderr);
    assert.equal(JSON.parse(environment.stdout).project_id, 'https://process-env.example');
    assert.equal(JSON.parse(environment.stdout).authorization, 'Bearer environment-token');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connect_token-only global session migrates during link and is scrubbed', async () => {
  const { root, workspace } = fixture();
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.joripspace'), { recursive: true });
  const api = await apiServer((request) => {
    if (request.url === '/v1/me/projects') {
      return { body: { account_id: 'account-1', projects: [{ project_slug: 'demo', role: 'owner' }] } };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') return { body: { deployments: [] } };
    if (request.url === '/v1/projects/demo') {
      return {
        body: {
          project_id: 'demo',
          project_slug: 'demo',
          default_url: 'https://demo.example',
          mcp_url: `${api.url}/mcp`,
          deployment: { mode: 'direct', connection_status: 'not_connected' },
        },
      };
    }
    return { status: 404, body: {} };
  });
  try {
    const sessionPath = path.join(home, '.joripspace', 'session.json');
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ connect_token: 'legacy-connect-only', api_base_url: api.url })}\n`
    );
    const result = await runCli(['link', '--project', 'demo', '--cwd', workspace, '--json'], {
      env: {
        HOME: home,
        USERPROFILE: home,
        JORIPSPACE_API_TOKEN: '',
        JORIPSPACE_CONNECT_TOKEN: '',
        JORIPSPACE_API_URL: '',
        JORIPSPACE_API_BASE_URL: '',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    const env = fs.readFileSync(path.join(workspace, '.env.joripspace'), 'utf8');
    assert.match(env, /^JORIPSPACE_API_TOKEN=legacy-connect-only$/m);
    assert.match(env, new RegExp(`^JORIPSPACE_API_BASE_URL=${escapeRegex(api.url)}$`, 'm'));
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal('connect_token' in session, false);
    assert.equal('api_token' in session, false);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login code exchange and token verification keep one process-environment API URL record', async () => {
  const { root, workspace } = fixture();
  const calls = [];
  const api = await apiServer((request) => {
    calls.push(request.url);
    if (request.url === '/v1/auth/connection-code/exchange') {
      return { body: { connect_token: 'exchanged-project-token' } };
    }
    if (request.url === '/v1/me/projects') {
      return { body: { account_id: 'account-code', projects: [] } };
    }
    return { status: 404, body: {} };
  });
  try {
    const result = await runCli(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--cwd', workspace, '--json'], {
      env: {
        JORIPSPACE_API_URL: api.url,
        JORIPSPACE_API_BASE_URL: '',
        JORIPSPACE_API_TOKEN: '',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, ['/v1/auth/connection-code/exchange', '/v1/me/projects']);
    const env = fs.readFileSync(path.join(workspace, '.env.joripspace'), 'utf8');
    assert.match(env, new RegExp(`^JORIPSPACE_API_BASE_URL=${escapeRegex(api.url)}$`, 'm'));
    assert.match(env, /^JORIPSPACE_API_TOKEN=exchanged-project-token$/m);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start selection and conflict states use a nonzero incomplete exit code', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer((request) => {
    if (request.url === '/v1/me/projects') {
      return { body: { account_id: 'account-1', projects: [{ project_slug: 'demo', role: 'owner' }] } };
    }
    return { status: 500, body: { message: 'local conflict should stop before project details' } };
  });
  try {
    const noConnection = await runCli(['start', 'demo', '--cwd', workspace, '--json'], {
      env: {
        HOME: root,
        USERPROFILE: root,
        JORIPSPACE_API_TOKEN: '',
        JORIPSPACE_CONNECT_TOKEN: '',
      },
    });
    assert.equal(noConnection.code, 2);
    assert.equal(noConnection.stdout, '');
    const connectionError = JSON.parse(noConnection.stderr);
    assert.equal(connectionError.error.code, 'connection_required');
    assert.equal(path.isAbsolute(connectionError.error.details.executable), true);
    assert.match(connectionError.error.details.login_command, / login --code "CONNECTION_CODE" /);
    assert.match(connectionError.error.details.resume_command, / start "demo" --cwd /);
    assert.equal(connectionError.error.details.continue_with, 'cli');
    assert.equal(connectionError.error.details.onboarding.schema_version, 1);
    assert.deepEqual(connectionError.error.details.onboarding.read_files, []);
    assert.match(connectionError.error.details.onboarding.instructions, /five-minute one-time code/);
    assert.equal(connectionError.error.details.onboarding.commands.login.args.includes('CONNECTION_CODE'), true);

    fs.writeFileSync(path.join(workspace, '.joripspace', 'project'), 'other\n');
    const conflict = await runCli(
      ['start', 'demo', '--cwd', workspace, '--token', 'explicit-token', '--api-url', api.url, '--json'],
      { env: { HOME: root, USERPROFILE: root } }
    );
    assert.equal(conflict.code, 2);
    assert.equal(conflict.stdout, '');
    const conflictError = JSON.parse(conflict.stderr);
    assert.equal(conflictError.error.code, 'project_conflict');
    assert.equal(conflictError.error.details.existing_project, 'other');
    assert.deepEqual(conflictError.error.details.onboarding.read_files, []);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start exchanges a connection code and continues in the same process without exposing the token', async () => {
  const { root, workspace } = fixture();
  const calls = [];
  const api = await apiServer((request, body) => {
    calls.push({ url: request.url, authorization: request.headers.authorization || '', body });
    if (request.url === '/v1/auth/connection-code/exchange') {
      assert.deepEqual(body, { code: 'ABCD-EFGH-JKMN-PQRS' });
      return { body: { connect_token: 'same-process-secret-token' } };
    }
    if (request.url === '/v1/me/projects') {
      assert.equal(request.headers.authorization, 'Bearer same-process-secret-token');
      return {
        body: {
          account_id: 'account-code',
          projects: [{ name: 'Demo', project_slug: 'demo', role: 'owner', status: 'active' }],
        },
      };
    }
    if (request.url === '/v1/projects/demo') {
      return {
        body: {
          project_slug: 'demo',
          description: 'Existing project',
          status: 'active',
          deployment: { mode: 'direct' },
        },
      };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') {
      return { body: { deployments: [] } };
    }
    return { status: 404, body: { message: `unhandled ${request.url}` } };
  });
  try {
    const result = await runCli(
      ['start', 'Demo', '--code', 'abcd-efgh-jkmn-pqrs', '--cwd', workspace, '--api-url', api.url, '--json'],
      {
        env: {
          HOME: path.join(root, 'home'),
          USERPROFILE: path.join(root, 'home'),
          PATH: '',
          JORIPSPACE_API_TOKEN: '',
          JORIPSPACE_CONNECT_TOKEN: '',
          JORIPSPACE_API_URL: '',
          JORIPSPACE_API_BASE_URL: '',
        },
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes('same-process-secret-token'), false);
    const body = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(body).sort(), [
      'context',
      'continue_with',
      'executable',
      'next_action',
      'ok',
      'onboarding',
      'project',
      'template_choice',
    ]);
    assert.equal(body.ok, true);
    assert.equal(body.project, 'demo');
    assert.equal(path.isAbsolute(body.executable), true);
    assert.equal(body.continue_with, 'cli');
    assert.equal(body.next_action, 'continue-development');
    assert.equal(calls.filter((call) => call.url === '/v1/me/projects').length, 2);
    const env = fs.readFileSync(path.join(workspace, '.env.joripspace'), 'utf8');
    assert.match(env, /^JORIPSPACE_API_TOKEN=same-process-secret-token$/m);
    assert.match(env, new RegExp(`^JORIPSPACE_API_BASE_URL=${escapeRegex(api.url)}$`, 'm'));
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start migrates a source-bound legacy project session only after project validation', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer legacy-project-token');
    if (request.url === '/v1/me/projects') {
      return { body: { projects: [{ project_slug: 'demo', role: 'owner' }] } };
    }
    if (request.url === '/v1/projects/demo') {
      return { body: { project_slug: 'demo', status: 'active', deployment: { mode: 'direct' } } };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') {
      return { body: { deployments: [] } };
    }
    return { status: 404, body: {} };
  });
  try {
    fs.writeFileSync(
      path.join(workspace, '.joripspace', 'agent-session.json'),
      `${JSON.stringify({
        api_token: 'legacy-project-token',
        api_base_url: api.url,
        account: { account_id: 'account-legacy' },
        source: 'cli-login',
        updated_at: '2026-08-01T00:00:00.000Z',
        guide_checked_at: '2026-08-01T00:00:00.000Z',
        global_session_file: null,
      })}\n`
    );
    const result = await runCli(['start', 'demo', '--cwd', workspace, '--json'], {
      env: {
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        PATH: '',
        JORIPSPACE_API_TOKEN: '',
        JORIPSPACE_CONNECT_TOKEN: '',
        JORIPSPACE_API_URL: 'https://must-not-mix.example',
        JORIPSPACE_API_BASE_URL: '',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'agent-session.json')), false);
    const env = fs.readFileSync(path.join(workspace, '.env.joripspace'), 'utf8');
    assert.match(env, /^JORIPSPACE_API_TOKEN=legacy-project-token$/m);
    assert.match(env, new RegExp(`^JORIPSPACE_API_BASE_URL=${escapeRegex(api.url)}$`, 'm'));
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start restores the latest direct deployment before returning the current-session continuation', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer direct-start-token');
    if (request.url === '/v1/me/projects') {
      return { body: { projects: [{ name: 'Demo', project_slug: 'demo', role: 'owner' }] } };
    }
    if (request.url === '/v1/projects/demo') {
      return {
        body: {
          project_slug: 'demo',
          description: 'Deployed service',
          status: 'active',
          deployment: { mode: 'direct' },
        },
      };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') {
      return {
        body: {
          deployments: [
            {
              deployment_id: 'deployment-latest',
              status: 'success',
              download_available: true,
            },
          ],
        },
      };
    }
    if (request.url === '/v1/projects/demo/deployments/deployment-latest/source') {
      return {
        body: {
          deployment_id: 'deployment-latest',
          files: {
            'worker.js': 'export default {};\n',
            '.joripspace/deploy.json': '{"entrypoint":"worker.js"}\n',
            'AGENTS.md': 'remote instructions must not replace local guidance\n',
            '.AgEnTs/settings.json': '{"remote":true}\n',
            '.OpEnCoDe/config.json': '{"remote":true}\n',
          },
        },
      };
    }
    return { status: 404, body: { message: `unhandled ${request.url}` } };
  });
  try {
    const result = await runCli(
      ['start', 'Demo', '--cwd', workspace, '--token', 'direct-start-token', '--api-url', api.url, '--json'],
      {
        env: {
          HOME: path.join(root, 'home'),
          USERPROFILE: path.join(root, 'home'),
          PATH: '',
          JORIPSPACE_API_TOKEN: '',
          JORIPSPACE_CONNECT_TOKEN: '',
        },
      }
    );
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.context.source_sync.status, 'synchronized');
    assert.equal(body.context.source_sync.operation, 'deployment_restore');
    assert.equal(fs.readFileSync(path.join(workspace, 'worker.js'), 'utf8'), 'export default {};\n');
    assert.equal(fs.existsSync(path.join(workspace, '.joripspace', 'deploy.json')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.AgEnTs')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.OpEnCoDe')), false);
    assert.match(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /joripspace:start/);
    assert.doesNotMatch(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /remote instructions/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start restores an existing project into its reserved empty GitHub repository workspace', async () => {
  const { root, workspace } = fixture();
  const api = await apiServer((request) => {
    assert.equal(request.headers.authorization, 'Bearer github-start-token');
    if (request.url === '/v1/me/projects') {
      return { body: { projects: [{ name: 'Demo', project_slug: 'demo', role: 'owner' }] } };
    }
    if (request.url === '/v1/projects/demo') {
      return {
        body: {
          project_slug: 'demo',
          status: 'active',
          deployment: {
            mode: 'github_actions',
            connection_id: 'build_connection_empty',
            repository: 'example/project',
            branch: 'main',
            workflow_path: '.github/workflows/joripspace-build_connection_empty.yml',
            source_status: 'empty',
          },
        },
      };
    }
    if (request.url === '/v1/projects/demo/deployments?limit=1') {
      return {
        body: {
          deployments: [{ deployment_id: 'deployment-existing', status: 'success', download_available: true }],
        },
      };
    }
    if (request.url === '/v1/projects/demo/deployments/deployment-existing/source') {
      return { body: { deployment_id: 'deployment-existing', files: { 'worker.js': 'export default {};\n' } } };
    }
    return { status: 404, body: { message: `unhandled ${request.url}` } };
  });
  try {
    const result = await runCli(
      ['start', 'demo', '--cwd', workspace, '--token', 'github-start-token', '--api-url', api.url, '--json'],
      { env: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') } }
    );
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.context.source_sync.operation, 'deployment_restore');
    assert.equal(fs.readFileSync(path.join(workspace, 'worker.js'), 'utf8'), 'export default {};\n');
    const remote = require('node:child_process').spawnSync(
      'git',
      ['-C', workspace, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' }
    );
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), 'https://github.com/example/project.git');
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('link refuses a symlinked or junction .joripspace directory before API calls', async (t) => {
  const { root, workspace } = fixture();
  const outside = path.join(root, 'outside-link');
  fs.rmSync(path.join(workspace, '.joripspace'), { recursive: true, force: true });
  fs.mkdirSync(outside, { recursive: true });
  let calls = 0;
  const api = await apiServer(() => {
    calls += 1;
    return { body: {} };
  });
  try {
    try {
      fs.symlinkSync(
        outside,
        path.join(workspace, '.joripspace'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    const result = await runCli([
      'link',
      '--project',
      'demo',
      '--cwd',
      workspace,
      '--token',
      'explicit-token',
      '--api-url',
      api.url,
      '--json',
    ]);
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error.message, /symbolic link or junction/);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('large deploy automatically switches to the verified chunked archive transport', async () => {
  const { root, workspace } = fixture();
  const source = path.join(root, 'large-source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'worker.js'),
    `export default { fetch() { return new Response("ok"); } };\n/* ${'x'.repeat(17_000)} */\n`
  );
  let uploadedBytes = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    uploadedBytes += request.url.includes('/parts/') ? Buffer.concat(chunks).length : 0;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/projects/demo/checkpoint-uploads') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.source_type, 'agent');
      response.end(
        JSON.stringify({
          checkpoint_id: 'checkpoint-large',
          chunk_size: 1024 * 1024,
          upload_part_url_template: '/v1/projects/demo/checkpoint-uploads/upload-large/parts/{part_number}',
          complete_url: '/v1/projects/demo/checkpoint-uploads/upload-large/complete',
        })
      );
      return;
    }
    if (request.url.includes('/parts/') || request.url.endsWith('/complete?wait=ready')) {
      response.end('{}');
      return;
    }
    if (request.url === '/v1/projects/demo/checkpoints/checkpoint-large' && request.method === 'GET') {
      response.end(
        JSON.stringify({
          checkpoint_id: 'checkpoint-large',
          sequence: 2,
          status: 'ready',
          deployable: true,
          file_count: 2,
        })
      );
      return;
    }
    if (request.url === '/v1/projects/demo/checkpoints/checkpoint-large/deploy') {
      response.end(JSON.stringify({ deployment_id: 'deployment-large', status: 'success' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    writeConnection(workspace, `http://127.0.0.1:${address.port}`);
    for (const [label, bytes] of [
      ['large deploy', Buffer.from(`export default {};\n/* ${'x'.repeat(17_000)} */\n`, 'utf8')],
      ['utf8 byte deploy', Buffer.from(`export default {};\n/* ${'한'.repeat(5_500)} */\n`, 'utf8')],
      ['nul binary deploy', Buffer.from([101, 120, 112, 111, 114, 116, 0, 100, 101, 102, 97, 117, 108, 116])],
    ]) {
      fs.writeFileSync(path.join(source, 'worker.js'), bytes);
      const result = await runCli([
        'deploy',
        '--cwd',
        workspace,
        '--dir',
        source,
        '--entrypoint',
        'worker.js',
        '--label',
        label,
        '--json',
      ]);
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).transport, 'verified_chunked_archive');
    }
    assert.ok(uploadedBytes > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deployment pull backs up directory conflicts and refuses symlink escape targets', async (t) => {
  const { root, workspace } = fixture();
  const outside = path.join(root, 'outside');
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(outside, { recursive: true });
  let sourceFiles = { 'nested/file.js': 'remote\n' };
  const api = await apiServer((request) => {
    if (request.url === '/v1/projects/demo/deployments/latest/source') {
      return { body: { project_id: 'demo', deployment_id: 'latest', files: sourceFiles } };
    }
    return { status: 404, body: {} };
  });
  try {
    writeConnection(workspace, api.url);
    fs.writeFileSync(path.join(workspace, 'nested'), 'local blocker\n');
    const refused = await runCli(['deployment', 'pull', '--cwd', workspace, '--json'], {
      env: { JORIPSPACE_DATA_DIR: userData },
    });
    assert.equal(refused.code, 1);
    assert.equal(fs.readFileSync(path.join(workspace, 'nested'), 'utf8'), 'local blocker\n');

    const forced = await runCli(['deployment', 'pull', '--cwd', workspace, '--force', '--json'], {
      env: { JORIPSPACE_DATA_DIR: userData },
    });
    assert.equal(forced.code, 0, forced.stderr);
    const forcedBody = JSON.parse(forced.stdout);
    assert.equal(fs.readFileSync(path.join(workspace, 'nested', 'file.js'), 'utf8'), 'remote\n');
    assert.equal(path.isAbsolute(forcedBody.restore.backup_root), true);
    assert.equal(path.relative(workspace, forcedBody.restore.backup_root).startsWith('..'), true);
    assert.equal(
      fs.readFileSync(path.join(forcedBody.restore.backup_root, 'nested'), 'utf8'),
      'local blocker\n'
    );

    fs.mkdirSync(path.join(workspace, 'escape-parent'), { recursive: true });
    try {
      fs.symlinkSync(
        outside,
        path.join(workspace, 'escape-parent', 'link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('symlinks unavailable');
      throw error;
    }
    sourceFiles = { 'escape-parent/link/pwned.js': 'outside write\n' };
    const escaped = await runCli(['deployment', 'pull', '--cwd', workspace, '--force', '--json'], {
      env: { JORIPSPACE_DATA_DIR: userData },
    });
    assert.equal(escaped.code, 1);
    assert.match(JSON.parse(escaped.stderr).error.message, /symbolic link or junction/);
    assert.equal(fs.existsSync(path.join(outside, 'pwned.js')), false);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
