const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ensureProjectEnvIgnored, removeGitignoreEntries } = require('./project-env');
const {
  createExternalBackupRoot,
  resolveProjectDirectoryTarget,
  resolveProjectFileTarget,
} = require('./project-paths');

const START_AGENTS_START = '<!-- joripspace:start -->';
const START_AGENTS_END = '<!-- joripspace:end -->';
const LEGACY_AGENTS_START = '<!-- joripspace:managed:start -->';
const LEGACY_AGENTS_END = '<!-- joripspace:managed:end -->';
const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;
const START_MANAGED_PATHS = new Set(['.joripspace/project', 'agents.md', 'claude.md']);
const LEGACY_HELPER_FILES = Object.freeze([
  ['.joripspace/doctor.mjs', 'projectDoctorHelperFile'],
  ['.joripspace/deploy.mjs', 'projectDeployHelperFile'],
  ['.joripspace/install-template.mjs', 'projectInstallTemplateHelperFile'],
  ['.joripspace/pull.mjs', 'projectPullHelperFile'],
  ['.joripspace/checkpoint-client.mjs', 'projectCheckpointClientFile'],
  ['.joripspace/save.mjs', 'projectSaveHelperFile'],
  ['.joripspace/checkpoints.mjs', 'projectCheckpointsHelperFile'],
  ['.joripspace/restore.mjs', 'projectRestoreHelperFile'],
  ['.joripspace/deploy-checkpoint.mjs', 'projectDeployCheckpointHelperFile'],
  ['.joripspace/github-actions-template.yml', 'projectGithubActionsTemplateFile'],
]);
const LEGACY_HELPER_SHA256 = Object.freeze({
  '.joripspace/doctor.mjs': '7a2e6332c6112e4645959edf6b62367fbbf447421e9a3c65d1d2990107664ea9',
  '.joripspace/deploy.mjs': '8a7c2afefc851a4a22e6672854c1c2f5e9f27e5c1491e5c66a18e7c395cd46fe',
  '.joripspace/install-template.mjs': 'f6c7b62869a850eef23e19cd051825ba9b07d66dcf3b5cd1284ecd4297e4ac15',
  '.joripspace/pull.mjs': '512bd54ceec30fc74b6cb8841492d67632fbc429dfb1b5f7c81fdad385a63af7',
  '.joripspace/checkpoint-client.mjs': '357cca6eafa8281b1482cb9ea45d0f67a78a908d03a3632bb113ad4dbbc9cd7c',
  '.joripspace/save.mjs': '32b4f360ad0c4fbe692d772c0bf652eb6fa703cd9cf23556e73726c045273559',
  '.joripspace/checkpoints.mjs': '06a56b295bbd6a933af975f8143fc9ec845c94ccfb154163368032267f5f1a41',
  '.joripspace/restore.mjs': 'ee55e7691cb5c1256de21ee67a7b8d07f890b60e79e8c8dd35d35ff182b8df41',
  '.joripspace/deploy-checkpoint.mjs': '8821b49aa61318e6db16159b320e0cb423202c450bdfbdb1be6420ec0b84a7bd',
});
const LEGACY_PROJECT_KEYS = new Set([
  'onboarding_schema_version',
  'agent_guide_updated_at',
  'deployment_policy',
  'project_id',
  'project_slug',
  'default_url',
  'api_base_url',
  'mcp_url',
  'deployment',
]);
const LEGACY_CREDENTIAL_SESSION_KEYS = new Set([
  'api_base_url',
  'api_token',
  'connect_token',
  'account',
  'source',
  'updated_at',
  'guide_checked_at',
  'global_session_file',
]);
const LEGACY_DEPLOYMENT_KEYS = new Set([
  'mode',
  'connection_status',
  'connections',
  'connection_id',
  'repository_id',
  'repository',
  'branch',
  'trigger_type',
  'trigger_ref',
  'workflow_path',
]);
const LEGACY_DEPLOYMENT_CONNECTION_KEYS = new Set([
  'connection_id',
  'repository_id',
  'repository_owner',
  'repository_name',
  'branch',
  'workflow_path',
  'status',
  'trigger_type',
  'trigger_ref',
]);

