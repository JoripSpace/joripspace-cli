const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectRoot, startProject } = require('./start');
const { ensureProjectEnvIgnored, readProjectEnv } = require('./project-env');

function createStartProjectCommand(
  apiRequest,
  output,
  resolveConnection,
  stringFlag,
  pullDeploymentSource,
  projectWorkspaceDir,
  persistConnection,
  connectForStart
) {
  return async function startProjectCommand(rest, flags) {
    const positionalProject = rest[0] || '';
    const flaggedProject = stringFlag(flags, 'project');
    if (positionalProject && flaggedProject && positionalProject !== flaggedProject) {
      throw new Error('start positional project and --project must match');
    }
    const project = flaggedProject || positionalProject;
    if (!project) throw new Error('start requires PROJECT');
    if (rest.length > 1) throw new Error('start accepts exactly one PROJECT');
    const requestedCwd = stringFlag(flags, 'cwd')
      ? path.resolve(stringFlag(flags, 'cwd'))
      : projectWorkspaceDir(flags);
    const cwd = resolveProjectRoot(requestedCwd, 'git');
    readProjectEnv(cwd);
    if (fs.existsSync(path.join(cwd, '.env.joripspace'))) {
      ensureProjectEnvIgnored(cwd);
    }
    const executable = path.resolve(
      process.env.JORIPSPACE_CLI_EXECUTABLE ||
        (process.pkg ? process.execPath : process.argv[1] || process.execPath)
    );
    const resolvedFlags = { ...flags, cwd };
    let connection = resolveConnection(resolvedFlags);
    if (!connection.apiToken) {
      connection = connectForStart
        ? await connectForStart(resolvedFlags, { cwd, executable, project })
        : connection;
    }
    if (!connection?.apiToken) {
      const apiUrlArgument = connection?.apiBaseUrl
        ? ` --api-url ${quoteCliArgument(connection.apiBaseUrl)}`
        : '';
      const invocation = `${!process.pkg && executable === path.resolve(process.argv[1] || '') ? quoteCliArgument(process.execPath) + ' ' : ''}${quoteCliArgument(executable)}`;
      const loginCommand = `${invocation} login --code "CONNECTION_CODE" --cwd ${quoteCliArgument(cwd)}${apiUrlArgument} --json`;
      const resumeCommand = `${invocation} start ${quoteCliArgument(project)} --cwd ${quoteCliArgument(cwd)} --json`;
      const value = {
        ok: false,
        status: 'connection_required',
        project,
        cwd,
        executable,
        connect_url: 'https://joripspace.com/connect/',
        message: '브라우저에서 연결을 승인하고 표시된 5분 일회용 연결 코드를 먼저 교환하세요.',
        login_command: loginCommand,
        resume_command: resumeCommand,
        next_action: 'run-login-command-then-resume-command',
        continue_with: 'cli',
      };
      throw startCommandError(value.status, value.message, value);
    }
    const apiToken = connection.apiToken;
    const connectionFlags = {
      ...flags,
      cwd,
      'api-token': connection.apiToken,
      'api-url': connection.apiBaseUrl,
    };

    const value = await startProject({
      projectId: project,
      cwd,
      apiToken,
      apiRequest: (apiPath, options) => apiRequest(connectionFlags, apiPath, options),
      executable,
      allowLegacyCredentialSession: connection.source === 'legacy-project-session',
      beforeWorkspaceMigration: persistConnection
        ? () => persistConnection(resolvedFlags, connection)
        : undefined,
    });
    if (value.ok && value.context?.source_sync?.status === 'latest_deployment_restore_required') {
      const deploymentId = value.context.source_sync.deployment_id;
      const deploymentRestore = await pullDeploymentSource(
        { ...connectionFlags, project: value.project, deployment: deploymentId },
        { output: false, backupConflicts: true }
      );
      value.context.source_sync = {
        status: 'synchronized',
        operation: 'deployment_restore',
        deployment_id: deploymentId,
        restore: deploymentRestore.restore,
      };
    }
    if (!value.ok) {
      throw startCommandError(
        value.status || 'start_incomplete',
        `JoripSpace start stopped: ${value.status || 'incomplete'}`,
        value
      );
    }
    output(flags, value, (result) => {
      console.log(`Started project: ${result.project}`);
      console.log(`CLI: ${result.executable}`);
      console.log('Session transport: CLI');
      console.log(`Next action: ${result.next_action}`);
      if (result.template_choice?.status === 'ready') {
        console.log(`Templates: ${result.template_choice.templates.length} available plus no-template option`);
      }
      if (result.context?.source_sync?.operation === 'deployment_restore') {
        console.log('Latest deployment source restored with conflict backups.');
      }
    });
  };
}

function startCommandError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 2;
  error.details = details;
  return error;
}

function quoteCliArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

module.exports = { createStartProjectCommand };
