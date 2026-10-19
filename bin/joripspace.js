#!/usr/bin/env node
const { message } = require('../lib/locale');
const { redactAuthError } = require('../lib/auth-redaction');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { formatDeploymentFailure } = require('../lib/deployment-error');
const {
  printHelp,
  printDeployHelp,
  printDeployTemplateHelp,
  printInstallTemplateHelp,
} = require('../lib/help');
const { createTemplateCommands } = require('../lib/template-commands');
const { createCheckpointCommands } = require('../lib/checkpoint-commands');
const { createRealtimeV2Commands } = require('../lib/realtime-v2-commands');
const { createGithubCommands } = require('../lib/github-commands');
const { createProjectCommand } = require('../lib/project-create');
const {
  assertDeployableProjectPath,
  assertDeployableSourceFilePath,
  assertNoUnresolvedPackageImportsInDirectory,
  buildDeployPayload,
  isProtectedProjectPath,
  resolveDeploySourceDirectory,
  resolveDeploySourceFile,
} = require('../lib/deploy-files');
const { createRemoteCommands } = require('../lib/remote-commands');
const {
  resolveProjectDirectoryTarget,
  resolveProjectFileTarget,
  safeProjectRelativePath,
} = require('../lib/project-paths');
const { ensureProjectEnvIgnored, readProjectEnv, updateDotEnvFile } = require('../lib/project-env');
const { createCredentialStore, normalizeCredentialApiUrl } = require('../lib/credential-store');
const credentialStore = createCredentialStore();
const { persistProjectConnection } = require('../lib/connection-persistence');
const { createStartProjectCommand } = require('../lib/start-command');
const { legacyCredentialSessionConnection, readProjectMarker } = require('../lib/start');
const { buildTemplateDeployRequest, listTemplates } = loadTemplatesPackage();
const templateCommands = createTemplateCommands({
  listTemplates,
  buildTemplateDeployRequest,
  output,
  requireProjectId,
  stringFlag,
  templateVars,
  apiRequest,
  projectAuth,
  requireApiToken,
  resolveConnection,
  booleanFlag,
  deployCode,
});
const remoteCommands = createRemoteCommands({
  apiRequest,
  booleanFlag,
  isProtectedProjectPath,
  output,
  positiveIntegerFlag,
  projectAuth,
  projectWorkspaceDir,
  requireProjectId,
  stringFlag,
  webOnlyCommand,
  writeTextAtomically,
});
const checkpointCommands = createCheckpointCommands({
  apiRequest,
  arrayFlag,
  assertDeployableProjectPath,
  assertDeployableSourceFilePath,
  assertNoUnresolvedPackageImportsInDirectory,
  booleanFlag,
  output,
  positiveIntegerFlag,
  projectAuth,
  projectWorkspaceDir,
  requireApiToken,
  requireProjectId,
  resolveDeploySourceDirectory,
  resolveDeploySourceFile,
  resolveConnection,
  safeProjectRelativePath,
  splitFileMapping,
  stringFlag,
});
const startProjectCommand = createStartProjectCommand(
  apiRequest,
  output,
  resolveConnection,
  stringFlag,
  remoteCommands.pullDeploymentSource,
  projectWorkspaceDir,
  persistStartConnection,
  connectForStart
);
const githubCommand = createGithubCommands({
  apiRequest,
  output,
  projectAuth,
  projectWorkspaceDir,
  requireProjectId,
  stringFlag,
  writeTextAtomically,
});