async function startProject(options) {
  const requestedProject = String(options.projectId || '').trim();
  if (!requestedProject) throw new Error('start requires a project name or slug');
  const workspace = resolveProjectRoot(options.cwd || process.cwd(), options.gitCommand || 'git');
  assertSafeProjectGuidance(workspace);

  const projectsContext = await options.apiRequest('/v1/me/projects', {
    method: 'GET',
    apiToken: options.apiToken,
  });
  const projects = Array.isArray(projectsContext?.projects) ? projectsContext.projects : [];
  const accessible = projects.find((candidate) => projectMatches(candidate, requestedProject));
  if (!accessible) {
    return {
      ok: false,
      status: 'project_not_found',
      project: requestedProject,
      cwd: workspace,
      available_projects: projects.map((candidate) => ({
        project: candidate.project_slug || candidate.slug || candidate.name || null,
        name: candidate.name || null,
        default_url: candidate.default_url || null,
        role: candidate.role || null,
      })),
      next_action: 'confirm-an-existing-project-name-or-slug; start-never-creates-projects',
    };
  }
  const projectSlug = canonicalProjectSlug(accessible);
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
    throw startError('invalid_project_slug', 'accessible project has no canonical project slug');
  }

  const workspaceState = inspectProjectWorkspace(workspace, projectSlug, {
    allowLegacyCredentialSession: options.allowLegacyCredentialSession === true,
  });
  if (!workspaceState.ok) {
    return {
      ok: false,
      status: workspaceState.status,
      project: projectSlug,
      existing_project: workspaceState.existingProject || null,
      cwd: workspace,
      conflicts: workspaceState.conflicts || [],
      next_action: workspaceState.nextAction,
    };
  }

  const [details, deployments] = await Promise.all([
    options.apiRequest(`/v1/projects/${encodeURIComponent(projectSlug)}`, {
      method: 'GET',
      apiToken: options.apiToken,
    }),
    options.apiRequest(`/v1/projects/${encodeURIComponent(projectSlug)}/deployments?limit=1`, {
      method: 'GET',
      apiToken: options.apiToken,
    }),
  ]);

  let sourceSync = syncConnectedGithubRepository(
    workspace,
    details?.deployment,
    options.gitCommand || 'git',
    { allowManagedWorkspace: workspaceState.onlyManagedFiles }
  );
  const sourceSyncBlocking =
    sourceSync &&
    !['synchronized', 'dirty_worktree', 'managed_worktree_preserved'].includes(sourceSync.status);
  if (sourceSyncBlocking) {
    return {
      ok: false,
      status: 'github_repository_sync_conflict',
      project: projectSlug,
      cwd: workspace,
      source_sync: sourceSync,
      next_action: 'resolve-the-reported-git-conflict-without-overwriting-local-work',
    };
  }

  const existingWorkBeforeGuidance = workspaceHasApplicationFiles(workspace);
  if (options.beforeWorkspaceMigration) {
    await Promise.resolve(options.beforeWorkspaceMigration({ project: projectSlug, workspace }));
  }
  const migrationState = inspectProjectWorkspace(workspace, projectSlug, {
    allowLegacyCredentialSession: options.allowLegacyCredentialSession === true,
  });
  if (!migrationState.ok) {
    return {
      ok: false,
      status: migrationState.status,
      project: projectSlug,
      existing_project: migrationState.existingProject || null,
      cwd: workspace,
      conflicts: migrationState.conflicts || [],
      next_action: migrationState.nextAction,
    };
  }
  if (options.beforeMigrationCommit) {
    await Promise.resolve(options.beforeMigrationCommit({ project: projectSlug, workspace }));
  }
  const migration = migrateProjectWorkspace(workspace, projectSlug, migrationState, options);
  const executable = path.resolve(options.executable || process.argv[1] || process.execPath);
  const latestDeployment = Array.isArray(deployments?.deployments)
    ? deployments.deployments[0] || null
    : null;
  const deploymentMode = details?.deployment?.mode || 'direct';
  if (!sourceSync && deploymentMode !== 'github_actions') {
    const restorable =
      latestDeployment?.status === 'success' &&
      (latestDeployment.download_available || latestDeployment.rollback_available);
    sourceSync =
      restorable && !existingWorkBeforeGuidance
        ? {
            status: 'latest_deployment_restore_required',
            deployment_id: latestDeployment.deployment_id,
          }
        : latestDeployment
          ? {
              status: 'existing_workspace_preserved',
              reason: existingWorkBeforeGuidance ? 'local_work_exists' : 'deployment_source_unavailable',
            }
          : null;
  }
  const description = normalizedDescription(details?.description ?? accessible?.description);
  const hasExistingWork = Boolean(
    existingWorkBeforeGuidance || latestDeployment || details?.deployment?.mode === 'github_actions'
  );
  const warnings = [];
  if (migration.backupRoot) {
    warnings.push({
      code: 'legacy_workspace_backup_created',
      message: 'Verified legacy onboarding files were moved outside the project before cleanup.',
      backup_root: migration.backupRoot,
    });
  }
  if (sourceSync?.status === 'dirty_worktree' || sourceSync?.status === 'managed_worktree_preserved') {
    warnings.push({
      code: 'local_work_preserved',
      message: 'Local Git changes were preserved and no source files were overwritten.',
    });
  }
  const templateChoice =
    !description && !hasExistingWork
      ? await loadTemplateChoice(options.apiRequest, options.apiToken, executable, projectSlug, workspace)
      : null;

  return {
    ok: true,
    project: projectSlug,
    executable,
    continue_with: 'cli',
    next_action: templateChoice
      ? templateChoice.status === 'ready'
        ? 'present-template-choice'
        : 'retry-start-once-before-project-questions'
      : 'continue-development',
    template_choice: templateChoice,
    context: {
      description,
      project_status: details?.status || accessible?.status || null,
      latest_deployment: latestDeployment,
      source_sync: sourceSync,
      warnings,
    },
  };
}

async function loadTemplateChoice(apiRequest, apiToken, executable, projectSlug, workspace) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await apiRequest('/v1/templates', { method: 'GET', apiToken });
      const templates = Array.isArray(result?.templates) ? result.templates : [];
      return {
        status: 'ready',
        optional: true,
        no_template_option: { number: 0, name: '템플릿 없이 시작' },
        templates: templates.map((template, index) => ({ ...template, number: index + 1 })),
        next_cursor: typeof result?.next_cursor === 'string' ? result.next_cursor : null,
        presentation:
          '프로젝트 질문 전에 0번과 templates를 번호, 템플릿 이름, 적합한 용도, 포함 기능이 있는 Markdown 표로 보여주고 사용자의 선택을 기다리세요.',
        install_command: `${!process.pkg && executable === path.resolve(process.argv[1] || '') ? quoteCommandArgument(process.execPath) + ' ' : ''}${quoteCommandArgument(executable)} install-template --template "TEMPLATE_SLUG" --project ${quoteCommandArgument(projectSlug)} --dir ${quoteCommandArgument(workspace)}`,
      };
    } catch {
      if (attempt === 2) break;
    }
  }
  return {
    status: 'temporarily_unavailable',
    optional: true,
    no_template_option: { number: 0, name: '템플릿 없이 시작' },
    templates: [],
    retryable: true,
    next_action:
      '같은 절대경로 CLI와 프로젝트로 start를 한 번 다시 실행한 뒤 템플릿 선택 전에는 서비스 질문으로 넘어가지 마세요.',
  };
}

function quoteCommandArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function syncConnectedGithubRepository(workspace, deployment, gitCommand, options = {}) {
  if (!deployment || deployment.mode !== 'github_actions') return null;
  const repository = String(deployment.repository || '').trim();
  const branch = String(deployment.branch || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !validGitBranch(branch)) {
    return { status: 'invalid_configuration', repository, branch };
  }
  const expectedUrl = `https://github.com/${repository}.git`;
  const inside = git(workspace, gitCommand, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status === 0 && inside.stdout.trim() === 'true') {
    const remote = git(workspace, gitCommand, ['remote', 'get-url', 'origin']);
    if (remote.status !== 0) return gitFailure('origin_missing', remote);
    if (githubRepository(remote.stdout.trim()) !== repository.toLowerCase()) {
      return {
        status: 'wrong_repository',
        expected_repository: repository,
        actual_remote: redactGitDiagnostic(remote.stdout.trim()),
      };
    }
    const currentBranch = git(workspace, gitCommand, ['branch', '--show-current']);
    if (currentBranch.status !== 0) return gitFailure('branch_check_failed', currentBranch);
    if (currentBranch.stdout.trim() !== branch) {
      return { status: 'wrong_branch', expected_branch: branch, actual_branch: currentBranch.stdout.trim() };
    }
    const status = git(workspace, gitCommand, ['status', '--porcelain', '--untracked-files=all']);
    if (status.status !== 0) return gitFailure('status_failed', status);
    if (status.stdout.trim()) {
      const changedFiles = status.stdout.trim().split(/\r?\n/);
      const onlyManaged = changedFiles.every((line) => isManagedGitStatusLine(line));
      return {
        status: onlyManaged ? 'managed_worktree_preserved' : 'dirty_worktree',
        changed_files: changedFiles,
        repository,
        branch,
      };
    }
    const fetch = git(workspace, gitCommand, ['fetch', '--no-tags', 'origin', branch]);
    if (fetch.status !== 0) return gitFailure('fetch_failed', fetch);
    const canFastForward = git(workspace, gitCommand, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
    if (canFastForward.status === 0) {
      const merge = git(workspace, gitCommand, ['merge', '--ff-only', 'FETCH_HEAD']);
      if (merge.status !== 0) return gitFailure('fast_forward_failed', merge);
      return { status: 'synchronized', operation: 'fast_forward', repository, branch };
    }
    const localAhead = git(workspace, gitCommand, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
    if (localAhead.status === 0) {
      return { status: 'synchronized', operation: 'local_ahead', repository, branch };
    }
    return { status: 'divergent_history', repository, branch };
  }

  const allowed = new Set(['.env.joripspace', '.gitignore']);
  if (options.allowManagedWorkspace) {
    allowed.add('.joripspace');
    allowed.add('agents.md');
    allowed.add('claude.md');
  }
  const unexpected = fs.readdirSync(workspace).filter((name) => !allowed.has(name.toLowerCase()));
  if (unexpected.length) return { status: 'non_empty_directory', unexpected_entries: unexpected };
  const temporary = `${workspace}.joripspace-clone-${process.pid}-${Date.now()}`;
  const clone = spawnSync(
    gitCommand,
    ['clone', '--branch', branch, '--single-branch', expectedUrl, temporary],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  if (clone.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    return gitFailure('clone_failed', clone);
  }
  try {
    const trackedEnv = git(temporary, gitCommand, [
      'ls-files',
      '--error-unmatch',
      '--',
      ':(icase).env.joripspace',
    ]);
    if (trackedEnv.status === 0) {
      return {
        status: 'protected_auth_file_tracked',
        repository,
        branch,
        protected_file: '.env.joripspace',
      };
    }
    const localGitignorePath = managedProjectFilePath(workspace, '.gitignore');
    const temporaryEntries = fs.readdirSync(temporary);
    const remoteGitignoreEntry = temporaryEntries.find((entry) => entry.toLowerCase() === '.gitignore');
    const remoteGitignorePath = remoteGitignoreEntry
      ? path.join(temporary, remoteGitignoreEntry)
      : path.join(temporary, '.gitignore');
    const localGitignore = fs.existsSync(localGitignorePath)
      ? fs.readFileSync(localGitignorePath, 'utf8')
      : '';
    const remoteGitignore = fs.existsSync(remoteGitignorePath)
      ? fs.readFileSync(remoteGitignorePath, 'utf8')
      : '';
    const localEntries = new Set(fs.readdirSync(workspace).map((entry) => entry.toLowerCase()));
    for (const entry of temporaryEntries) {
      const normalizedEntry = entry.toLowerCase();
      if (
        normalizedEntry === '.env.joripspace' ||
        normalizedEntry === '.gitignore' ||
        normalizedEntry === '.joripspace' ||
        ((normalizedEntry === 'agents.md' || normalizedEntry === 'claude.md') &&
          localEntries.has(normalizedEntry))
      ) {
        continue;
      }
      fs.cpSync(path.join(temporary, entry), path.join(workspace, entry), { recursive: true, force: true });
    }
    writeTextAtomically(localGitignorePath, mergeGitignoreSources(remoteGitignore, localGitignore));
    ensureProjectEnvIgnored(workspace);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { status: 'synchronized', operation: 'clone', repository, branch };
}

function validGitBranch(value) {
  if (
    !value ||
    value === '@' ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    value.includes('[') ||
    /[\x00-\x20\x7f~^:?*\\]/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some((part) => part.startsWith('.') || part.toLowerCase().endsWith('.lock'));
}

function git(workspace, gitCommand, args) {
  return spawnSync(gitCommand, ['-C', workspace, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function gitFailure(status, result) {
  return {
    status,
    error:
      redactGitDiagnostic(result.error?.message || String(result.stderr || result.stdout || '').trim()) ||
      'git command failed',
  };
}

function redactGitDiagnostic(value) {
  return String(value || '')
    .replace(/\b(https?|git|ssh):\/\/[^\s/@]+@/gi, '$1://')
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|token)=)[^&#\s]+/gi,
      '$1[redacted]'
    )
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[redacted]');
}

function mergeGitignoreSources(remoteSource, localSource) {
  const lines = [];
  const seen = new Set();
  for (const line of `${remoteSource || ''}\n${localSource || ''}`.split(/\r?\n/)) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function githubRepository(remote) {
  const value = String(remote || '')
    .trim()
    .replace(/\.git$/i, '');
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i.exec(value);
  return match ? match[1].toLowerCase() : '';
}

function resolveProjectRoot(cwd, gitCommand) {
  const directory = path.resolve(cwd);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`start cwd does not exist or is not a directory: ${directory}`);
  }
  const discovered = git(directory, gitCommand, ['rev-parse', '--show-toplevel']);
  const candidate = String(discovered.stdout || '').trim();
  if (discovered.status === 0 && candidate && !/[\r\n\0]/.test(candidate) && path.isAbsolute(candidate)) {
    try {
      const root = fs.realpathSync.native(path.resolve(candidate));
      const current = fs.realpathSync.native(directory);
      const relative = path.relative(root, current);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.statSync(root).isDirectory()) {
        return root;
      }
    } catch {}
  }
  return directory;
}

function readProjectMarker(workspace) {
  const markerPath = managedProjectFilePath(workspace, '.joripspace/project');
  if (!fs.existsSync(markerPath)) return '';
  return parseProjectMarker(fs.readFileSync(markerPath, 'utf8'));
}

function ensureProjectGuidance(workspace, projectSlug) {
  assertSafeProjectGuidance(workspace);
  const joripspaceDirectory = resolveProjectDirectoryTarget(workspace, '.joripspace').target;
  fs.mkdirSync(joripspaceDirectory, { recursive: true });
  const projectPath = managedProjectFilePath(workspace, '.joripspace/project');
  const currentProject = fs.existsSync(projectPath) ? fs.readFileSync(projectPath, 'utf8') : '';
  const nextProject = `${projectSlug}\n`;
  if (currentProject !== nextProject) writeTextAtomically(projectPath, nextProject);

  const agentsPath = managedProjectFilePath(workspace, 'AGENTS.md');
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const nextAgents = upsertStartAgentsBlock(currentAgents);
  if (nextAgents !== currentAgents) writeTextAtomically(agentsPath, nextAgents);

  const claudePath = managedProjectFilePath(workspace, 'CLAUDE.md');
  const currentClaude = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
  const nextClaude = upsertClaudeAgentsReference(currentClaude);
  if (nextClaude !== currentClaude) writeTextAtomically(claudePath, nextClaude);

  return {
    project: projectPath,
    agents: agentsPath,
    claude: claudePath,
    created: {
      project: currentProject !== nextProject,
      agents: nextAgents !== currentAgents,
      claude: nextClaude !== currentClaude,
    },
  };
}

function assertSafeProjectGuidance(workspace) {
  resolveProjectDirectoryTarget(workspace, '.joripspace');
  for (const relative of [
    '.env.joripspace',
    '.gitignore',
    'AGENTS.md',
    'CLAUDE.md',
    '.joripspace/project',
    '.joripspace/project.json',
    '.joripspace/agent-session.json',
    ...LEGACY_HELPER_FILES.map(([relative]) => relative),
  ]) {
    managedProjectFilePath(workspace, relative);
  }
}

function managedProjectFilePath(workspace, relative) {
  const location = resolveProjectFileTarget(workspace, relative);
  if (location.blockers.length) {
    throw new Error(`managed project file path is blocked: ${location.blockers.join(', ')}`);
  }
  return location.target;
}

function upsertStartAgentsBlock(source) {
  const block = [
    START_AGENTS_START,
    '',
    'Before working on this project, read `https://api.joripspace.com/onboarding.md`.',
    '',
    'The JoripSpace project is stored in `.joripspace/project`.',
    '',
    'Use JoripSpace MCP when it is available. Otherwise, use the installed JoripSpace CLI. Use only JoripSpace for hosting, infrastructure, domains, and deployment.',
    '',
    START_AGENTS_END,
  ].join('\n');
  let current = String(source || '').replace(/\r\n/g, '\n');
  const ranges = [
    [START_AGENTS_START, START_AGENTS_END],
    [LEGACY_AGENTS_START, LEGACY_AGENTS_END],
  ];
  for (const [startMarker, endMarker] of ranges) {
    while (current.includes(startMarker) || current.includes(endMarker)) {
      const start = current.indexOf(startMarker);
      const end = current.indexOf(endMarker, Math.max(0, start + startMarker.length));
      if (start < 0 || end < 0 || end < start) {
        throw startError(
          'invalid_agents_managed_block',
          'AGENTS.md contains an incomplete JoripSpace managed block'
        );
      }
      current = `${current.slice(0, start)}${current.slice(end + endMarker.length)}`;
    }
  }
  const unmanaged = current.replace(/^\n+/, '').replace(/\n+$/, '');
  return unmanaged ? `${block}\n\n${unmanaged}\n` : `${block}\n`;
}

function upsertClaudeAgentsReference(source) {
  const original = String(source || '');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? original.slice(1) : original;
  const newline = body.match(/\r\n|\n|\r/)?.[0] || '\n';
  const topReference = /^[ \t]*@AGENTS\.md[ \t]*(?:\r\n|\n|\r|$)/.test(body);
  let remainder = body.replace(/^[ \t]*@AGENTS\.md[ \t]*(?:\r\n|\n|\r|$)/gm, '');
  if (topReference) remainder = remainder.replace(/^(?:\r\n|\n|\r)/, '');
  return remainder ? `${bom}@AGENTS.md${newline}${newline}${remainder}` : `${bom}@AGENTS.md${newline}`;
}

function projectMatches(candidate, projectId) {
  const requested = String(projectId).toLowerCase();
  return [candidate?.name, candidate?.project_slug, candidate?.slug]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === requested);
}

function canonicalProjectSlug(candidate) {
  return String(candidate?.project_slug || candidate?.slug || '').trim();
}

function parseProjectMarker(source) {
  const value = String(source || '');
  if (!/^[^\r\n]+(?:\r?\n)?$/.test(value)) {
    throw startError(
      'invalid_project_marker',
      '.joripspace/project must contain exactly one project slug line'
    );
  }
  const slug = value.replace(/\r?\n$/, '');
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw startError('invalid_project_marker', '.joripspace/project must contain a canonical project slug');
  }
  return slug;
}

function inspectProjectWorkspace(workspace, projectSlug, options = {}) {
  const portablePaths = [
    'AGENTS.md',
    'CLAUDE.md',
    '.joripspace/project',
    '.joripspace/project.json',
    '.joripspace/agent-session.json',
    ...LEGACY_HELPER_FILES.map(([relative]) => relative),
  ];
  const casingConflicts = portablePaths.flatMap((relative) => portablePathConflicts(workspace, relative));
  if (casingConflicts.length) {
    return {
      ok: false,
      status: 'non_canonical_workspace_path',
      conflicts: casingConflicts,
      nextAction: 'rename-the-reported-paths-to-their-canonical-lowercase-or-uppercase-spelling',
    };
  }

  const marker = readProjectMarker(workspace);
  if (marker && marker !== projectSlug) {
    return {
      ok: false,
      status: 'project_conflict',
      existingProject: marker,
      nextAction: 'choose-a-folder-without-a-different-joripspace-project',
    };
  }

  const legacyProjectPath = managedProjectFilePath(workspace, '.joripspace/project.json');
  let legacyProject = null;
  let legacyProjectSnapshot = null;
  if (fs.existsSync(legacyProjectPath)) {
    legacyProjectSnapshot = readMigrationSnapshot(legacyProjectPath);
    legacyProject = parseJsonForMigration(
      legacyProjectSnapshot.source.toString('utf8'),
      legacyProjectPath,
      'legacy project configuration'
    );
    const legacySlug = String(legacyProject.project_slug || legacyProject.project_id || '').trim();
    if (!PROJECT_SLUG_PATTERN.test(legacySlug)) {
      return {
        ok: false,
        status: 'legacy_workspace_migration_blocked',
        conflicts: ['.joripspace/project.json has no canonical project slug'],
        nextAction: 'repair-or-remove-the-invalid-legacy-project-file',
      };
    }
    if (legacySlug !== projectSlug) {
      return {
        ok: false,
        status: 'project_conflict',
        existingProject: legacySlug,
        nextAction: 'choose-a-folder-without-a-different-joripspace-project',
      };
    }
    const legacyProjectConflicts = validateGeneratedLegacyProject(legacyProject);
    if (legacyProjectConflicts.length) {
      return {
        ok: false,
        status: 'legacy_workspace_migration_blocked',
        conflicts: legacyProjectConflicts,
        nextAction: 'preserve-and-review-the-nonstandard-legacy-project-file',
      };
    }
  }

  const sessionPath = managedProjectFilePath(workspace, '.joripspace/agent-session.json');
  let legacySession = null;
  let legacySessionSnapshot = null;
  if (fs.existsSync(sessionPath)) {
    legacySessionSnapshot = readMigrationSnapshot(sessionPath);
    legacySession = parseJsonForMigration(
      legacySessionSnapshot.source.toString('utf8'),
      sessionPath,
      'legacy agent session'
    );
    const sessionValidation = validateGeneratedLegacySession(legacySession);
    if (!sessionValidation.ok) {
      return {
        ok: false,
        status: 'legacy_workspace_migration_blocked',
        conflicts: sessionValidation.conflicts,
        nextAction: 'preserve-and-review-the-nonstandard-legacy-agent-session',
      };
    }
    if (sessionValidation.connection && !options.allowLegacyCredentialSession) {
      return {
        ok: false,
        status: 'legacy_workspace_migration_blocked',
        conflicts: ['.joripspace/agent-session.json still contains credential values'],
        nextAction: 'run-login-to-migrate-the-legacy-token-before-starting-again',
      };
    }
    const sessionProject = legacySession.project || {};
    const sessionSlug = String(
      sessionProject.slug || legacySession.project_slug || legacySession.project_id || sessionProject.id || ''
    ).trim();
    if (sessionSlug && sessionSlug !== projectSlug) {
      return {
        ok: false,
        status: 'project_conflict',
        existingProject: sessionSlug,
        nextAction: 'choose-a-folder-without-a-different-joripspace-project',
      };
    }
  }

  const legacyConfig = legacyProject || { project_id: projectSlug, project_slug: projectSlug };
  const helperCleanup = inspectLegacyHelpers(workspace, legacyConfig);
  if (helperCleanup.conflicts.length) {
    return {
      ok: false,
      status: 'legacy_workspace_migration_blocked',
      conflicts: helperCleanup.conflicts,
      nextAction: 'review-modified-legacy-helper-files-before-running-start-again',
    };
  }
  const hasLegacyArtifacts = Boolean(legacyProject || legacySession || helperCleanup.snapshots.length);
  const packageCleanup = hasLegacyArtifacts ? inspectLegacyPackageScripts(workspace) : null;
  if (packageCleanup?.conflicts.length) {
    return {
      ok: false,
      status: 'legacy_workspace_migration_blocked',
      conflicts: packageCleanup.conflicts,
      nextAction: 'review-modified-legacy-package-scripts-before-running-start-again',
    };
  }
  return {
    ok: true,
    marker,
    legacyProjectPath: legacyProject ? legacyProjectPath : null,
    legacySessionPath: legacySession ? sessionPath : null,
    helperPaths: helperCleanup.snapshots.map((snapshot) => snapshot.path),
    packageCleanup,
    cleanupSnapshots: [
      legacyProject ? legacyProjectSnapshot : null,
      legacySession ? legacySessionSnapshot : null,
      ...helperCleanup.snapshots,
    ].filter(Boolean),
    onlyManagedFiles: workspaceContainsOnlyManagedFiles(workspace),
  };
}

function validateGeneratedLegacyProject(project) {
  const unknownKeys = Object.keys(project).filter((key) => !LEGACY_PROJECT_KEYS.has(key));
  if (unknownKeys.length) {
    return unknownKeys.map((key) => `.joripspace/project.json contains an unknown field: ${key}`);
  }
  const conflicts = [];
  if (project.onboarding_schema_version !== 9) {
    conflicts.push('.joripspace/project.json is not a generated schema version 9 file');
  }
  for (const key of ['agent_guide_updated_at', 'project_id', 'project_slug', 'api_base_url']) {
    if (typeof project[key] !== 'string' || !project[key].trim()) {
      conflicts.push(`.joripspace/project.json field ${key} is invalid`);
    }
  }
  if (project.project_id !== project.project_slug) {
    conflicts.push('.joripspace/project.json project_id and project_slug do not match');
  }
  for (const key of ['deployment_policy', 'deployment']) {
    if (!project[key] || typeof project[key] !== 'object' || Array.isArray(project[key])) {
      conflicts.push(`.joripspace/project.json field ${key} is invalid`);
    }
  }
  if (project.deployment_policy && typeof project.deployment_policy === 'object') {
    const expectedPolicy = loadCoreOnboardingPackage().JORIPSPACE_WORKFLOW_POLICY;
    if (!deepEqualJson(project.deployment_policy, expectedPolicy)) {
      conflicts.push('.joripspace/project.json deployment_policy differs from the generated policy');
    }
  }
  if (project.deployment && typeof project.deployment === 'object') {
    const deploymentUnknown = Object.keys(project.deployment).filter(
      (key) => !LEGACY_DEPLOYMENT_KEYS.has(key)
    );
    conflicts.push(
      ...deploymentUnknown.map(
        (key) => `.joripspace/project.json deployment contains an unknown field: ${key}`
      )
    );
    if (!['direct', 'github_actions'].includes(project.deployment.mode)) {
      conflicts.push('.joripspace/project.json deployment mode is invalid');
    }
    if (
      project.deployment.connection_status !== undefined &&
      typeof project.deployment.connection_status !== 'string'
    ) {
      conflicts.push('.joripspace/project.json deployment connection_status is invalid');
    }
    if (project.deployment.connections !== undefined) {
      if (!Array.isArray(project.deployment.connections)) {
        conflicts.push('.joripspace/project.json deployment connections is invalid');
      } else {
        for (const [index, connection] of project.deployment.connections.entries()) {
          if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
            conflicts.push(`.joripspace/project.json deployment connection ${index} is invalid`);
            continue;
          }
          const unknown = Object.keys(connection).filter(
            (key) => !LEGACY_DEPLOYMENT_CONNECTION_KEYS.has(key)
          );
          conflicts.push(
            ...unknown.map(
              (key) =>
                `.joripspace/project.json deployment connection ${index} contains an unknown field: ${key}`
            )
          );
        }
      }
    }
  }
  for (const key of ['default_url', 'mcp_url']) {
    if (project[key] !== undefined && project[key] !== null && typeof project[key] !== 'string') {
      conflicts.push(`.joripspace/project.json field ${key} is invalid`);
    }
  }
  try {
    const apiUrl = new URL(project.api_base_url);
    if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
      conflicts.push('.joripspace/project.json api_base_url is invalid');
    }
  } catch {
    conflicts.push('.joripspace/project.json api_base_url is invalid');
  }
  return [...new Set(conflicts)];
}

