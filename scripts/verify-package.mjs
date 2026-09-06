import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, '.artifacts');
mkdirSync(artifacts, { recursive: true });
const npm = process.env.npm_execpath;
assert.ok(npm && existsSync(npm), 'Run with npm run test:package');
const npx = join(dirname(npm), 'npx-cli.js');
assert.ok(existsSync(npx));
const temporary = mkdtempSync(join(tmpdir(), 'joripspace npm 한글 '));
assert.ok(relative(root, temporary).startsWith('..') || isAbsolute(relative(root, temporary)), 'Test must be outside the source repository');
const project = join(temporary, '사용자 프로젝트');
const installed = join(temporary, '설치 위치');
const home = join(temporary, 'home');
for (const dir of [project, installed, home, join(home, 'roaming'), join(home, 'local')]) mkdirSync(dir);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|LANG|LC_ALL)$/i.test(key)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'),
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
  npm_config_cache: join(temporary, 'npm cache'), npm_config_userconfig: join(home, 'empty-npmrc'),
  npm_config_prefix: join(home, 'npm-global'),
  npm_config_registry: 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false',
  GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
writeFileSync(env.npm_config_userconfig, '');
mkdirSync(join(env.npm_config_prefix, 'bin'), { recursive: true });
function run(args, cwd = project) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
  });
}
async function checked(args, cwd) {
  const result = await run(args, cwd);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { platform: process.platform, arch: process.arch, node: process.version, checks: [], files: [] };
let server;
try {
  const packed = await checked([npm, 'pack', '--json', '--pack-destination', artifacts], root);
  const metadata = JSON.parse(packed.stdout)[0];
  const tarball = join(artifacts, metadata.filename);
  const bytes = readFileSync(tarball);
  report.tarball = { file: metadata.filename, bytes: bytes.length, sha256: sha256(bytes) };
  const tar = gunzipSync(bytes);
  let packedPackage;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, size) => header.subarray(start, start + size).toString('utf8').split('\0')[0];
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12).trim(), 8) || 0;
    const mode = parseInt(field(100, 8).trim(), 8);
    const type = field(156, 1);
    assert.ok(type === '0' || type === '', `Unexpected tar entry type: ${name}`);
    assert.match(name, /^package\/(package\.json|README\.md|bin\/joripspace\.js|lib\/[^/]+\.js|vendor\/core\/[^/]+\.cjs|vendor\/templates\/index\.js|vendor\/templates\/templates\/(basic-worker|r2-file-api)\/(manifest\.json|files\/worker\.js))$/);
    const content = tar.subarray(offset + 512, offset + 512 + size);
    const text = content.toString('utf8');
    assert.ok(!text.includes(root) && !text.includes(root.replaceAll('\\', '/')), `Local source path in ${name}`);
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_|npm_)[A-Za-z0-9_]{30,}/);
    if (name === 'package/package.json') packedPackage = JSON.parse(text);
    if (name === 'package/bin/joripspace.js') {
      // Windows filesystems do not store POSIX execute bits; npm sets bin permissions on installation.
      report.packed_entry_mode = mode.toString(8);
      if (process.platform !== 'win32') assert.ok((mode & 0o111) !== 0, 'Packed executable must have execute bits');
      assert.ok(text.startsWith('#!/usr/bin/env node\n'));
    }
    report.files.push({ file: name.slice(8), bytes: size, sha256: sha256(content) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(packedPackage);
  assert.deepEqual(report.files.map(file => file.file).sort(), metadata.files.map(file => file.path).sort());
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(packedPackage.scripts[hook], undefined);
  for (const spec of Object.values(packedPackage.dependencies)) assert.doesNotMatch(spec, /file:|link:|workspace:/);
  report.checks.push('tarball_allowlist_contents_hashes_shebang_execute_mode_no_install_hooks');

  await checked([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installed);
  const entry = join(installed, 'node_modules', '@joripspace', 'cli', 'bin', 'joripspace.js');
  assert.ok(existsSync(entry));
  if (process.platform !== 'win32') assert.ok((statSync(entry).mode & 0o111) !== 0);
  const dependencyTree = JSON.parse((await checked([npm, 'ls', '--all', '--json'], installed)).stdout);
  assert.deepEqual(Object.keys(dependencyTree.dependencies['@joripspace/cli'].dependencies).sort(), ['fflate', 'jsonc-parser', 'smol-toml']);
  report.checks.push('clean_external_install_without_build_or_parent_dependencies');
  const original = process.env.JORIPSPACE_BASELINE_CLI;
  const reference = original ? resolve(original) : join(root, 'bin', 'joripspace.js');
  report.reference = original ? 'original CLI' : 'standalone source CLI';
  for (const args of [['--help'], ['--version'], ['version'], ['deploy', '--help'], ['templates', '--json'], ['realtime-v2', 'docs', '--json'], ['unknown-command', '--json'], ['start', '--json']]) {
    const expected = await run([reference, ...args]);
    const actual = await run([entry, ...args]);
    assert.deepEqual(actual, expected, args.join(' '));
  }
  report.checks.push('reference_help_version_templates_realtime_docs_arguments_stdout_stderr_exit_codes');
  const exec = args => checked([npm, 'exec', '--yes', '--package', tarball, '--', 'joripspace', ...args]);
  copyFileSync(tarball, join(temporary, metadata.filename));
  const npxVersion = await checked([npx, '-y', `../${metadata.filename}`, '--version']);
  assert.equal(npxVersion.stdout.trim(), packedPackage.version, JSON.stringify(npxVersion));
  const npxTemplates = await exec(['templates', '--json']);
  assert.equal(npxTemplates.stdout, (await checked([entry, 'templates', '--json'])).stdout);
  assert.deepEqual(
    await run([npx, '-y', `../${metadata.filename}`, 'unknown-command', '--json']),
    await run([reference, 'unknown-command', '--json'])
  );
  report.checks.push('npx_tarball_and_npm_exec_bin_resolution');
  await checked([npm, 'install', '--global', '--ignore-scripts', tarball], temporary);
  const globalBin = process.platform === 'win32'
    ? join(env.npm_config_prefix, 'joripspace.cmd')
    : join(env.npm_config_prefix, 'bin/joripspace');
  assert.ok(existsSync(globalBin));
  assert.equal((await checked([npm, 'exec', '--no', '--', 'joripspace', '--version'], temporary)).stdout.trim(), packedPackage.version);
  report.checks.push('isolated_global_prefix_install_and_command_resolution');

  const requests = [];
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });
    const result = request.url === '/v1/auth/connection-code/exchange'
      ? { connect_token: 'isolated-test-connection-token' }
      : request.url === '/v1/me/projects'
        ? { account_id: 'isolated-test-account', projects: [{ project_slug: 'demo', role: 'owner' }] }
        : request.url.startsWith('/v1/projects/demo/realtime-v2/keys')
          ? { keys: [], cursor: null }
          : { project_slug: 'demo', status: 'active' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await exec(['login', '--code', 'abcd-efgh-jkmn-pqrs', '--api-url', url, '--json']);
  assert.doesNotMatch(login.stdout + login.stderr, /isolated-test-connection-token/);
  const credentialFile = join(project, '.env.joripspace');
  assert.ok(existsSync(credentialFile), 'Login must use caller cwd');
  assert.ok(!existsSync(join(installed, '.env.joripspace')));
  assert.match(readFileSync(join(project, '.gitignore'), 'utf8'), /\.env\.joripspace/);
  mkdirSync(join(project, '.joripspace'));
  writeFileSync(join(project, '.joripspace/project'), 'demo\n');
  const credentialBefore = readFileSync(credentialFile, 'utf8');
  const query = '키 공백+/=';
  await exec(['realtime-v2', 'keys', '--cursor', query, '--json']);
  await checked([npx, '-y', `./${metadata.filename}`, 'realtime-v2', 'status', '--cwd', project, '--json'], temporary);
  const nested = join(project, '하위 폴더');
  mkdirSync(nested);
  await checked([entry, 'get', '--json'], nested);
  assert.equal(readFileSync(credentialFile, 'utf8'), credentialBefore);
  assert.equal(requests.filter(request => request.url === '/v1/auth/connection-code/exchange').length, 1);
  assert.ok(requests.some(request => request.url === `/v1/projects/demo/realtime-v2/keys?after=${encodeURIComponent(query)}`));
  for (const request of requests.filter(request => request.url !== '/v1/auth/connection-code/exchange')) {
    assert.equal(request.authorization, 'Bearer isolated-test-connection-token');
  }
  report.checks.push('loopback_code_exchange_persistent_auth_caller_cwd_explicit_cwd_parent_marker_korean_space_arguments');
  const authless = join(temporary, '연결 없는 프로젝트');
  mkdirSync(authless);
  const denied = await run([entry, 'start', 'demo', '--json'], authless);
  assert.equal(denied.code, 2);
  assert.equal(denied.stdout, '');
  const error = JSON.parse(denied.stderr);
  assert.equal(error.error.code, 'connection_required');
  assert.ok(error.error.details.login_command.startsWith(`"${process.execPath}" "${entry}" login `));
  report.checks.push('noninteractive_stdin_eof_and_start_recovery_node_invocation_exit_2');

  // Exercise cancellation while a local HTTP request is pending, without a browser or real credentials.
  server.removeAllListeners('request');
  let signalChild;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { signalChild?.kill(); reject(new Error('Cancellation timed out')); }, 10_000);
    server.once('request', () => signalChild.kill('SIGINT'));
    signalChild = spawn(process.execPath, [entry, 'get', '--json'], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
    signalChild.once('error', reject);
    signalChild.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) reject(new Error('Cancelled request returned success'));
      else { report.cancellation = { code, signal }; done(); }
    });
  });
  report.checks.push('pending_local_request_SIGINT_nonzero_exit');
  report.completed_at = new Date().toISOString();
  writeFileSync(join(artifacts, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, files: report.files.map(file => file.file) }, null, 2));
} finally {
  server?.closeAllConnections();
  if (server?.listening) await new Promise(done => server.close(done));
  if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(tmpdir(), 'joripspace npm 한글 '))) {
    throw new Error('Unexpected package verification cleanup path');
  }
  rmSync(temporary, { recursive: true, force: true });
}