const DEFAULT_API_URL = 'https://api.joripspace.com';
const createProject = createProjectCommand({
  apiRequest,
  output,
  requireApiToken,
  resolveConnection,
  stringFlag,
});
const GENERAL_REQUEST_TIMEOUT_MS = 25_000;
const SESSION_COOKIE_PREFIX = 'joripspace_session=';
function loadTemplatesPackage() {
  return require('../vendor/templates');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.slice(2).some((argument) => argument === '--json' || argument.startsWith('--json='))) {
    const serialized = {
      code: typeof error?.code === 'string' ? error.code : 'invalid_arguments',
      message,
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      ...(error?.details === undefined ? {} : { details: error.details }),
    };
    console.error(JSON.stringify({ ok: false, error: serialized }));
  } else {
    console.error(`joripspace: ${message}`);
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || flags.v) {
    console.log(require('../package.json').version);
    return;
  }

  if (!command || command === 'help') {
    printHelp();
    return;
  }

  if (
    (flags.help || flags.h) &&
    command !== 'deploy' &&
    command !== 'deploy-template' &&
    command !== 'install-template'
  ) {
    printHelp();
    return;
  }

  switch (command) {
    case 'version':
      console.log(require('../package.json').version);
      return;
    case 'login':
      await login(flags);
      return;
    case 'logout':
      logout(flags);
      return;
    case 'me':
      await getMe(flags);
      return;
    case 'projects':
      await listMyProjects(flags);
      return;
    case 'billing-projects':
      webOnlyCommand(message('Billing projects', '결제 프로젝트'));
      return;
    case 'billing-usage':
      webOnlyCommand(message('Billing usage', '결제 사용량'));
      return;
    case 'invoices':
      webOnlyCommand(message('Invoices', '청구서'));
      return;
    case 'link':
      await linkProject(flags);
      return;
    case 'start':
      await startProjectCommand(rest, flags);
      return;
    case 'create':
      await createProject(flags);
      return;
    case 'get':
      await getProject(flags);
      return;
    case 'report':
      await reportAgentIssue(flags);
      return;
    case 'db':
      await dbCommand(rest, flags);
      return;
    case 'storage':
      await storageCommand(rest, flags);
      return;
    case 'deploy':
      if (flags.help || flags.h) {
        printDeployHelp();
        return;
      }
      await deployCode(flags);
      return;
    case 'templates':
      await templateCommands.list(flags);
      return;
    case 'template':
      if (rest[0] === 'list') {
        await templateCommands.marketplaceList(flags);
        return;
      }
      if (rest[0] === 'pull') {
        await templateCommands.pull(flags);
        return;
      }
      throw new Error('template command requires: list or pull');
    case 'knowledge':
      await remoteCommands.knowledge(rest, flags);
      return;
    case 'deployment':
      await remoteCommands.deployment(rest, flags);
      return;
    case 'template-pull':
      await templateCommands.pull(flags);
      return;
    case 'deploy-template':
      if (flags.help || flags.h) {
        printDeployTemplateHelp();
        return;
      }
      await templateCommands.deploy(flags);
      return;
    case 'install-template':
      if (flags.help || flags.h) {
        printInstallTemplateHelp();
        return;
      }
      await templateCommands.install(flags);
      return;
    case 'deployments':
      await listDeployments(flags);
      return;
    case 'checkpoint':
    case 'checkpoints':
      await checkpointCommands.command(rest, flags);
      return;
    case 'realtime-v2':
      await createRealtimeV2Commands({ apiRequest, output, projectAuth, requireProjectId, stringFlag })(
        rest,
        flags
      );
      return;
    case 'github':
      await githubCommand(rest, flags);
      return;
    case 'rollback':
      await rollbackDeployment(flags);
      return;
    case 'events':
    case 'logs':
      await listRuntimeEvents(flags);
      return;
    case 'usage':
      webOnlyCommand(message('Daily usage details', '일일 사용량 상세'));
      return;
    case 'usage-summary':
      await getUsageSummary(flags);
      return;
    case 'usage-breakdown':
      await getUsageBreakdown(flags);
      return;
    case 'tokens':
      webOnlyCommand(message('API token administration', 'API 토큰 관리'));
      return;
    case 'crons':
      await remoteCommands.listCrons(flags);
      return;
    case 'domains':
      await remoteCommands.listDomains(flags);
      return;
    case 'secrets':
      await remoteCommands.listSecrets(flags);
      return;
    case 'mail':
      await remoteCommands.mail(rest, flags);
      return;
    case 'webhooks':
      webOnlyCommand(message('Webhook administration', '웹훅 관리'));
      return;
    case 'token':
      webOnlyCommand(message('API token administration', 'API 토큰 관리'));
      return;
    case 'secret':
      await remoteCommands.secrets(rest, flags);
      return;
    case 'cron':
      await remoteCommands.crons(rest, flags);
      return;
    case 'domain':
      await remoteCommands.domains(rest, flags);
      return;
    case 'webhook':
      webOnlyCommand(message('Webhook administration', '웹훅 관리'));
      return;
    case 'delete':
      webOnlyCommand(message('Project deletion', '프로젝트 삭제'));
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function login(flags) {
  const connectionCode = stringFlag(flags, 'code');
  if (connectionCode) {
    ensureProjectEnvIgnored(projectWorkspaceDir(flags, { discover: false }));
    const exchangeApiBaseUrl = normalizeCredentialApiUrl(unauthenticatedApiBaseUrl(flags));
    const exchange = await apiRequest(flags, '/v1/auth/connection-code/exchange', {
      method: 'POST',
      body: { code: normalizeConnectionCode(connectionCode) },
      apiBaseUrl: exchangeApiBaseUrl,
    });
    const exchangedToken = normalizeConnectToken(exchange.connect_token);
    await saveBrowserConnectToken(flags, exchangedToken, 'connection-code', exchangeApiBaseUrl);
    return;
  }
  const connectToken =
    stringFlag(flags, 'connect-token') || stringFlag(flags, 'api-token') || stringFlag(flags, 'token');
  if (connectToken) {
    ensureProjectEnvIgnored(projectWorkspaceDir(flags, { discover: false }));
    await saveBrowserConnectToken(flags, normalizeConnectToken(connectToken));
    return;
  }
  let existing;
  try {
    existing = resolveConnection(flags);
  } catch (error) {
    if (error.code !== 'credential_store_unavailable') throw error;
    // Reauthentication can obtain a new token even when an older OS login is inaccessible.
  }
  if (existing?.apiToken) {
    await saveBrowserConnectToken(
      flags,
      normalizeConnectToken(existing.apiToken),
      existing.source,
      existing.apiBaseUrl
    );
    return;
  }
  const enteredCode = await promptConnectionCode(flags);
  if (enteredCode !== null) {
    await login({ ...flags, code: normalizeConnectionCode(enteredCode) });
    return;
  }
  output(flags, browserConnectInstructions(), printBrowserConnectInstructions);
}

async function saveBrowserConnectToken(flags, apiToken, source = 'browser-connect', selectedApiBaseUrl = '') {
  return saveBrowserConnectTokenWithOptions(flags, apiToken, source, selectedApiBaseUrl);
}

function logout(flags) {
  if (
    stringFlag(flags, 'token') ||
    stringFlag(flags, 'api-token') ||
    stringFlag(flags, 'connect-token') ||
    process.env.JORIPSPACE_API_TOKEN ||
    process.env.JORIPSPACE_CONNECT_TOKEN
  ) {
    const error = new Error(
      message(
        'The CLI cannot remove tokens supplied through environment variables or command-line arguments. Unset those tokens, then run logout.',
        '환경 변수나 명령행으로 제공한 토큰은 CLI에서 제거할 수 없습니다. 해당 토큰 설정을 해제한 뒤 logout을 실행하세요.'
      )
    );
    error.code = 'logout_external_token';
    throw error;
  }
  const workspaceDir = projectWorkspaceDir(flags);
  const env = readProjectEnv(workspaceDir);
  const legacyProject = readLegacyProjectSessionConnection(workspaceDir);
  const legacyGlobal = readGlobalSession(flags);
  const connection = resolveConnection(flags);
  const apiUrl = normalizeCredentialApiUrl(connection.apiBaseUrl);
  let stored = null;
  let osCredentialStatus = 'not_found';
  try {
    stored = credentialStore.load(apiUrl, connection.accountId || env.JORIPSPACE_ACCOUNT_ID || '');
  } catch (error) {
    if (error.code !== 'credential_store_unavailable' || connection.source === 'os-credential-store') throw error;
    osCredentialStatus = 'unavailable';
  }
  const token = connection.apiToken || stored?.apiToken;
  const sameConnection = (candidate) =>
    candidate?.apiToken === token && trimTrailingSlash(candidate.apiBaseUrl) === apiUrl;
  const clearLegacyProject = token && sameConnection(legacyProject);
  const globalToken = legacyGlobal?.api_token || legacyGlobal?.connect_token;
  const clearLegacyGlobal =
    token &&
    globalToken === token &&
    trimTrailingSlash(legacyGlobal.api_base_url || DEFAULT_API_URL) === apiUrl;
  const legacyProjectPath = clearLegacyProject
    ? managedProjectFilePath(workspaceDir, '.joripspace/agent-session.json')
    : null;
  if (clearLegacyGlobal) managedProjectFilePath(os.homedir(), '.joripspace/session.json');
  managedProjectFilePath(workspaceDir, '.env.joripspace');
  const accountId =
    connection.accountId || env.JORIPSPACE_ACCOUNT_ID || (stored?.apiToken === token ? stored.accountId : '');
  if (stored) {
    credentialStore.remove(apiUrl, stored.accountId);
    osCredentialStatus = 'removed';
  }
  updateDotEnvFile(path.join(workspaceDir, '.env.joripspace'), {
    JORIPSPACE_API_BASE_URL: apiUrl,
    JORIPSPACE_API_TOKEN: null,
    JORIPSPACE_CONNECT_TOKEN: null,
    JORIPSPACE_CONNECTION_SOURCE: 'logged-out',
    JORIPSPACE_ACCOUNT_ID: accountId || undefined,
  });
  if (legacyProjectPath) fs.unlinkSync(legacyProjectPath);
  if (clearLegacyGlobal) scrubGlobalSessionToken();
  output(flags, { status: 'logged_out', project_credentials_cleared: true, os_credential_status: osCredentialStatus }, () =>
    console.log(
      osCredentialStatus === 'unavailable' ? message(
        'Logged out: saved project credentials were removed. The OS credential store is unavailable and could not be checked.',
        '로그아웃 완료: 프로젝트에 저장된 인증 정보를 삭제했습니다. OS 보안 저장소는 사용할 수 없어 확인하지 못했습니다.'
      ) : message(
        'Logged out: the current saved connection was removed.',
        '로그아웃 완료: 저장된 현재 연결을 삭제했습니다.'
      )
    )
  );
}

async function saveBrowserConnectTokenWithOptions(
  flags,
  apiToken,
  source = 'browser-connect',
  selectedApiBaseUrl = '',
  options = {}
) {
  const connection = selectedApiBaseUrl
    ? { apiBaseUrl: normalizeCredentialApiUrl(selectedApiBaseUrl), apiToken, source }
    : connectionForExplicitToken(flags, apiToken);
  connection.apiBaseUrl = normalizeCredentialApiUrl(connection.apiBaseUrl);
  const workspaceDir = projectWorkspaceDir(flags, { discover: false });
  managedProjectFilePath(workspaceDir, '.env.joripspace');
  managedProjectFilePath(workspaceDir, '.gitignore');
  ensureProjectEnvIgnored(workspaceDir);
  const body = await apiRequest(flags, '/v1/me/projects', {
    method: 'GET',
    apiToken,
    apiBaseUrl: connection.apiBaseUrl,
  });
  const requestedProject = stringFlag(flags, 'project') || stringFlag(flags, 'project-id');
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const selected = requestedProject
    ? projects.find((project) =>
        [project.project_id, project.project_slug, project.slug].filter(Boolean).includes(requestedProject)
      )
    : projects.length === 1
      ? projects[0]
      : null;
  if (requestedProject && !selected) throw new Error(`project is not accessible: ${requestedProject}`);
  const storage = persistProjectConnection(credentialStore, workspaceDir, { ...connection, accountId: body.account_id });
  scrubGlobalSessionToken();
  if (options.output !== false) {
    output(flags, { ...body, credential_storage: storage }, (value) => {
      console.log(message(`Connected: ${value.account_id}`, `연결 완료: ${value.account_id}`));
      console.log(
        storage === 'project-env-fallback' ? message(
          'Token storage: .env.joripspace (OS credential store unavailable; reused in this project)',
          '토큰 저장 위치: .env.joripspace (OS 보안 저장소를 사용할 수 없어 이 프로젝트에서 재사용)'
        ) : message(
          'Token storage: OS credential store (reused across project folders)',
          '토큰 저장 위치: OS 보안 저장소 (다른 프로젝트 폴더에서도 재사용)'
        )
      );
      console.log(
        message(
          'Run joripspace projects or joripspace start in this folder.',
          '이 폴더에서 joripspace projects 또는 joripspace start 명령을 실행하세요.'
        )
      );
      console.log(
        message(
          'Manage account details and API tokens in your web profile.',
          '회원정보와 API 토큰 관리는 웹 프로필에서만 가능합니다.'
        )
      );
    });
  }
  return body;
}

async function getMe(flags) {
  const body = await apiRequest(flags, '/v1/me/projects', {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    console.log(`Account: ${value.account_id}`);
    console.log(`Projects: ${(value.projects ?? []).length}`);
  });
}

async function listMyProjects(flags) {
  const body = await apiRequest(flags, '/v1/me/projects', {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    for (const project of value.projects ?? []) {
      console.log(
        `${project.project_id}\t${project.role}\towner=${project.role === 'owner' ? 'yes' : 'no'}\t${project.default_url}`
      );
    }
  });
}

function webOnlyCommand(label) {
  throw new Error(
    message(
      `${label} is available only in the web UI. Use the CLI for development, DB/storage operations, server deployment, usage, and logs.`,
      `${label} 기능은 웹 화면에서만 사용할 수 있습니다. CLI는 개발, DB/스토리지 작업, 서버 배포, 사용량, 로그 조회용입니다.`
    )
  );
}

async function linkProject(flags, options = {}) {
  const project = requireProjectId(flags);
  if (options.output === false) {
    throw new Error('link no longer supports internal workspace generation; use start');
  }
  await startProjectCommand([project], flags);
}

async function getProject(flags) {
  const project = requireProjectId(flags);
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    console.log(`Project: ${value.project_id}`);
    console.log(`Slug: ${value.project_slug}`);
    console.log(`Status: ${value.status}`);
    console.log(`URL: ${value.default_url}`);
    console.log(`Last deployed: ${value.last_deployed_at ?? 'never'}`);
  });
}