function validateGeneratedLegacySession(session) {
  if (containsCredentialValue(session)) {
    try {
      const connection = legacyCredentialSessionConnection(session);
      return connection
        ? { ok: true, connection, conflicts: [] }
        : {
            ok: false,
            connection: null,
            conflicts: ['.joripspace/agent-session.json has an unsupported credential schema'],
          };
    } catch (error) {
      return { ok: false, connection: null, conflicts: [error.message] };
    }
  }
  const topKeys = ['schema_version', 'scope', 'project', 'agent_guide', 'collaboration', 'local_auth'];
  if (!hasExactObjectKeys(session, topKeys)) {
    return {
      ok: false,
      connection: null,
      conflicts: ['.joripspace/agent-session.json is not a generated shared-workspace session'],
    };
  }
  const valid =
    session.schema_version === 2 &&
    session.scope === 'shared_workspace' &&
    hasExactObjectKeys(session.project, ['id', 'slug', 'config_file']) &&
    typeof session.project.id === 'string' &&
    typeof session.project.slug === 'string' &&
    ['.joripspace/project', '.joripspace/project.json'].includes(session.project.config_file) &&
    hasExactObjectKeys(session.agent_guide, ['updated_at']) &&
    typeof session.agent_guide.updated_at === 'string' &&
    hasExactObjectKeys(session.collaboration, ['git_tracked']) &&
    session.collaboration.git_tracked === true &&
    hasExactObjectKeys(session.local_auth, [
      'env_file',
      'required_environment',
      'credential_values_in_session',
    ]) &&
    session.local_auth.env_file === '.env.joripspace' &&
    Array.isArray(session.local_auth.required_environment) &&
    session.local_auth.required_environment.length === 1 &&
    session.local_auth.required_environment[0] === 'JORIPSPACE_API_TOKEN' &&
    session.local_auth.credential_values_in_session === false;
  return valid
    ? { ok: true, connection: null, conflicts: [] }
    : {
        ok: false,
        connection: null,
        conflicts: ['.joripspace/agent-session.json has an unsupported generated shape'],
      };
}

