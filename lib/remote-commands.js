const fs = require('node:fs');
const path = require('node:path');
const {
  assertNonOverlappingFilePlan,
  backupAndRemoveProjectPaths,
  createExternalBackupRoot,
  resolveProjectFileTarget,
  safeProjectRelativePath,
} = require('./project-paths');
const { ensureProjectEnvIgnored } = require('./project-env');

function createRemoteCommands(deps) {
  async function knowledge(rest, flags) {
    const subcommand = rest[0] || 'search';
    if (subcommand !== 'search') throw new Error('knowledge command requires: search');
    const query = deps.stringFlag(flags, 'query') || deps.stringFlag(flags, 'q') || rest.slice(1).join(' ');
    if (!query.trim()) throw new Error('knowledge search requires --query');
    const params = new URLSearchParams({ q: query });
    const limit = deps.positiveIntegerFlag(flags, 'limit');
    if (limit) params.set('limit', String(limit));
    const body = await deps.apiRequest(flags, `/v1/knowledge/search?${params}`, { method: 'GET' });
    deps.output(flags, body, (value) => {
      for (const item of value.results || value.items || []) {
        console.log(
          `${item.title || item.name || item.id || 'result'}\t${item.summary || item.description || ''}`
        );
      }
    });
  }

  async function deployment(rest, flags) {
    if (rest[0] === 'get') {
      const project = deps.requireProjectId(flags);
      const id = deps.stringFlag(flags, 'deployment') || deps.stringFlag(flags, 'deployment-id');
      if (!id) throw new Error('deployment get requires --deployment');
      const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}`, { method: 'GET', ...deps.projectAuth(flags) });
      deps.output(flags, body, (value) => console.log(JSON.stringify(value, null, 2)));
      return;
    }
    if (rest[0] !== 'pull' && rest[0] !== 'source') throw new Error('deployment command requires: pull');
    await pullDeploymentSource(flags);
  }

  async function pullDeploymentSource(flags, options = {}) {
    const project = deps.requireProjectId(flags);
    const deploymentId =
      deps.stringFlag(flags, 'deployment') ||
      deps.stringFlag(flags, 'deployment-id') ||
      deps.stringFlag(flags, 'deployment_id') ||
      'latest';
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(deploymentId)}/source`,
      { method: 'GET', ...deps.projectAuth(flags) }
    );
    const restore = restoreDeploymentFiles(deps.projectWorkspaceDir(flags), body, {
      force: options.force === true || deps.booleanFlag(flags, 'force'),
      backupConflicts: options.backupConflicts === true,
    });
    const value = { ...body, files: undefined, restore };
    if (options.output === false) return value;
    deps.output(flags, value, (response) => {
      console.log(`Deployment source: ${response.deployment_id || deploymentId}`);
      console.log(`Files written: ${response.restore.files_written}`);
      if (response.restore.backup_root) console.log(`Backup: ${response.restore.backup_root}`);
      if (response.restore.protected_files_skipped.length) {
        console.log(`Protected files skipped: ${response.restore.protected_files_skipped.length}`);
      }
    });
    return value;
  }

  function restoreDeploymentFiles(workspaceDir, body, options = {}) {
    ensureTokenIgnoreInvariant(workspaceDir);
    const files = body && typeof body.files === 'object' && !Array.isArray(body.files) ? body.files : null;
    if (!files) throw new Error('deployment source has no valid files');
    const planned = [];
    const protectedFiles = [];
    for (const [fileName, content] of Object.entries(files)) {
      const relative = safeProjectRelativePath(fileName);
      if (deps.isProtectedProjectPath(relative)) protectedFiles.push(relative);
      else planned.push([relative, String(content ?? '')]);
    }
    assertNonOverlappingFilePlan(planned.map(([relative]) => relative));
    const conflictPaths = new Set();
    const conflictingFiles = [];
    for (const [relative, content] of planned) {
      const location = resolveProjectFileTarget(workspaceDir, relative);
      if (location.blockers.length) {
        location.blockers.forEach((blocker) => conflictPaths.add(blocker));
        conflictingFiles.push(relative);
      } else if (fs.existsSync(location.target) && fs.readFileSync(location.target, 'utf8') !== content) {
        conflictPaths.add(relative);
        conflictingFiles.push(relative);
      }
    }
    if (conflictPaths.size && !options.force && !options.backupConflicts) {
      throw new Error(
        `deployment source conflicts with local files: ${[...conflictPaths].join(', ')}; re-run with --force to back up and replace them`
      );
    }
    let backupRoot = '';
    let backedUp = [];
    if (conflictPaths.size) {
      backupRoot = createExternalBackupRoot(workspaceDir, 'deployment-pull');
      backedUp = backupAndRemoveProjectPaths(workspaceDir, [...conflictPaths], backupRoot);
    }
    for (const [relative, content] of planned) {
      const location = resolveProjectFileTarget(workspaceDir, relative);
      if (location.blockers.length) {
        throw new Error(
          `deployment source target is blocked by a local path: ${location.blockers.join(', ')}`
        );
      }
      deps.writeTextAtomically(location.target, content);
    }
    ensureTokenIgnoreInvariant(workspaceDir);
    return {
      files_written: planned.length,
      conflicts_backed_up: backedUp,
      conflicting_files: conflictingFiles,
      backup_root: backupRoot || null,
      protected_files_skipped: protectedFiles,
    };
  }

  function ensureTokenIgnoreInvariant(workspaceDir) {
    if (fs.existsSync(path.join(workspaceDir, '.env.joripspace'))) {
      ensureProjectEnvIgnored(workspaceDir);
    }
  }

  async function secrets(rest, flags) {
    const subcommand = rest[0] || 'list';
    if (subcommand === 'list') return listSecrets(flags);
    if (subcommand === 'generate') return generateSecret(flags);
    if (subcommand === 'set' || subcommand === 'delete') return deps.webOnlyCommand('외부 시크릿 값 관리');
    throw new Error('secret command requires: list or generate');
  }

  async function generateSecret(flags) {
    const project = deps.requireProjectId(flags);
    const name = deps.stringFlag(flags, 'name');
    if (!name) throw new Error('secret generate requires --name');
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/secrets/generate`,
      {
        method: 'POST',
        ...deps.projectAuth(flags),
        body: { name },
      }
    );
    deps.output(flags, body, (value) => {
      console.log(`Secret: ${value.name || name}`);
      console.log(`Status: ${value.status || (value.generated ? 'generated' : 'preserved')}`);
    });
  }

  async function listSecrets(flags) {
    const project = deps.requireProjectId(flags);
    const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/secrets`, {
      method: 'GET',
      ...deps.projectAuth(flags),
    });
    deps.output(flags, body, (value) => {
      for (const secret of value.secrets || []) {
        console.log(`${secret.name}\tcreated=${secret.created_at}\tupdated=${secret.updated_at}`);
      }
    });
  }

  async function crons(rest, flags) {
    const subcommand = rest[0] || 'list';
    if (subcommand === 'list') return listCrons(flags);
    if (subcommand === 'create') return createCron(flags);
    if (subcommand === 'run') return runCron(flags);
    if (subcommand === 'delete') return deleteCron(flags);
    throw new Error('cron command requires: list, create, run, or delete');
  }

  async function listCrons(flags) {
    const project = deps.requireProjectId(flags);
    const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/crons`, {
      method: 'GET',
      ...deps.projectAuth(flags),
    });
    deps.output(flags, body, (value) => {
      for (const cron of value.crons || []) {
        console.log(
          `${cron.cron_id}\t${cron.name}\t${cron.schedule}\t${cron.method} ${cron.path}\tnext=${cron.next_run_at ?? 'none'}\tlast=${cron.last_run_at ?? 'never'}\tstatus=${cron.last_status ?? 'none'}`
        );
      }
    });
  }

  async function createCron(flags) {
    const project = deps.requireProjectId(flags);
    const schedule = deps.stringFlag(flags, 'schedule');
    const targetPath = deps.stringFlag(flags, 'path');
    if (!schedule || !targetPath) throw new Error('cron create requires --schedule and --path');
    const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/crons`, {
      method: 'POST',
      ...deps.projectAuth(flags),
      body: {
        name: deps.stringFlag(flags, 'name') || undefined,
        schedule,
        path: targetPath,
        method: deps.stringFlag(flags, 'method') || undefined,
      },
    });
    deps.output(flags, body, (value) => {
      console.log(`Cron: ${value.cron.cron_id}`);
      console.log(`Name: ${value.cron.name}`);
      console.log(`Schedule: ${value.cron.schedule}`);
      console.log(`Target: ${value.cron.method} ${value.cron.path}`);
      console.log(`Next run: ${value.cron.next_run_at}`);
    });
  }

  async function runCron(flags) {
    const project = deps.requireProjectId(flags);
    const cronId = deps.stringFlag(flags, 'cron-id') || deps.stringFlag(flags, 'cron_id');
    if (!cronId) throw new Error('cron run requires --cron-id');
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/crons/${encodeURIComponent(cronId)}/run`,
      { method: 'POST', ...deps.projectAuth(flags) }
    );
    deps.output(flags, body, (value) => console.log(`${value.cron_id}: ${value.status}`));
  }

  async function deleteCron(flags) {
    const project = deps.requireProjectId(flags);
    const cronId = deps.stringFlag(flags, 'cron-id') || deps.stringFlag(flags, 'cron_id');
    if (!cronId) throw new Error('cron delete requires --cron-id');
    if (!deps.booleanFlag(flags, 'yes')) throw new Error('cron delete requires --yes');
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/crons/${encodeURIComponent(cronId)}`,
      { method: 'DELETE', ...deps.projectAuth(flags) }
    );
    deps.output(flags, body, (value) => console.log(`${value.cron_id}: ${value.status}`));
  }

  async function domains(rest, flags) {
    const subcommand = rest[0] || 'list';
    if (subcommand === 'list') return listDomains(flags);
    if (subcommand === 'create') return createDomain(flags);
    if (subcommand === 'verify') return verifyDomain(flags);
    if (subcommand === 'delete') return deleteDomain(flags);
    throw new Error('domain command requires: list, create, verify, or delete');
  }

  async function listDomains(flags) {
    const project = deps.requireProjectId(flags);
    const params = new URLSearchParams();
    const cursor = deps.stringFlag(flags, 'cursor');
    const limit = deps.positiveIntegerFlag(flags, 'limit');
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/domains${params.size ? `?${params}` : ''}`,
      { method: 'GET', ...deps.projectAuth(flags) }
    );
    deps.output(flags, body, (value) => {
      for (const domain of value.domains || []) printDomain(domain);
      if (value.next_cursor) console.log(`Next cursor: ${value.next_cursor}`);
    });
  }

  async function createDomain(flags) {
    const project = deps.requireProjectId(flags);
    const hostname = deps.stringFlag(flags, 'hostname') || deps.stringFlag(flags, 'domain');
    if (!hostname) throw new Error('domain create requires --hostname');
    const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/domains`, {
      method: 'POST',
      ...deps.projectAuth(flags),
      body: { hostname },
    });
    deps.output(flags, body, (value) => printDomain(value.domain));
  }

  async function verifyDomain(flags) {
    const project = deps.requireProjectId(flags);
    const hostname = deps.stringFlag(flags, 'hostname') || deps.stringFlag(flags, 'domain');
    if (!hostname) throw new Error('domain verify requires --hostname');
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(hostname)}/verify`,
      { method: 'POST', ...deps.projectAuth(flags) }
    );
    deps.output(flags, body, (value) => printDomain(value.domain));
  }

  async function deleteDomain(flags) {
    const project = deps.requireProjectId(flags);
    const hostname = deps.stringFlag(flags, 'hostname') || deps.stringFlag(flags, 'domain');
    if (!hostname) throw new Error('domain delete requires --hostname');
    if (!deps.booleanFlag(flags, 'yes')) throw new Error('domain delete requires --yes');
    const body = await deps.apiRequest(
      flags,
      `/v1/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(hostname)}`,
      { method: 'DELETE', ...deps.projectAuth(flags) }
    );
    deps.output(flags, body, (value) => console.log(`${value.hostname}: ${value.status}`));
  }

  function printDomain(domain) {
    console.log(`Domain: ${domain.hostname}`);
    console.log(`Kind: ${domain.kind}`);
    console.log(`Status: ${domain.status}`);
    console.log(`Verification: ${domain.verification_status ?? 'none'}`);
    console.log(`URL: ${domain.url}`);
    if (domain.dns_target) console.log(`CNAME target: ${domain.dns_target}`);
    if (domain.ownership_verification_name && domain.ownership_verification_value) {
      console.log(
        `TXT verification: ${domain.ownership_verification_name} = ${domain.ownership_verification_value}`
      );
    }
  }

  async function mail(rest, flags) {
    const subcommand = rest[0] || 'status';
    const project = deps.requireProjectId(flags);
    if (subcommand === 'status') {
      const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/mail/status`, {
        method: 'GET',
        ...deps.projectAuth(flags),
      });
      deps.output(flags, body, (value) => {
        const state = value.mail || value;
        console.log(`Mail: ${state.status || (state.configured ? 'configured' : 'not configured')}`);
        if (state.provider) console.log(`Provider: ${state.provider}`);
      });
      return;
    }
    if (subcommand === 'connect') {
      const details = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}`, {
        method: 'GET',
        ...deps.projectAuth(flags),
      });
      const publicProject = details.project_slug || details.project_id || project;
      const status = await deps.apiRequest(
        flags,
        `/v1/projects/${encodeURIComponent(publicProject)}/mail/status`,
        { method: 'GET', ...deps.projectAuth(flags) }
      );
      const state = status.mail || status;
      const body =
        state.configured === true && state.status === 'connected'
          ? { status: 'already_connected', project_id: publicProject, mail: state }
          : state.google_oauth_setup_required === true
            ? {
                status: 'smtp_setup_available',
                project_id: publicProject,
                smtp_setup_url: `https://joripspace.com/projects/${encodeURIComponent(publicProject)}/?tab=mail`,
              }
            : {
                status: 'browser_google_consent_required',
                project_id: publicProject,
                connect_url: `https://joripspace.com/projects/${encodeURIComponent(publicProject)}/mail/google/start/`,
              };
      deps.output(flags, body, (value) => {
        console.log(`Mail connection: ${value.status}`);
        if (value.smtp_setup_url) console.log(`SMTP setup: ${value.smtp_setup_url}`);
        if (value.connect_url) console.log(`Google connection: ${value.connect_url}`);
      });
      return;
    }
    if (subcommand === 'test') {
      const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/mail/test`, {
        method: 'POST',
        ...deps.projectAuth(flags),
        body: {
          to: deps.stringFlag(flags, 'to') || undefined,
          subject: deps.stringFlag(flags, 'subject') || undefined,
        },
      });
      deps.output(flags, body, (value) => console.log(`Test mail: ${value.status || 'sent'}`));
      return;
    }
    throw new Error('mail command requires: connect, status, or test');
  }

  return {
    crons,
    deployment,
    domains,
    knowledge,
    listCrons,
    listDomains,
    listSecrets,
    mail,
    pullDeploymentSource,
    secrets,
  };
}

module.exports = { createRemoteCommands };