async function reportAgentIssue(flags) {
  const project = requireProjectId(flags);
  const category = (stringFlag(flags, 'category') || 'problem').trim().toLowerCase();
  if (category !== 'problem' && category !== 'bug') {
    throw new Error('report --category must be problem or bug');
  }
  const summary = (stringFlag(flags, 'summary') || stringFlag(flags, 'message')).trim();
  if (!summary) throw new Error('report requires --summary');
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/agent-reports`, {
    method: 'POST',
    ...projectAuth(flags),
    body: {
      category,
      summary,
      details: stringFlag(flags, 'details') || null,
      expected: stringFlag(flags, 'expected') || null,
      actual: stringFlag(flags, 'actual') || null,
      error_code: stringFlag(flags, 'error-code') || null,
      cli_version: require('../package.json').version,
      runtime_version: process.version,
      platform_name: process.platform,
    },
  });
  output(flags, body, (value) => {
    console.log(`Agent report submitted: ${value.report_id}`);
  });
}

async function dbCommand(rest, flags) {
  const subcommand = rest[0] || 'schema';
  const project = requireProjectId(flags);

  if (subcommand === 'schema') {
    const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/db/schema`, {
      method: 'GET',
      ...projectAuth(flags),
    });
    output(flags, body, (value) => {
      for (const object of value.objects ?? []) {
        console.log(`${object.type}\t${object.name}`);
        if (object.sql) console.log(`  ${object.sql}`);
      }
    });
    return;
  }

  if (subcommand === 'query') {
    const sql = sqlFromFlags(flags, 'query');
    const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/db/query`, {
      method: 'POST',
      ...projectAuth(flags),
      body: { sql },
    });
    output(flags, body, (value) => {
      console.log(JSON.stringify(value.rows ?? [], null, 2));
    });
    return;
  }

  if (subcommand === 'migrate') {
    const sql = sqlFromFlags(flags, 'migrate');
    const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/db/migrations`, {
      method: 'POST',
      ...projectAuth(flags),
      body: {
        name: stringFlag(flags, 'name') || null,
        sql,
      },
    });
    output(flags, body, (value) => {
      console.log(`DB migration complete: ${value.project_id}`);
      console.log(`Statements: ${value.statements}`);
    });
    return;
  }

  throw new Error(`Unknown db command: ${subcommand}`);
}