function legacyCredentialSessionConnection(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const apiToken = typeof session.api_token === 'string' ? session.api_token.trim() : '';
  const connectToken = typeof session.connect_token === 'string' ? session.connect_token.trim() : '';
  if (!apiToken && !connectToken) return null;
  const unknown = Object.keys(session).filter((key) => !LEGACY_CREDENTIAL_SESSION_KEYS.has(key));
  if (unknown.length) {
    throw startError(
      'legacy_workspace_migration_blocked',
      `.joripspace/agent-session.json contains an unknown field: ${unknown[0]}`
    );
  }
  if (apiToken && connectToken && apiToken !== connectToken) {
    throw startError(
      'legacy_workspace_migration_blocked',
      '.joripspace/agent-session.json contains conflicting connection tokens'
    );
  }
  if (
    typeof session.api_base_url !== 'string' ||
    !session.api_base_url.trim() ||
    (session.source !== undefined && session.source !== 'cli-login') ||
    (session.updated_at !== undefined && typeof session.updated_at !== 'string') ||
    typeof session.guide_checked_at !== 'string' ||
    !hasExactObjectKeys(session.account, ['account_id']) ||
    typeof session.account.account_id !== 'string' ||
    (session.global_session_file !== undefined &&
      session.global_session_file !== null &&
      typeof session.global_session_file !== 'string')
  ) {
    throw startError(
      'legacy_workspace_migration_blocked',
      '.joripspace/agent-session.json has an unsupported credential schema'
    );
  }
  let apiUrl;
  try {
    apiUrl = new URL(session.api_base_url);
  } catch {
    apiUrl = null;
  }
  if (!apiUrl || !['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw startError(
      'legacy_workspace_migration_blocked',
      '.joripspace/agent-session.json api_base_url is invalid'
    );
  }
  return {
    apiToken: apiToken || connectToken,
    apiBaseUrl: apiUrl.href.replace(/\/+$/, ''),
    accountId: session.account.account_id.trim(),
  };
}

function hasExactObjectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function deepEqualJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqualJson(left[key], right[key]))
  );
}

function migrateProjectWorkspace(workspace, projectSlug, state, options = {}) {
  for (const snapshot of state.cleanupSnapshots || []) assertMigrationSnapshotUnchanged(snapshot);
  const persistentSnapshots = [
    ...(state.packageCleanup?.changed ? [state.packageCleanup.snapshot] : []),
    ...(state.cleanupSnapshots || []).filter(
      (snapshot) => path.basename(snapshot.path).toLowerCase() !== 'agent-session.json'
    ),
  ];
  const backupRoot = persistentSnapshots.length
    ? createExternalBackupRoot(workspace, 'legacy-migration', options.dataDir)
    : null;
  if (backupRoot) {
    const backupDevice = fs.statSync(backupRoot).dev;
    for (const snapshot of persistentSnapshots) {
      if (fs.lstatSync(snapshot.path).dev !== backupDevice) {
        throw startError(
          'legacy_workspace_migration_blocked',
          'legacy migration backup must be on the same filesystem as the project'
        );
      }
    }
  }
  if (state.packageCleanup?.changed) {
    replaceMigrationSnapshotAtomically(
      workspace,
      state.packageCleanup.snapshot,
      `${JSON.stringify(state.packageCleanup.value, null, 2)}\n`,
      backupRoot,
      options.afterLegacyPathQuarantined
    );
  }
  for (const snapshot of state.cleanupSnapshots || []) {
    if (path.basename(snapshot.path).toLowerCase() === 'agent-session.json') {
      removeMigrationSnapshotAtomically(snapshot, options.afterLegacyPathQuarantined);
    } else {
      backupMigrationSnapshotAtomically(
        workspace,
        snapshot,
        backupRoot,
        options.afterLegacyPathQuarantined,
        'remove'
      );
    }
  }
  if (state.legacySessionPath) {
    removeGitignoreEntries(workspace, ['.joripspace/agent-session.json']);
  }
  ensureProjectGuidance(workspace, projectSlug);
  return { backupRoot };
}

