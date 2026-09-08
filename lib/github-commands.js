const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildGithubWorkflow } = require('../vendor/core/onboarding.cjs');
const { resolveProjectFileTarget } = require('./project-paths');

function createGithubCommands({ apiRequest, output, projectAuth, projectWorkspaceDir, requireProjectId, stringFlag, writeTextAtomically }) {
  return async function githubCommand(rest, flags) {
    const subcommand = rest[0] || '';
    if (subcommand !== 'prepare') throw new Error('github command requires: prepare');
    if (rest.length > 1) throw new Error('github prepare accepts no positional arguments');

    const project = requireProjectId(flags);
    const workspace = projectWorkspaceDir(flags);
    const details = await apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}`, {
      method: 'GET',
      ...projectAuth(flags),
    });
    const deployment = details?.deployment;
    if (!deployment || deployment.mode !== 'github_actions') {
      throw commandError('github_connection_required', '이 프로젝트에는 GitHub 저장소가 연결되어 있지 않습니다.');
    }
    const repository = String(deployment.repository || '').trim();
    const branch = String(deployment.branch || '').trim();
    const connectionId = String(deployment.connection_id || '').trim();
    const workflowPath = String(deployment.workflow_path || '').trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw commandError('github_repository_invalid', '연결된 GitHub 저장소 정보가 올바르지 않습니다.');
    }
    if (!validGitBranch(branch) || !connectionId || !/^\.github\/workflows\/joripspace-[a-z0-9_-]+\.ya?ml$/u.test(workflowPath)) {
      throw commandError('github_connection_invalid', '연결된 GitHub 배포 설정이 올바르지 않습니다.');
    }
    assertMatchingGitWorkspace(workspace, repository, branch);

    const workflowConfig = inferWorkflowConfig(workspace, flags, stringFlag);
    const workflow = buildGithubWorkflow({
      projectId: details.project_slug || details.project_id || project,
      branch,
      triggerType: deployment.trigger_type || 'branch',
      triggerRef: deployment.trigger_ref || branch,
      connectionId,
      ...workflowConfig,
    });
    const workflowTarget = resolveProjectFileTarget(workspace, workflowPath);
    if (workflowTarget.blockers.length) {
      throw commandError('github_workflow_path_invalid', `workflow 경로가 파일에 막혀 있습니다: ${workflowPath}`);
    }
    const target = workflowTarget.target;
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf8');
      const connectionMarker = `JORIPSPACE_CONNECTION_ID: ${JSON.stringify(connectionId)}`;
      if (!existing.startsWith('# joripspace-workflow-version: ') || !existing.includes(connectionMarker)) {
        throw commandError('github_workflow_conflict', `기존 workflow를 덮어쓰지 않았습니다: ${workflowPath}`);
      }
    }
    writeTextAtomically(target, workflow);
    output(flags, {
      status: 'prepared',
      project: details.project_slug || details.project_id || project,
      repository,
      branch,
      workflow_path: workflowPath,
      entrypoint: workflowConfig.entrypoint,
    }, (value) => {
      console.log(`GitHub workflow prepared: ${value.workflow_path}`);
      console.log(`Repository: ${value.repository}`);
      console.log(`Branch: ${value.branch}`);
      console.log(`Entrypoint: ${value.entrypoint}`);
    });
  };
}

function inferWorkflowConfig(workspace, flags, stringFlag) {
  const packageJson = readJson(path.join(workspace, 'package.json'));
  const deployConfig = readJson(path.join(workspace, '.joripspace', 'deploy.json'));
  const wranglerToml = readText(path.join(workspace, 'wrangler.toml'));
  const wranglerJson = readText(
    fs.existsSync(path.join(workspace, 'wrangler.jsonc'))
      ? path.join(workspace, 'wrangler.jsonc')
      : path.join(workspace, 'wrangler.json')
  );
  const explicitEntrypoint = stringFlag(flags, 'entrypoint');
  const configuredEntrypoint =
    explicitEntrypoint ||
    (typeof deployConfig.entrypoint === 'string' ? deployConfig.entrypoint : '') ||
    wranglerToml.match(/^\s*main\s*=\s*["']([^"']+)["']/mu)?.[1] ||
    wranglerJson.match(/["']main["']\s*:\s*["']([^"']+)["']/u)?.[1] ||
    (typeof packageJson.main === 'string' ? packageJson.main : '');
  const candidates = [
    configuredEntrypoint,
    'worker.js',
    'src/index.js',
    'src/index.ts',
    'src/worker.js',
    'src/worker.ts',
    'server.js',
  ].filter(Boolean);
  let entrypoint = '';
  for (const candidate of candidates) {
    const normalized = String(candidate).replace(/^\.\//u, '').replace(/\\/g, '/');
    let location;
    try {
      location = resolveProjectFileTarget(workspace, normalized);
    } catch (error) {
      if (candidate === configuredEntrypoint) throw error;
      continue;
    }
    if (location.blockers.length === 0 && fs.existsSync(location.target)) {
      entrypoint = location.relative;
      break;
    }
  }
  if (!entrypoint) {
    throw commandError(
      'github_entrypoint_not_detected',
      'Worker 시작 파일을 찾지 못했습니다. 소스를 작성하거나 --entrypoint를 지정한 뒤 다시 실행해 주세요.'
    );
  }
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const buildCommand = [
    ...(typeof scripts.build === 'string'
      ? ['if [ -f package-lock.json ]; then npm ci; else npm install; fi', 'npm run build']
      : []),
    'rm -rf .joripspace-artifact',
    'mkdir -p .joripspace-artifact',
    "while IFS= read -r -d '' file; do",
    '  if [ -f .joripspaceignore ] && git -c core.excludesFile="$PWD/.joripspaceignore" check-ignore --no-index -q -- "$file"; then',
    '    continue',
    '  fi',
    '  target=".joripspace-artifact/${file#./}"',
    '  mkdir -p "$(dirname "$target")"',
    '  cp "$file" "$target"',
    "done < <(find . \\\n  \\( -path './.git' -o -path './node_modules' -o -path './.wrangler' -o -path './.cache' -o -path './coverage' -o -path './.github' -o -path './.joripspace' -o -path './.joripspace-artifact' -o -path '*/test' -o -path '*/tests' -o -path '*/__tests__' -o -path './docs' \\) -prune -o \\\n  -type f ! -name '.env' ! -name '.env.*' ! -name '.dev.vars' ! -name '*.pem' ! -name '*.key' ! -name '*.test.*' ! -name '*.spec.*' ! -name 'AGENTS.md' ! -name 'CLAUDE.md' ! -name 'README*' ! -name 'LICENSE*' ! -name 'package.json' ! -name 'package-lock.json' ! -name 'npm-shrinkwrap.json' ! -name 'wrangler.toml' ! -name 'wrangler.json' ! -name 'wrangler.jsonc' ! -name 'tsconfig*.json' ! -name '.joripspaceignore' ! -name 'joripspace-template.json' -print0)",
  ].join('\n');
  return { entrypoint, artifactPath: '.joripspace-artifact', buildCommand };
}

function assertMatchingGitWorkspace(workspace, repository, branch) {
  const inside = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw commandError('github_workspace_required', '먼저 joripspace start를 실행해 연결된 GitHub 작업 폴더를 준비해 주세요.');
  }
  const remote = git(workspace, ['remote', 'get-url', 'origin']);
  if (remote.status !== 0 || githubRepository(remote.stdout.trim()) !== repository.toLowerCase()) {
    throw commandError('github_repository_mismatch', '현재 작업 폴더의 origin이 연결된 GitHub 저장소와 다릅니다.');
  }
  const currentBranch = git(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (currentBranch.status !== 0 || currentBranch.stdout.trim() !== branch) {
    throw commandError('github_branch_mismatch', `현재 작업 브랜치가 연결된 ${branch} 브랜치와 다릅니다.`);
  }
}

function git(workspace, args) {
  return spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
}

function githubRepository(remote) {
  const value = String(remote || '').trim().replace(/\.git$/iu, '');
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/iu.exec(value);
  return match ? match[1].toLowerCase() : '';
}

function validGitBranch(value) {
  return Boolean(value) && value !== '@' && !value.startsWith('-') && !/[\x00-\x20\x7f~^:?*\\]/u.test(value) && !value.includes('..') && !value.includes('@{');
}

function readJson(filePath) {
  const source = readText(filePath);
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    return {};
  }
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function commandError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createGithubCommands, inferWorkflowConfig };