async function storageCommand(rest, flags) {
  const subcommand = rest[0] || 'list';
  const project = requireProjectId(flags);

  if (subcommand === 'list') {
    const search = new URLSearchParams();
    const prefix = stringFlag(flags, 'prefix');
    const cursor = stringFlag(flags, 'cursor');
    const limit = stringFlag(flags, 'limit');
    if (prefix) search.set('prefix', prefix);
    if (cursor) search.set('cursor', cursor);
    if (limit) search.set('limit', limit);
    const query = search.toString() ? `?${search.toString()}` : '';
    const body = await apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/storage/objects${query}`,
      {
        method: 'GET',
        ...projectAuth(flags),
      }
    );
    output(flags, body, (value) => {
      for (const object of value.objects ?? []) {
        console.log(`${object.key}\t${object.size ?? 0} B\t${object.uploaded ?? ''}`);
      }
      if (value.cursor) console.log(`Next cursor: ${value.cursor}`);
    });
    return;
  }

  if (subcommand === 'get') {
    const key = requireStorageKey(flags);
    const body = await apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/storage/objects/${encodeURIComponent(key)}`,
      {
        method: 'GET',
        ...projectAuth(flags),
      }
    );
    const outPath = stringFlag(flags, 'out');
    if (outPath) {
      const bytes = body.base64
        ? Buffer.from(body.base64, 'base64')
        : Buffer.from(String(body.text ?? ''), 'utf8');
      fs.writeFileSync(path.resolve(outPath), bytes);
    }
    output(flags, body, (value) => {
      if (outPath) {
        console.log(`Wrote: ${path.resolve(outPath)}`);
        return;
      }
      if (typeof value.text === 'string') {
        console.log(value.text);
        return;
      }
      console.log(`Binary object: ${value.key} (${value.size} B). Use --out to save it.`);
    });
    return;
  }

  if (subcommand === 'put') {
    const key = requireStorageKey(flags);
    const filePath = stringFlag(flags, 'file');
    const text = stringFlag(flags, 'text');
    const hasText = flags.text !== undefined && flags.text !== true;
    if (!filePath && !hasText) {
      throw new Error('storage put requires --file or --text');
    }
    if (filePath && hasText) throw new Error('storage put accepts only one of --file or --text');
    const body = filePath
      ? {
          base64: fs.readFileSync(path.resolve(filePath)).toString('base64'),
          content_type: stringFlag(flags, 'content-type') || contentTypeForPath(filePath),
        }
      : {
          text,
          content_type: stringFlag(flags, 'content-type') || 'text/plain; charset=utf-8',
        };
    const result = await apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/storage/objects/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        ...projectAuth(flags),
        body,
      }
    );
    output(flags, result, (value) => {
      console.log(`Stored: ${value.key} (${value.size} B)`);
    });
    return;
  }

  if (subcommand === 'delete') {
    const key = requireStorageKey(flags);
    if (!flags.yes) {
      throw new Error('storage delete requires --yes');
    }
    const body = await apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/storage/objects/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
        ...projectAuth(flags),
      }
    );
    output(flags, body, (value) => {
      console.log(`Deleted: ${value.key}`);
    });
    return;
  }

  throw new Error(`Unknown storage command: ${subcommand}`);
}

async function deployCode(flags, options = {}) {
  const project = requireProjectId(flags);
  const label = stringFlag(flags, 'label').trim();
  if (!label) throw new Error('deploy requires --label');
  let deployPayload;
  try {
    deployPayload = buildDeployPayload(flags);
  } catch (error) {
    if (error?.code !== 'archive_required') throw error;
    return checkpointCommands.deployArchive(flags, project, label, error.message, options);
  }
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/deploy`, {
    method: 'POST',
    ...projectAuth(flags),
    body: { ...deployPayload, label },
  });

  if (options.output !== false) {
    output(flags, body, (value) => {
      console.log(`Deployment: ${value.deployment_id}`);
      console.log(`Status: ${value.status}`);
      console.log(`URL: ${value.url}`);
      printDeploymentWarnings(value.warnings);
    });
  }
  return body;
}

function printDeploymentWarnings(warnings) {
  for (const warning of warnings || [])
    console.warn(message(`Warning: ${warning.message}`, `경고: ${warning.message}`));
}

async function listDeployments(flags) {
  const project = requireProjectId(flags);
  const limit = positiveIntegerFlag(flags, 'limit');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (booleanFlag(flags, 'include-failure-details')) params.set('include_failure_details', 'true');
  const query = params.size ? `?${params}` : '';
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/deployments${query}`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    for (const deployment of value.deployments) {
      console.log(
        `${deployment.version}\t${deployment.deployment_id}\t${deployment.status}\trollback=${deployment.rollback_available}\t${deployment.created_at}`
      );
      if (deployment.error_message)
        console.log(
          `${deployment.error_stage || 'unknown'} / ${deployment.error_code || 'unknown'}: ${deployment.error_message}`
        );
      if (deployment.github)
        console.log(
          `GitHub: ${deployment.github.commit_sha} ${deployment.github.run_url} (${deployment.github.diagnostic_status || 'pending'})`
        );
      if (deployment.error_details) console.log(deployment.error_details);
    }
  });
}

async function rollbackDeployment(flags) {
  const project = requireProjectId(flags);
  const deployment = stringFlag(flags, 'deployment') || stringFlag(flags, 'deployment-id');
  if (!deployment) {
    throw new Error('rollback requires --deployment');
  }

  const body = await apiRequest(
    flags,
    `/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(deployment)}/rollback`,
    {
      method: 'POST',
      ...projectAuth(flags),
    }
  );

  output(flags, body, (value) => {
    console.log(`Deployment: ${value.deployment_id}`);
    console.log(`Rolled back from: ${value.rolled_back_from}`);
    console.log(`URL: ${value.url}`);
  });
}

async function listRuntimeEvents(flags) {
  const project = requireProjectId(flags);
  const params = new URLSearchParams();
  const eventType = stringFlag(flags, 'event-type') || stringFlag(flags, 'event_type');
  const limit = positiveIntegerFlag(flags, 'limit');
  if (eventType) {
    params.set('event_type', eventType);
  }
  if (limit) {
    params.set('limit', String(limit));
  }

  const query = params.toString() ? `?${params.toString()}` : '';
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/runtime-events${query}`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    for (const event of value.events) {
      console.log(
        `${event.created_at}\t${event.event_type}\t${event.status}\t${event.method}\t${event.path}\t${event.duration_ms}ms\t${event.error_message ?? ''}`
      );
    }
  });
}

async function getUsage(flags) {
  const project = requireProjectId(flags);
  const date = stringFlag(flags, 'date');
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/usage${query}`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    console.log(`Date: ${value.date}`);
    console.log(`Requests: ${value.requests}`);
    console.log(`Errors: ${value.errors}`);
    console.log(`Deploys: ${value.deploy_count}`);
  });
}