function inspectLegacyHelpers(workspace, projectConfig) {
  const core = loadCoreOnboardingPackage();
  const snapshots = [];
  const conflicts = [];
  for (const [relative, generatorName] of LEGACY_HELPER_FILES) {
    const filePath = managedProjectFilePath(workspace, relative);
    if (!fs.existsSync(filePath)) continue;
    const generator = core[generatorName];
    const expected =
      typeof generator === 'function'
        ? generatorName === 'projectGithubActionsTemplateFile'
          ? generator(projectConfig)
          : generator()
        : null;
    const snapshot = readMigrationSnapshot(filePath);
    const current = snapshot.source.toString('utf8');
    if (
      (typeof expected !== 'string' || current !== expected) &&
      !looksLikeGeneratedLegacyHelper(relative, current, expected)
    ) {
      conflicts.push(`${relative} differs from the generated JoripSpace helper`);
      continue;
    }
    snapshots.push(snapshot);
  }
  return { conflicts, snapshots };
}

function looksLikeGeneratedLegacyHelper(relative, source, expected) {
  const value = String(source || '');
  const legacyHash = LEGACY_HELPER_SHA256[relative];
  if (legacyHash && crypto.createHash('sha256').update(value).digest('hex') === legacyHash) return true;
  if (relative !== '.joripspace/github-actions-template.yml' || typeof expected !== 'string') return false;
  return value === expected.replaceAll('.joripspace/deploy.json', '.joripspace/project.json');
}

function inspectLegacyPackageScripts(workspace) {
  const packagePath = managedProjectFilePath(workspace, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return { changed: false, conflicts: [], path: packagePath, snapshot: null, value: null };
  }
  const snapshot = readMigrationSnapshot(packagePath);
  const value = parseJsonForMigration(snapshot.source.toString('utf8'), packagePath, 'package.json');
  const expectedScripts = loadCoreOnboardingPackage().projectPackageHelperScripts();
  const scripts =
    value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)
      ? { ...value.scripts }
      : {};
  const conflicts = [];
  let changed = false;
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (scripts[name] === undefined) continue;
    if (scripts[name] !== expected) {
      if (String(scripts[name]).includes('.joripspace/')) {
        conflicts.push(`package.json script ${name} differs from the generated JoripSpace command`);
      }
      continue;
    }
    delete scripts[name];
    changed = true;
  }
  return {
    changed,
    conflicts,
    path: packagePath,
    snapshot,
    value: changed ? { ...value, scripts } : value,
  };
}

function parseJsonForMigration(source, filePath, label) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw startError('legacy_workspace_migration_blocked', `${label} is not valid JSON: ${filePath}`);
  }
}

function readMigrationSnapshot(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw startError(
      'legacy_workspace_changed_during_migration',
      `legacy migration target is not a regular file: ${filePath}`
    );
  }
  const source = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw startError(
      'legacy_workspace_changed_during_migration',
      `legacy migration target changed while it was being validated: ${filePath}`
    );
  }
  return { path: filePath, source, mode: before.mode };
}

function assertMigrationSnapshotUnchanged(snapshot) {
  if (!snapshot) return;
  let current;
  try {
    current = readMigrationSnapshot(snapshot.path);
  } catch {
    throw startError(
      'legacy_workspace_changed_during_migration',
      `legacy migration target changed after validation: ${snapshot.path}`
    );
  }
  if (!current.source.equals(snapshot.source)) {
    throw startError(
      'legacy_workspace_changed_during_migration',
      `legacy migration target changed after validation: ${snapshot.path}`
    );
  }
}

function quarantineMigrationSnapshot(snapshot, callback, operation) {
  assertMigrationSnapshotUnchanged(snapshot);
  const quarantinePath = `${snapshot.path}.joripspace-migrate-${process.pid}-${crypto.randomUUID()}`;
  fs.renameSync(snapshot.path, quarantinePath);
  try {
    callback?.({ path: snapshot.path, quarantinePath, operation });
    const quarantined = readMigrationSnapshot(quarantinePath);
    if (!quarantined.source.equals(snapshot.source)) {
      throw startError(
        'legacy_workspace_changed_during_migration',
        `legacy migration target changed after it was quarantined: ${snapshot.path}`
      );
    }
    if (fs.existsSync(snapshot.path)) {
      fs.rmSync(quarantinePath, { force: true });
      throw startError(
        'legacy_workspace_changed_during_migration',
        `legacy migration target was recreated during migration: ${snapshot.path}`
      );
    }
    return quarantinePath;
  } catch (error) {
    restoreMigrationSnapshotWithoutOverwrite(quarantinePath, snapshot.path, true);
    throw error;
  }
}

function backupMigrationSnapshotAtomically(workspace, snapshot, backupRoot, callback, operation) {
  if (!backupRoot) {
    throw startError('legacy_workspace_migration_blocked', 'legacy migration backup is unavailable');
  }
  assertMigrationSnapshotUnchanged(snapshot);
  // Managed file snapshots already use real paths. Resolve the workspace too so
  // macOS /var aliases and Windows short paths refer to the same project root.
  const relative = path.relative(fs.realpathSync.native(workspace), snapshot.path);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw startError('legacy_workspace_migration_blocked', 'legacy migration target is outside the project');
  }
  const backupPath = path.join(backupRoot, 'live', relative);
  const frozenPath = path.join(backupRoot, 'frozen', relative);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(frozenPath), { recursive: true, mode: 0o700 });
  writeBufferExclusively(frozenPath, snapshot.source, snapshot.mode);
  fs.renameSync(snapshot.path, backupPath);
  try {
    callback?.({ path: snapshot.path, quarantinePath: backupPath, operation });
    const backedUp = readMigrationSnapshot(backupPath);
    if (!backedUp.source.equals(snapshot.source)) {
      throw startError(
        'legacy_workspace_changed_during_migration',
        `legacy migration target changed after it was backed up: ${snapshot.path}`
      );
    }
    if (fs.existsSync(snapshot.path)) {
      throw startError(
        'legacy_workspace_changed_during_migration',
        `legacy migration target was recreated during migration: ${snapshot.path}`
      );
    }
    return backupPath;
  } catch (error) {
    restoreMigrationSnapshotWithoutOverwrite(backupPath, snapshot.path);
    throw error;
  }
}