async function getUsageSummary(flags) {
  const project = requireProjectId(flags);
  const query = usageRangeQuery(flags);
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/usage/summary${query}`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, printUsageSummary);
}

async function getUsageBreakdown(flags) {
  const project = requireProjectId(flags);
  const params = new URLSearchParams(usageRangeParams(flags));
  const groupBy = stringFlag(flags, 'group-by') || stringFlag(flags, 'group_by');
  if (groupBy) {
    params.set('group_by', groupBy);
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  const body = await apiRequest(
    flags,
    `/v1/projects/${encodeURIComponent(project)}/usage/breakdown${query}`,
    {
      method: 'GET',
      ...projectAuth(flags),
    }
  );

  output(flags, body, (value) => {
    printUsageSummary(value);
    for (const item of value.series ?? []) {
      console.log(
        `${item.bucket}\trequests=${item.requests_total}\terrors=${item.errors_total}\tin=${item.request_bytes ?? 0}\tout=${item.response_bytes ?? 0}\trealtime_out=${item.realtime_messages_out ?? 0}\trealtime_peak=${item.realtime_peak_connections ?? 0}\tdeploys=${item.deploy_count}\tcron=${item.cron_runs}\twebhooks=${item.webhook_deliveries}`
      );
    }
  });
}

function printUsageSummary(value) {
  console.log(`Range: ${value.range.from}..${value.range.to}`);
  console.log(`Requests: ${value.totals.requests_total}`);
  console.log(`Errors: ${value.totals.errors_total}`);
  console.log(
    `2xx/3xx/4xx/5xx: ${value.totals.requests_2xx}/${value.totals.requests_3xx}/${value.totals.requests_4xx}/${value.totals.requests_5xx}`
  );
  console.log(`Deploys: ${value.totals.deploy_count}`);
  console.log(`Rollbacks: ${value.totals.rollback_count}`);
  console.log(`Realtime messages out: ${value.totals.realtime_messages_out ?? 0}`);
  console.log(`Realtime peak connections: ${value.totals.realtime_peak_connections ?? 0}`);
  console.log(`Storage total: ${formatBytes(storageTotalUsageBytes(value.totals))}`);
  console.log(`Project files: ${formatBytes(value.totals.deployment_source_storage_bytes ?? 0)}`);
  console.log(`Cron runs/failures: ${value.totals.cron_runs}/${value.totals.cron_failures}`);
  console.log(
    `Webhook deliveries/failures: ${value.totals.webhook_deliveries}/${value.totals.webhook_failures}`
  );
}

function storageTotalUsageBytes(totals = {}) {
  if (totals.storage_total_bytes !== undefined && totals.storage_total_bytes !== null) {
    return Number(totals.storage_total_bytes || 0);
  }
  return Number(totals.r2_storage_bytes || 0) + Number(totals.deployment_source_storage_bytes || 0);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes).toLocaleString()} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: size >= 10 ? 1 : 2 })} ${units[unitIndex]}`;
}

async function listWebhooks(flags) {
  const project = requireProjectId(flags);
  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/webhooks`, {
    method: 'GET',
    ...projectAuth(flags),
  });

  output(flags, body, (value) => {
    for (const webhook of value.webhooks) {
      console.log(
        `${webhook.webhook_id}\t${webhook.name}\t${webhook.url}\tevents=${webhook.events.join(',')}\tlast=${webhook.last_status ?? 'none'}`
      );
    }
  });
}

async function createWebhook(flags) {
  const project = requireProjectId(flags);
  const url = stringFlag(flags, 'url');
  if (!url) {
    throw new Error('webhook create requires --url');
  }

  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/webhooks`, {
    method: 'POST',
    ...projectAuth(flags),
    body: {
      name: stringFlag(flags, 'name') || undefined,
      url,
      events: stringFlag(flags, 'events') || undefined,
    },
  });

  output(flags, body, (value) => {
    printWebhook(value.webhook);
    console.log(`Signing secret: ${value.signing_secret}`);
  });
}

async function testWebhook(flags) {
  const project = requireProjectId(flags);
  const webhookId = stringFlag(flags, 'webhook-id') || stringFlag(flags, 'webhook_id');
  if (!webhookId) {
    throw new Error('webhook test requires --webhook-id');
  }

  const body = await apiRequest(
    flags,
    `/v1/projects/${encodeURIComponent(project)}/webhooks/${encodeURIComponent(webhookId)}/test`,
    {
      method: 'POST',
      ...projectAuth(flags),
    }
  );

  output(flags, body, (value) => {
    printWebhookDelivery(value.delivery);
  });
}

async function listWebhookDeliveries(flags) {
  const project = requireProjectId(flags);
  const webhookId = stringFlag(flags, 'webhook-id') || stringFlag(flags, 'webhook_id');
  if (!webhookId) {
    throw new Error('webhook deliveries requires --webhook-id');
  }

  const limit = positiveIntegerFlag(flags, 'limit');
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const body = await apiRequest(
    flags,
    `/v1/projects/${encodeURIComponent(project)}/webhooks/${encodeURIComponent(webhookId)}/deliveries${query}`,
    {
      method: 'GET',
      ...projectAuth(flags),
    }
  );

  output(flags, body, (value) => {
    for (const delivery of value.deliveries) {
      printWebhookDelivery(delivery);
    }
  });
}

async function deleteWebhook(flags) {
  const project = requireProjectId(flags);
  const webhookId = stringFlag(flags, 'webhook-id') || stringFlag(flags, 'webhook_id');
  if (!webhookId) {
    throw new Error('webhook delete requires --webhook-id');
  }

  const body = await apiRequest(
    flags,
    `/v1/projects/${encodeURIComponent(project)}/webhooks/${encodeURIComponent(webhookId)}`,
    {
      method: 'DELETE',
      ...projectAuth(flags),
    }
  );

  output(flags, body, (value) => {
    console.log(`${value.webhook_id}: ${value.status}`);
  });
}

function printWebhook(webhook) {
  console.log(`Webhook: ${webhook.webhook_id}`);
  console.log(`Name: ${webhook.name}`);
  console.log(`URL: ${webhook.url}`);
  console.log(`Events: ${webhook.events.join(', ')}`);
  console.log(`Last status: ${webhook.last_status ?? 'none'}`);
  console.log(`Last error: ${webhook.last_error ?? 'none'}`);
}

function printWebhookDelivery(delivery) {
  console.log(
    `${delivery.delivery_id}\t${delivery.event_type}\tstatus=${delivery.status ?? 'none'}\tduration=${delivery.duration_ms}ms\terror=${delivery.error_message ?? 'none'}`
  );
}

async function listTokens(flags) {
  throw new Error(
    message(
      'Issue or disable API tokens in your web profile. CLI tokens are for project management.',
      'API 토큰은 웹 프로필에서 발급하거나 사용 중지해주세요. CLI 토큰은 프로젝트 관리 전용입니다.'
    )
  );
}

async function createToken(flags) {
  throw new Error(
    message(
      'Issue API tokens in your web profile. A CLI token cannot create new tokens.',
      'API 토큰은 웹 프로필에서 발급해주세요. CLI 토큰으로 새 토큰을 만들 수 없습니다.'
    )
  );
}