function writeBufferExclusively(filePath, source, mode) {
  const descriptor = fs.openSync(filePath, 'wx', mode & 0o777);
  try {
    fs.writeFileSync(descriptor, source);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreMigrationSnapshotWithoutOverwrite(backupPath, originalPath, removeBackup = false) {
  if (!fs.existsSync(backupPath)) return false;
  try {
    fs.linkSync(backupPath, originalPath);
    if (removeBackup) fs.rmSync(backupPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeMigrationSnapshotAtomically(snapshot, callback) {
  const quarantinePath = quarantineMigrationSnapshot(snapshot, callback, 'remove');
  fs.rmSync(quarantinePath, { force: true });
}

function replaceMigrationSnapshotAtomically(workspace, snapshot, source, backupRoot, callback) {
  const quarantinePath = backupMigrationSnapshotAtomically(
    workspace,
    snapshot,
    backupRoot,
    callback,
    'replace'
  );
  const temporaryPath = `${snapshot.path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let linked = false;
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', snapshot.mode & 0o777);
    try {
      fs.writeFileSync(descriptor, source, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.linkSync(temporaryPath, snapshot.path);
    linked = true;
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (!linked) restoreMigrationSnapshotWithoutOverwrite(quarantinePath, snapshot.path);
    throw startError(
      'legacy_workspace_changed_during_migration',
      `legacy migration target could not be replaced without overwriting a concurrent edit: ${snapshot.path}`
    );
  }
}

function containsCredentialValue(value, key = '') {
  if (Array.isArray(value)) return value.some((entry) => containsCredentialValue(entry, key));
  if (!value || typeof value !== 'object') {
    return (
      /^(?:api_token|connect_token|access_token|refresh_token|password|secret)$/i.test(key) &&
      value !== undefined &&
      value !== null &&
      value !== '' &&
      value !== false
    );
  }
  return Object.entries(value).some(([nestedKey, nested]) => containsCredentialValue(nested, nestedKey));
}

function portablePathConflicts(workspace, relative) {
  const canonical = relative.replace(/\\/g, '/');
  const matches = findPortablePathMatches(workspace, canonical);
  if (matches.length === 0) return [];
  if (matches.length > 1) return matches.map((match) => `${canonical} conflicts with ${match.relative}`);
  return matches[0].relative === canonical
    ? []
    : [`${canonical} uses non-canonical casing ${matches[0].relative}`];
}

function findPortablePathMatches(workspace, relative) {
  let candidates = [{ fullPath: path.resolve(workspace), parts: [] }];
  for (const expectedPart of relative.split('/')) {
    const next = [];
    for (const candidate of candidates) {
      let entries = [];
      try {
        entries = fs.readdirSync(candidate.fullPath, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.toLowerCase() !== expectedPart.toLowerCase()) continue;
        const fullPath = path.join(candidate.fullPath, entry.name);
        if (fs.lstatSync(fullPath).isSymbolicLink()) {
          throw new Error(
            `project path contains a symbolic link or junction: ${[...candidate.parts, entry.name].join('/')}`
          );
        }
        next.push({ fullPath, parts: [...candidate.parts, entry.name] });
      }
    }
    candidates = next;
  }
  return candidates.map((candidate) => ({
    fullPath: candidate.fullPath,
    relative: candidate.parts.join('/'),
  }));
}

function workspaceContainsOnlyManagedFiles(workspace) {
  const allowedTopLevel = new Set(['.env.joripspace', '.gitignore', 'agents.md', 'claude.md']);
  const allowedJoripspace = new Set([
    'project',
    'project.json',
    'agent-session.json',
    ...LEGACY_HELPER_FILES.map(([relative]) => relative.split('/').at(-1).toLowerCase()),
  ]);
  for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
    const normalized = entry.name.toLowerCase();
    if (allowedTopLevel.has(normalized)) continue;
    if (normalized !== '.joripspace' || !entry.isDirectory()) return false;
    for (const nested of fs.readdirSync(path.join(workspace, entry.name), { withFileTypes: true })) {
      if (!nested.isFile() || !allowedJoripspace.has(nested.name.toLowerCase())) return false;
    }
  }
  return true;
}

function workspaceHasApplicationFiles(workspace) {
  const ignored = new Set(['.git', '.gitignore', '.env.joripspace', '.joripspace', 'agents.md', 'claude.md']);
  return fs.readdirSync(workspace).some((entry) => !ignored.has(entry.toLowerCase()));
}

function isManagedGitStatusLine(line) {
  const source = String(line || '');
  if (source.length < 4 || source[2] !== ' ') return false;
  const paths = source
    .slice(3)
    .split(' -> ')
    .map((value) => value.replace(/^"|"$/g, '').replace(/\\/g, '/').toLowerCase());
  const managed = new Set([
    ...START_MANAGED_PATHS,
    '.joripspace/project.json',
    '.joripspace/agent-session.json',
    ...LEGACY_HELPER_FILES.map(([relative]) => relative.toLowerCase()),
  ]);
  return paths.every((relative) => managed.has(relative));
}

function normalizedDescription(value) {
  const description = typeof value === 'string' ? value.trim() : '';
  return description || null;
}

function loadCoreOnboardingPackage() {
  return require('../vendor/core/onboarding.cjs');
}

function startError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function writeTextAtomically(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${filePath}.bak-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, source, 'utf8');
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
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

module.exports = {
  START_AGENTS_END,
  START_AGENTS_START,
  ensureProjectGuidance,
  legacyCredentialSessionConnection,
  readProjectMarker,
  redactGitDiagnostic,
  resolveProjectRoot,
  syncConnectedGithubRepository,
  startProject,
  upsertClaudeAgentsReference,
  upsertStartAgentsBlock,
  validGitBranch,
};