async function revokeToken(flags) {
  throw new Error(
    message(
      'Disable API tokens in your web profile. A CLI token cannot revoke tokens.',
      'API 토큰은 웹 프로필에서 사용 중지해주세요. CLI 토큰으로 토큰을 폐기할 수 없습니다.'
    )
  );
}

async function deleteProject(flags) {
  const project = requireProjectId(flags);
  if (!flags.yes) {
    throw new Error('delete requires --yes');
  }

  const body = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}`, {
    method: 'DELETE',
    ...projectAuth(flags),
    body: { delete_agreement: true },
  });

  output(flags, body, (value) => {
    console.log(`${project}: ${value.status}`);
  });
}

async function apiRequest(flags, apiPath, options) {
  const apiUrl = trimTrailingSlash(options.apiBaseUrl || apiBaseUrl(flags));
  const headers = {
    ...(options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {}),
    ...(options.adminToken ? { 'X-Joripspace-Admin-Token': options.adminToken } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    'X-Joripspace-Session-Context': 'cli',
  };

  const timeoutMs =
    options.timeoutMs === null
      ? null
      : (options.timeoutMs ?? (isDeploymentRequest(apiPath) ? null : GENERAL_REQUEST_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}${apiPath}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const state = isDeploymentMutation(apiPath, options.method)
        ? ' Deployment state is unknown; list deployments before retrying.'
        : '';
      const timeoutError = new Error(
        `request timed out after ${Math.round(timeoutMs / 1000)} seconds.${state}`
      );
      timeoutError.code = 'request_timeout';
      throw timeoutError;
    }
    const requestError = new Error(
      redactAuthError(error instanceof Error ? error.message : String(error), [
        options.apiToken,
        options.adminToken,
        options.body?.code,
      ])
    );
    requestError.code = 'request_failed';
    throw requestError;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text ? parseJson(text) : {};

  if (!response.ok) {
    const safe = redactAuthError(body, [options.apiToken, options.adminToken, options.body?.code]);
    const message =
      safe?.error?.message || safe?.message || JSON.stringify(safe) || `HTTP ${response.status}`;
    const apiError = new Error(formatDeploymentFailure(message, safe?.error?.details));
    apiError.code = safe?.error?.code || 'http_error';
    apiError.status = response.status;
    if (safe?.error?.details !== undefined) apiError.details = safe.error.details;
    throw apiError;
  }

  if (options.includeHeaders) {
    return { body, headers: response.headers };
  }

  return body;
}

function isDeploymentRequest(apiPath) {
  return /\/deploy(?:ments)?(?:[/?]|$)|\/checkpoints\/[^/]+\/deploy(?:[/?]|$)/.test(apiPath);
}

function isDeploymentMutation(apiPath, method) {
  return method === 'POST' && (/\/deploy(?:[/?]|$)/.test(apiPath) || /\/rollback(?:[/?]|$)/.test(apiPath));
}

function browserConnectInstructions() {
  return {
    status: 'browser_connection_required',
    connect_url: 'https://joripspace.com/connect/',
    message: message(
      'No email address is required. Sign in to JoripSpace in your browser, approve the connection, and copy the one-time code, valid for five minutes.',
      '이메일 주소는 필요 없습니다. 브라우저에서 JoripSpace에 로그인한 뒤 연결을 승인하고 5분 일회용 연결 코드를 복사하세요.'
    ),
    save_command: 'joripspace login --code "CONNECTION_CODE"',
  };
}

function printBrowserConnectInstructions(value) {
  console.log(
    message(
      'Approve the JoripSpace connection in your browser.',
      '브라우저에서 JoripSpace 연결을 승인하세요.'
    )
  );
  console.log(
    message(
      'No email address or email verification is required.',
      '이메일 주소 입력이나 메일 확인은 필요 없습니다.'
    )
  );
  console.log(message(`Connection page: ${value.connect_url}`, `연결 페이지: ${value.connect_url}`));
  console.log(
    message(
      'After approval, exchange the displayed five-minute one-time code using this command.',
      '승인 후 화면에 표시되는 5분 일회용 연결 코드를 아래 명령으로 교환하세요.'
    )
  );
  console.log(value.save_command);
}

function normalizeConnectToken(value) {
  const token = String(value || '').trim();
  if (!token) {
    throw new Error('connect token is required');
  }
  if (
    token.startsWith(SESSION_COOKIE_PREFIX) ||
    /[\u0000-\u0020\u007f]/.test(token) ||
    /^bearer\s+/i.test(token) ||
    ['dummy', 'test', 'token', 'undefined', 'null'].includes(token.toLowerCase())
  ) {
    throw new Error(
      message(
        'Browser cookies, Bearer strings, empty placeholders, and test values cannot be used as CLI connection tokens. Get a new connection token at /connect/.',
        '브라우저 쿠키, Bearer 문자열, 빈 자리표시자, 테스트 값은 CLI 연결 토큰으로 사용할 수 없습니다. /connect/에서 새 연결 토큰을 발급하세요.'
      )
    );
  }
  return token;
}

function normalizeConnectionCode(value) {
  const normalized = String(value || '')
    .replace(/[\s-]+/g, '')
    .toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(normalized)) {
    throw new Error(
      message(
        'The connection code must be the 16-character alphanumeric value shown on the connection page.',
        '연결 코드는 화면에 표시된 16자리 영숫자 값이어야 합니다.'
      )
    );
  }
  return normalized.match(/.{1,4}/g).join('-');
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
      const key = rawKey.trim();
      const next = argv[index + 1];
      const value =
        inlineValue !== undefined ? inlineValue : next && !next.startsWith('-') ? argv[++index] : true;
      addFlag(flags, key, value);
      continue;
    }

    if (arg.startsWith('-') && arg.length === 2) {
      addFlag(flags, arg.slice(1), true);
      continue;
    }

    positional.push(arg);
  }

  return {
    command: positional[0],
    rest: positional.slice(1),
    flags,
  };
}

function addFlag(flags, key, value) {
  if (flags[key] === undefined) {
    flags[key] = value;
    return;
  }

  if (Array.isArray(flags[key])) {
    flags[key].push(value);
    return;
  }

  flags[key] = [flags[key], value];
}

function output(flags, body, humanPrinter) {
  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  humanPrinter(body);
}

function requireProjectId(flags) {
  const explicit = stringFlag(flags, 'project') || stringFlag(flags, 'project-id');
  const linked = readLinkedProjectId(flags);
  if (explicit && linked && explicit !== linked) {
    throw new Error(`project ${explicit} conflicts with linked project ${linked}`);
  }
  const value = explicit || linked;
  if (!value) {
    throw new Error('missing project slug. Pass --project or run joripspace start PROJECT --cwd PATH');
  }
  return value;
}

function sqlFromFlags(flags, commandName) {
  const inline = stringFlag(flags, 'sql');
  const filePath = stringFlag(flags, 'file');
  if (inline) {
    return inline;
  }
  if (filePath) {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  }
  throw new Error(`db ${commandName} requires --sql or --file`);
}

function requireStorageKey(flags) {
  const key = stringFlag(flags, 'key');
  if (!key) {
    throw new Error('storage command requires --key');
  }
  if (key.startsWith('/') || key.includes('../') || key.includes('..\\')) {
    throw new Error('storage key must be a project-relative object key');
  }
  return key;
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function requireAccountId(flags) {
  const projectEnv = readProjectEnv(projectWorkspaceDir(flags));
  const value =
    stringFlag(flags, 'account') ||
    stringFlag(flags, 'account-id') ||
    process.env.JORIPSPACE_ACCOUNT_ID ||
    projectEnv.JORIPSPACE_ACCOUNT_ID ||
    readGlobalSession(flags)?.account?.account_id;
  if (!value) {
    throw new Error('missing account id. Run joripspace login or pass --account');
  }
  return value;
}

function projectAuth(flags) {
  const connection = resolveConnection(flags);
  return {
    apiToken: requireApiToken(flags, connection),
    apiBaseUrl: connection.apiBaseUrl,
  };
}

function optionalApiToken(flags) {
  const token = resolveConnection(flags).apiToken;
  return token ? normalizeConnectToken(token) : '';
}

function apiBaseUrl(flags) {
  return resolveConnection(flags).apiBaseUrl;
}

function resolveConnection(flags) {
  const explicitToken = stringFlag(flags, 'token') || stringFlag(flags, 'api-token');
  if (explicitToken) return connectionForExplicitToken(flags, explicitToken);

  const environmentToken = process.env.JORIPSPACE_API_TOKEN || process.env.JORIPSPACE_CONNECT_TOKEN || '';
  if (environmentToken) {
    return {
      apiToken: environmentToken,
      apiBaseUrl: trimTrailingSlash(
        process.env.JORIPSPACE_API_URL || process.env.JORIPSPACE_API_BASE_URL || DEFAULT_API_URL
      ),
      source: 'process-environment',
    };
  }

  const workspaceDir = projectWorkspaceDir(flags);
  const projectEnv = readProjectEnv(workspaceDir);
  if (projectEnv.JORIPSPACE_API_TOKEN) {
    return {
      apiToken: projectEnv.JORIPSPACE_API_TOKEN,
      apiBaseUrl: trimTrailingSlash(projectEnv.JORIPSPACE_API_BASE_URL || DEFAULT_API_URL),
      source: 'project-env',
      accountId: projectEnv.JORIPSPACE_ACCOUNT_ID,
      workspaceDir,
    };
  }

  const managedOsConnection = ['os-credential-store', 'project-env-fallback', 'logged-out'].includes(
    projectEnv.JORIPSPACE_CONNECTION_SOURCE
  );
  const legacyProjectConnection = managedOsConnection
    ? null
    : readLegacyProjectSessionConnection(workspaceDir);
  if (legacyProjectConnection) return legacyProjectConnection;

  const legacy = managedOsConnection ? null : readGlobalSession(flags);
  const legacyToken = legacy?.api_token || legacy?.connect_token;
  if (legacyToken) {
    return {
      apiToken: legacyToken,
      apiBaseUrl: trimTrailingSlash(legacy.api_base_url || DEFAULT_API_URL),
      source: 'legacy-global-session',
      accountId: legacy.account?.account_id || legacy.account_id,
      workspaceDir,
    };
  }

  const selectedApiBaseUrl = trimTrailingSlash(
    projectEnv.JORIPSPACE_API_BASE_URL ||
      stringFlag(flags, 'api-url') ||
      process.env.JORIPSPACE_API_URL ||
      process.env.JORIPSPACE_API_BASE_URL ||
      DEFAULT_API_URL
  );
  let stored = null;
  try {
    stored = credentialStore.load(selectedApiBaseUrl, projectEnv.JORIPSPACE_ACCOUNT_ID || '');
  } catch (error) {
    if (error.code !== 'credential_store_unavailable' || projectEnv.JORIPSPACE_CONNECTION_SOURCE === 'os-credential-store') throw error;
  }
  if (stored) return { ...stored, workspaceDir };

  return {
    apiToken: '',
    apiBaseUrl: selectedApiBaseUrl,
    source: 'none',
    workspaceDir,
  };
}

function connectionForExplicitToken(flags, apiToken) {
  return {
    apiToken,
    apiBaseUrl: trimTrailingSlash(stringFlag(flags, 'api-url') || DEFAULT_API_URL),
    source: 'explicit-flag',
  };
}

function unauthenticatedApiBaseUrl(flags) {
  return trimTrailingSlash(
    stringFlag(flags, 'api-url') ||
      process.env.JORIPSPACE_API_URL ||
      process.env.JORIPSPACE_API_BASE_URL ||
      DEFAULT_API_URL
  );
}

function globalSessionPath(flags) {
  return path.join(os.homedir(), '.joripspace', 'session.json');
}

function readGlobalSession(flags) {
  const filePath = globalSessionPath(flags);
  const value = readJsonFile(filePath);
  return value ? { ...value, path: filePath } : null;
}

function scrubGlobalSessionToken() {
  const filePath = globalSessionPath({});
  const session = readJsonFile(filePath);
  if (
    !session ||
    (!Object.prototype.hasOwnProperty.call(session, 'api_token') &&
      !Object.prototype.hasOwnProperty.call(session, 'connect_token'))
  ) {
    return false;
  }
  const next = { ...session };
  delete next.api_token;
  delete next.connect_token;
  next.migrated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, next, 0o600);
  return true;
}

function persistStartConnection(flags, connection, context = {}) {
  if (
    !['project-env', 'legacy-global-session', 'legacy-project-session', 'os-credential-store'].includes(
      connection?.source
    ) ||
    !connection.apiToken
  ) {
    return false;
  }
  const workspaceDir = path.resolve(stringFlag(flags, 'cwd') || projectWorkspaceDir(flags));
  ensureProjectEnvIgnored(workspaceDir);
  persistProjectConnection(credentialStore, workspaceDir, {
    ...connection, accountId: context.accountId || connection.accountId,
  });
  if (connection.source === 'legacy-global-session') scrubGlobalSessionToken();
  return true;
}

function readLegacyProjectSessionConnection(workspaceDir) {
  const managedDirectory = canonicalWorkspaceEntry(workspaceDir, '.joripspace');
  if (!managedDirectory) return null;
  const sessionName = canonicalWorkspaceEntry(
    path.join(workspaceDir, managedDirectory),
    'agent-session.json'
  );
  if (!sessionName) return null;
  const sessionPath = managedProjectFilePath(workspaceDir, '.joripspace/agent-session.json');
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    const error = new Error('legacy .joripspace/agent-session.json is not valid JSON');
    error.code = 'legacy_workspace_migration_blocked';
    throw error;
  }
  const connection = legacyCredentialSessionConnection(session);
  if (!connection) return null;
  return {
    apiToken: connection.apiToken,
    apiBaseUrl: connection.apiBaseUrl,
    accountId: connection.accountId,
    source: 'legacy-project-session',
    workspaceDir,
  };
}

function canonicalWorkspaceEntry(directory, expected) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return '';
    throw error;
  }
  const matches = entries.filter((entry) => entry.toLowerCase() === expected.toLowerCase());
  if (!matches.length) return '';
  if (matches.length !== 1 || matches[0] !== expected) {
    const error = new Error(`legacy workspace path must use canonical casing: ${expected}`);
    error.code = 'non_canonical_workspace_path';
    throw error;
  }
  return matches[0];
}

async function connectForStart(flags, context) {
  let connectionCode = stringFlag(flags, 'code');
  if (!connectionCode) {
    connectionCode = await promptConnectionCode(flags);
    if (connectionCode === null) return resolveConnection(flags);
  }

  const exchangeApiBaseUrl = normalizeCredentialApiUrl(unauthenticatedApiBaseUrl(flags));
  ensureProjectEnvIgnored(context.cwd);
  const exchange = await apiRequest(flags, '/v1/auth/connection-code/exchange', {
    method: 'POST',
    body: { code: normalizeConnectionCode(connectionCode) },
    apiBaseUrl: exchangeApiBaseUrl,
  });
  const exchangedToken = normalizeConnectToken(exchange.connect_token);
  await saveBrowserConnectTokenWithOptions(
    { ...flags, cwd: context.cwd },
    exchangedToken,
    'connection-code',
    exchangeApiBaseUrl,
    { output: false }
  );
  return resolveConnection({ ...flags, cwd: context.cwd });
}

async function promptConnectionCode(flags) {
  if (flags.json || !process.stdin.isTTY || !process.stdout.isTTY) return null;
  const instructions = browserConnectInstructions();
  console.log(
    message(
      'Approve the JoripSpace connection in your browser.',
      '브라우저에서 JoripSpace 연결을 승인하세요.'
    )
  );
  console.log(
    message(`Connection page: ${instructions.connect_url}`, `연결 페이지: ${instructions.connect_url}`)
  );
  console.log(
    message(
      'After approval, paste the displayed five-minute one-time code into this terminal.',
      '승인 후 표시된 5분 일회용 연결 코드를 이 터미널에 붙여 넣으세요.'
    )
  );
  openExternalUrl(instructions.connect_url);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cancellation = new AbortController();
  prompt.once('close', () => cancellation.abort());
  try {
    return await prompt.question(message('Connection code: ', '연결 코드: '), {
      signal: cancellation.signal,
    });
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') throw error;
    const cancelled = new Error(
      message(
        'Connection code entry was cancelled. Run login again.',
        '연결 코드 입력이 취소되었습니다. login을 다시 실행하세요.'
      )
    );
    cancelled.code = 'connection_required';
    cancelled.exitCode = 2;
    throw cancelled;
  } finally {
    prompt.close();
  }
}

function openExternalUrl(url) {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function projectWorkspaceDir(flags, options = {}) {
  const start = path.resolve(stringFlag(flags, 'cwd') || process.cwd());
  if (options.discover === false) return start;
  let current = start;
  for (;;) {
    if (
      fs.existsSync(path.join(current, '.env.joripspace')) ||
      fs.existsSync(path.join(current, '.joripspace', 'project.json')) ||
      fs.existsSync(path.join(current, '.joripspace', 'project'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function readLinkedProjectId(flags) {
  const workspaceDir = projectWorkspaceDir(flags);
  const markerPath = managedProjectFilePath(workspaceDir, '.joripspace/project');
  if (fs.existsSync(markerPath)) return readProjectMarker(workspaceDir);
  return '';
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    ...(mode ? { mode } : {}),
  });
  replaceFileAtomically(temporaryPath, filePath);
  if (mode && process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

function writeTextAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, value, 'utf8');
  replaceFileAtomically(temporaryPath, filePath);
}

function managedProjectFilePath(workspaceDir, relative) {
  const location = resolveProjectFileTarget(workspaceDir, relative);
  if (location.blockers.length) {
    throw new Error(`managed project file path is blocked: ${location.blockers.join(', ')}`);
  }
  return location.target;
}

function assertSafeManagedWorkspace(workspaceDir) {
  resolveProjectDirectoryTarget(workspaceDir, '.joripspace');
  for (const relative of [
    '.env.joripspace',
    '.gitignore',
    'AGENTS.md',
    'CLAUDE.md',
    'package.json',
    '.joripspace/project',
    '.joripspace/project.json',
    '.joripspace/agent-session.json',
    '.joripspace/doctor.mjs',
    '.joripspace/deploy.mjs',
    '.joripspace/install-template.mjs',
    '.joripspace/pull.mjs',
    '.joripspace/checkpoint-client.mjs',
    '.joripspace/save.mjs',
    '.joripspace/checkpoints.mjs',
    '.joripspace/restore.mjs',
    '.joripspace/deploy-checkpoint.mjs',
    '.joripspace/github-actions-template.yml',
  ]) {
    managedProjectFilePath(workspaceDir, relative);
  }
}

function replaceFileAtomically(temporaryPath, filePath) {
  try {
    fs.renameSync(temporaryPath, filePath);
    return;
  } catch (error) {
    const backupPath = `${filePath}.bak-${process.pid}-${Date.now()}`;
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
      fs.renameSync(temporaryPath, filePath);
      fs.rmSync(backupPath, { force: true });
    } catch {
      try {
        if (fs.existsSync(backupPath) && !fs.existsSync(filePath)) fs.renameSync(backupPath, filePath);
      } catch {}
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

function requireApiToken(flags, connection) {
  const value = connection?.apiToken ? normalizeConnectToken(connection.apiToken) : optionalApiToken(flags);
  if (!value) {
    throw new Error('missing API token. Run joripspace login, pass --token, or set JORIPSPACE_API_TOKEN');
  }
  return value;
}

function stringFlag(flags, name) {
  const value = flags[name];
  if (Array.isArray(value)) {
    return String(value[value.length - 1]);
  }
  return typeof value === 'string' ? value : '';
}

function booleanFlag(flags, name) {
  const value = flags[name];
  if (Array.isArray(value)) {
    return Boolean(value[value.length - 1]);
  }
  return value === true || value === 'true' || value === '1';
}

function arrayFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function positiveIntegerFlag(flags, name) {
  const value = stringFlag(flags, name);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function usageRangeQuery(flags) {
  const params = new URLSearchParams(usageRangeParams(flags));
  return params.toString() ? `?${params.toString()}` : '';
}

function usageRangeParams(flags) {
  const params = {};
  const from = stringFlag(flags, 'from');
  const to = stringFlag(flags, 'to');
  if (from) {
    params.from = from;
  }
  if (to) {
    params.to = to;
  }
  return params;
}

function splitFileMapping(value) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--file must use name=path');
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}

function templateVars(flags) {
  const vars = {};
  for (const item of arrayFlag(flags, 'var')) {
    const [name, value] = splitFileMapping(item);
    vars[name] = value;
  }
  return vars;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
