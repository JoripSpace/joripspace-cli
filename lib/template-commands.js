const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

function createTemplateCommands(deps) {
  async function list(flags) {
    const body = {
      templates: deps.listTemplates().map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        entrypoint: template.entrypoint,
        tags: template.tags ?? [],
        variables: template.variables ?? [],
      })),
    };
    deps.output(flags, body, (value) => {
      for (const template of value.templates)
        console.log(`${template.id}\t${template.name}\t${template.description}`);
    });
  }

  async function marketplaceList(flags) {
    const project = deps.requireProjectId(flags);
    const cursor = deps.stringFlag(flags, 'cursor');
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await deps.apiRequest(flags, `/v1/templates${query}`, {
      method: 'GET',
      ...deps.projectAuth(flags),
    });
    const body = { ...response, project_id: project };
    deps.output(flags, body, (value) => {
      for (const template of value.templates || []) {
        const name = template.name || template.title || template.slug || template.template_id;
        const slug = template.slug || template.template_id || template.id;
        console.log(`${slug}\t${name}\t${template.description || ''}`);
      }
      if (value.next_cursor || value.cursor) console.log(`Next cursor: ${value.next_cursor || value.cursor}`);
    });
  }

  async function deploy(flags) {
    const project = deps.requireProjectId(flags);
    const templateId = deps.stringFlag(flags, 'template');
    if (!templateId) throw new Error('deploy-template requires --template');
    const label = deps.stringFlag(flags, 'label').trim();
    if (!label) throw new Error('deploy-template requires --label');
    const { manifest, deployRequest } = deps.buildTemplateDeployRequest(templateId, deps.templateVars(flags));
    const body = await deps.apiRequest(flags, `/v1/projects/${encodeURIComponent(project)}/deploy`, {
      method: 'POST',
      ...deps.projectAuth(flags),
      body: { ...deployRequest, label },
    });
    deps.output(flags, { ...body, template_id: manifest.id }, (value) => {
      console.log(`Template: ${value.template_id}`);
      console.log(`Deployment: ${value.deployment_id}`);
      console.log(`Status: ${value.status}`);
      console.log(`URL: ${value.url}`);
    });
  }

  async function install(flags) {
    const project = deps.requireProjectId(flags);
    const templateSlug = deps.stringFlag(flags, 'template');
    if (!templateSlug) throw new Error('install-template requires --template');
    const targetDir = path.resolve(deps.stringFlag(flags, 'dir') || process.cwd());
    const connection = deps.resolveConnection(flags);
    const apiToken = deps.requireApiToken(flags, connection);
    const apiUrl = connection.apiBaseUrl;
    const filesOnly = deps.booleanFlag(flags, 'files-only');
    const headers = { Authorization: `Bearer ${apiToken}`, 'X-Joripspace-Session-Context': 'cli' };
    const claim = await timedFetch(`${apiUrl}/v1/templates/${encodeURIComponent(templateSlug)}/claim`, {
      method: 'POST',
      headers,
    });
    if (!claim.ok && ![404, 409].includes(claim.status)) throw await fetchError(claim);
    const granted = filesOnly ? null : await downloadBundleGrant(apiUrl, headers, templateSlug, project);
    if (granted) {
      const result = applyGitBundle(targetDir, templateSlug, granted.bundle, granted.metadata, false);
      let deployment = null;
      if (deps.booleanFlag(flags, 'deploy')) {
        const entrypoint = deps.stringFlag(flags, 'entrypoint');
        if (!entrypoint) throw new Error('template manifest has no entrypoint. Pass --entrypoint to deploy.');
        deployment = await deps.deployCode(
          {
            ...flags,
            dir: targetDir,
            entrypoint,
            label: deps.stringFlag(flags, 'label') || `템플릿 ${templateSlug} 설치`,
          },
          { output: false }
        );
      }
      deps.output(
        flags,
        {
          status: 'installed',
          template_id: templateSlug,
          directory: targetDir,
          git_head: result.head,
          deployment,
        },
        (value) => {
          console.log(`Template installed with Git history: ${value.template_id}`);
          console.log(`Directory: ${value.directory}`);
          console.log(`Template HEAD: ${value.git_head}`);
          printDeployment(value.deployment);
        }
      );
      return;
    }
    const response = await timedFetch(
      `${apiUrl}/v1/templates/${encodeURIComponent(templateSlug)}/download?project_id=${encodeURIComponent(project)}`,
      { method: 'GET', headers }
    );
    if (!response.ok) {
      const text = await response.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {}
      throw new Error(parsed?.error?.message || parsed?.message || text || `HTTP ${response.status}`);
    }
    const template = parseArchive(Buffer.from(await response.arrayBuffer()));
    writeFiles(targetDir, template.files, deps.booleanFlag(flags, 'force'));
    let deployment = null;
    if (deps.booleanFlag(flags, 'deploy')) {
      const entrypoint = deps.stringFlag(flags, 'entrypoint') || template.manifest.entrypoint;
      if (!entrypoint) throw new Error('template manifest has no entrypoint. Pass --entrypoint to deploy.');
      deployment = await deps.deployCode(
        {
          ...flags,
          dir: targetDir,
          entrypoint,
          label: deps.stringFlag(flags, 'label') || `템플릿 ${templateSlug} 설치`,
        },
        { output: false }
      );
    }
    deps.output(
      flags,
      {
        status: 'installed',
        template_id: templateSlug,
        directory: targetDir,
        files: template.files.length,
        deployment,
      },
      (value) => {
        console.log(`Template installed: ${value.template_id}`);
        console.log(`Directory: ${value.directory}`);
        console.log(`Files: ${value.files}`);
        printDeployment(value.deployment);
      }
    );
  }

  async function pull(flags) {
    const targetDir = path.resolve(deps.stringFlag(flags, 'dir') || process.cwd());
    const state = readTemplateState(targetDir);
    const templateSlug = deps.stringFlag(flags, 'template') || state?.slug;
    if (!templateSlug) throw new Error('template pull requires --template or .joripspace/template.json');
    const project = deps.requireProjectId(flags);
    const connection = deps.resolveConnection(flags);
    const apiToken = deps.requireApiToken(flags, connection);
    const apiUrl = connection.apiBaseUrl;
    const headers = { Authorization: `Bearer ${apiToken}`, 'X-Joripspace-Session-Context': 'cli' };
    const update = await timedFetch(
      `${apiUrl}/v1/templates/${encodeURIComponent(templateSlug)}/git-update?project_id=${encodeURIComponent(project)}&current_head=${encodeURIComponent(state.git_head_sha)}`,
      { method: 'GET', headers }
    );
    if (!update.ok) throw await fetchError(update);
    const updateState = await update.json();
    if (!updateState.update_available) {
      deps.output(
        flags,
        { status: 'current', template_id: templateSlug, git_head: state.git_head_sha, updated: false },
        (value) => {
          console.log(`Template is already current: ${value.template_id}`);
          console.log(`Template HEAD: ${value.git_head}`);
        }
      );
      return;
    }
    if (!deps.booleanFlag(flags, 'yes'))
      throw new Error(
        `template update ${updateState.version} is available; review the changes and re-run with --yes to download and merge it`
      );
    const granted = await downloadBundleGrant(apiUrl, headers, templateSlug, project);
    if (!granted) throw new Error('template Git history is unavailable');
    const result = applyGitBundle(targetDir, templateSlug, granted.bundle, granted.metadata, true);
    deps.output(
      flags,
      {
        status: result.updated ? 'updated' : 'current',
        template_id: templateSlug,
        git_head: result.head,
        updated: result.updated,
      },
      (value) => {
        console.log(
          value.updated
            ? `Template updated: ${value.template_id}`
            : `Template is already current: ${value.template_id}`
        );
        console.log(`Template HEAD: ${value.git_head}`);
      }
    );
  }
  return { list, marketplaceList, deploy, install, pull };
}

function printDeployment(value) {
  if (!value) return;
  console.log(`Deployment: ${value.deployment_id || value.checkpoint_id}`);
  console.log(`Status: ${value.status || 'deployed'}`);
  if (value.url || value.default_url) console.log(`URL: ${value.url || value.default_url}`);
  if (value.transport) console.log(`Transport: ${value.transport}`);
}

async function downloadBundleGrant(apiUrl, headers, templateSlug, project) {
  const response = await timedFetch(
    `${apiUrl}/v1/templates/${encodeURIComponent(templateSlug)}/git-bundle-grants?project_id=${encodeURIComponent(project)}`,
    { method: 'POST', headers }
  );
  if (response.status === 409) return null;
  if (!response.ok) throw await fetchError(response);
  const metadata = await response.json();
  const download = await timedFetch(metadata.download_url, { method: 'GET' }, 45_000);
  if (!download.ok) throw await fetchError(download);
  return { metadata, bundle: Buffer.from(await download.arrayBuffer()) };
}

async function timedFetch(url, options, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError')
      throw new Error(`template request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function applyGitRemote(targetDir, templateSlug, source) {
  const previous = readTemplateState(targetDir);
  if (!previous || previous.slug !== templateSlug)
    throw new Error('template lineage does not match this workspace');
  if (source.template_id && previous.template_id && source.template_id !== previous.template_id)
    throw new Error('template source does not match this workspace');
  if (!isGitRepository(targetDir)) throw new Error('template update requires a Git repository');
  const status = git(targetDir, ['status', '--porcelain']).trim();
  if (status) throw new Error('working tree has changes; commit or stash them before template update');
  const remoteUrl = githubRemoteUrl(source.remote_url);
  const sourceRef = gitBranchRef(source.remote_ref);
  git(targetDir, ['fetch', '--no-tags', remoteUrl, sourceRef]);
  const head = gitSha(git(targetDir, ['rev-parse', 'FETCH_HEAD']).trim());
  const previousHead = gitSha(previous.git_head_sha);
  if (previousHead === head) {
    configureTemplateRemote(targetDir, remoteUrl, sourceRef);
    git(targetDir, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
    return { updated: false, head };
  }
  if (gitResult(targetDir, ['merge-base', '--is-ancestor', previousHead, head]).status !== 0)
    throw new Error('template history was rewritten; automatic update stopped');
  ensureGitIdentity(targetDir);
  const merge = gitResult(targetDir, ['merge', '--no-ff', '--no-commit', head]);
  if (merge.status !== 0) {
    throw new Error(
      `template merge has conflicts; resolve them without force-push\n${String(merge.stderr || merge.stdout).trim()}`
    );
  }
  configureTemplateRemote(targetDir, remoteUrl, sourceRef);
  git(targetDir, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
  writeTemplateStateFromSource(targetDir, previous, source, head);
  git(targetDir, ['add', '.joripspace/template.json']);
  git(targetDir, ['commit', '-m', `조립스페이스 템플릿 업데이트: ${templateSlug}`]);
  return { updated: true, head };
}

function installPublicGitClone(targetDir, templateSlug, source) {
  const remoteUrl = githubRemoteUrl(source.remote_url);
  const remoteRef = gitBranchRef(source.remote_ref);
  const remoteBranch = remoteRef.slice('refs/heads/'.length);
  fs.mkdirSync(targetDir, { recursive: true });
  const existingRepository = isGitRepository(targetDir);
  if (existingRepository) {
    if (gitResult(targetDir, ['rev-parse', '--verify', 'HEAD']).status === 0) return null;
    if (git(targetDir, ['ls-files', '-z']).length) return null;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-public-template-'));
  const cloneDir = path.join(temp, 'clone');
  try {
    const clone = gitResult(targetDir, [
      ...cloneLocalConfigArgs(targetDir),
      'clone',
      '--branch',
      remoteBranch,
      '--single-branch',
      '--no-tags',
      remoteUrl,
      cloneDir,
    ]);
    if (clone.status !== 0) return null;
    const head = gitSha(git(cloneDir, ['rev-parse', 'HEAD']).trim());
    const files = git(cloneDir, ['ls-files', '-z']).split('\0').filter(Boolean);
    const allowedCollisions = new Set(['package.json', '.gitignore']);
    const collisions = files.filter(
      (file) => fs.existsSync(path.join(targetDir, ...file.split('/'))) && !allowedCollisions.has(file)
    );
    if (collisions.length) return null;
    const previousPackage = readJson(path.join(targetDir, 'package.json'));
    const previousGitignore = readOptionalText(path.join(targetDir, '.gitignore'));
    if (!existingRepository) git(targetDir, ['init']);
    const branch = gitResult(targetDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branchName =
      branch.status === 0 && String(branch.stdout || '').trim() ? String(branch.stdout || '').trim() : 'main';
    for (const file of allowedCollisions) {
      const destination = path.join(targetDir, file);
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    }
    try {
      git(targetDir, ['fetch', '--no-tags', cloneDir, remoteRef]);
      git(targetDir, ['checkout', '-B', branchName, 'FETCH_HEAD']);
    } catch (error) {
      restoreOptionalText(
        path.join(targetDir, 'package.json'),
        previousPackage && `${JSON.stringify(previousPackage, null, 2)}\n`
      );
      restoreOptionalText(path.join(targetDir, '.gitignore'), previousGitignore);
      throw error;
    }
    mergeManagedPackageScripts(path.join(targetDir, 'package.json'), previousPackage);
    mergeGitignore(path.join(targetDir, '.gitignore'), previousGitignore);
    configureTemplateRemote(targetDir, remoteUrl, remoteRef);
    git(targetDir, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
    writeClonedTemplateState(targetDir, templateSlug, source, head);
    return { head };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function cloneLocalConfigArgs(targetDir) {
  const result = [];
  const rewrites = gitResult(targetDir, ['config', '--get-regexp', '^url\\..*\\.insteadOf$']);
  if (rewrites.status === 0) {
    for (const line of String(rewrites.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)) {
      const separator = line.search(/\s/);
      if (separator > 0) result.push('-c', `${line.slice(0, separator)}=${line.slice(separator).trim()}`);
    }
  }
  const fileProtocol = gitResult(targetDir, ['config', '--get', 'protocol.file.allow']);
  if (fileProtocol.status === 0 && String(fileProtocol.stdout || '').trim()) {
    result.push('-c', `protocol.file.allow=${String(fileProtocol.stdout || '').trim()}`);
  }
  return result;
}

function configureTemplateRemote(targetDir, sourceRef) {
  const remoteUrl = '.git/joripspace/upstream.bundle';
  const current = gitResult(targetDir, ['config', '--get', 'remote.upstream.url']);
  if (current.status === 0) {
    if (String(current.stdout).trim() !== remoteUrl)
      throw new Error('existing upstream remote is not managed by JoripSpace');
  } else {
    git(targetDir, ['remote', 'add', 'upstream', remoteUrl]);
  }
  git(targetDir, [
    'config',
    '--replace-all',
    'remote.upstream.fetch',
    `${sourceRef}:refs/remotes/upstream/main`,
  ]);
  git(targetDir, ['config', '--replace-all', 'remote.upstream.tagOpt', '--no-tags']);
  if (gitResult(targetDir, ['remote', 'get-url', 'joripspace-template']).status === 0)
    git(targetDir, ['remote', 'remove', 'joripspace-template']);
}

function applyGitBundle(targetDir, templateSlug, bundle, metadata, updateOnly) {
  const expectedHash = String(metadata.bundle_sha256 || '');
  const actualHash = crypto.createHash('sha256').update(bundle).digest('hex');
  if (!safeEqualHex(actualHash, expectedHash)) throw new Error('template Git bundle integrity check failed');
  const head = gitSha(metadata.git_head_sha);
  const sourceRef = gitBranchRef(metadata.git_ref);
  if (!['refs/heads/main', 'refs/heads/joripspace-template-main'].includes(sourceRef))
    throw new Error('template Git ref is invalid');
  fs.mkdirSync(targetDir, { recursive: true });
  git(targetDir, ['--version'], { withoutC: true });
  if (!isGitRepository(targetDir)) {
    if (updateOnly) throw new Error('template update requires a Git repository');
    git(targetDir, ['init']);
  }
  const status = git(targetDir, ['status', '--porcelain']).trim();
  if (status)
    throw new Error('working tree has changes; commit or stash them before template Git installation/update');
  const gitDirectory = path.resolve(targetDir, git(targetDir, ['rev-parse', '--git-dir']).trim());
  const bundleDirectory = path.join(gitDirectory, 'joripspace');
  fs.mkdirSync(bundleDirectory, { recursive: true });
  const candidatePath = path.join(bundleDirectory, `upstream-${crypto.randomUUID()}.bundle`);
  const bundlePath = path.join(bundleDirectory, 'upstream.bundle');
  const backupPath = path.join(bundleDirectory, 'upstream.bundle.previous');
  fs.writeFileSync(candidatePath, bundle, { flag: 'wx' });
  try {
    git(targetDir, ['bundle', 'verify', candidatePath]);
    git(targetDir, ['fetch', '--no-tags', candidatePath, `${sourceRef}:refs/joripspace/candidate`]);
    const fetchedHead = gitSha(git(targetDir, ['rev-parse', 'refs/joripspace/candidate']).trim());
    if (fetchedHead !== head) throw new Error('template Git HEAD does not match the downloaded bundle');
    const previous = readTemplateState(targetDir);
    if (updateOnly) {
      if (!previous || previous.slug !== templateSlug)
        throw new Error('template lineage does not match this workspace');
      if (previous.template_id && metadata.template_id !== previous.template_id)
        throw new Error('template source does not match this workspace');
      if (
        gitResult(targetDir, ['merge-base', '--is-ancestor', gitSha(previous.git_head_sha), head]).status !==
        0
      )
        throw new Error('template history was rewritten; automatic update stopped');
    }
    const upstream = gitResult(targetDir, ['config', '--get', 'remote.upstream.url']);
    if (upstream.status === 0 && String(upstream.stdout).trim() !== '.git/joripspace/upstream.bundle')
      throw new Error('existing upstream remote is not managed by JoripSpace');
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    if (fs.existsSync(bundlePath)) fs.renameSync(bundlePath, backupPath);
    try {
      fs.renameSync(candidatePath, bundlePath);
    } catch (error) {
      if (fs.existsSync(backupPath)) fs.renameSync(backupPath, bundlePath);
      throw error;
    }
    configureTemplateRemote(targetDir, sourceRef);
    git(targetDir, ['fetch', '--no-tags', 'upstream']);
    git(targetDir, ['update-ref', '-d', 'refs/joripspace/candidate']);
    if (updateOnly && previous.git_head_sha === head) {
      writeTemplateState(targetDir, templateSlug, metadata, head);
      git(targetDir, ['add', '.joripspace/template.json']);
      if (gitResult(targetDir, ['diff', '--cached', '--quiet']).status !== 0) {
        ensureGitIdentity(targetDir);
        git(targetDir, ['commit', '-m', `조립스페이스 공식 업데이트 채널 연결: ${templateSlug}`]);
      }
      if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
      return { updated: false, head };
    }
    ensureGitIdentity(targetDir);
    const hasHead = gitResult(targetDir, ['rev-parse', '--verify', 'HEAD']).status === 0;
    if (!hasHead) {
      git(targetDir, ['checkout', '-B', 'main', head]);
      writeTemplateState(targetDir, templateSlug, metadata, head);
      git(targetDir, ['add', '.joripspace/template.json']);
      git(targetDir, ['commit', '-m', `조립스페이스 템플릿 연결: ${templateSlug}`]);
    } else {
      const merge = gitResult(targetDir, [
        'merge',
        '--no-ff',
        '--no-commit',
        '--allow-unrelated-histories',
        head,
      ]);
      if (merge.status !== 0) {
        throw new Error(
          `template merge has conflicts; resolve them without force-push\n${String(merge.stderr || merge.stdout).trim()}`
        );
      }
      writeTemplateState(targetDir, templateSlug, metadata, head);
      git(targetDir, ['add', '.joripspace/template.json']);
      git(targetDir, [
        'commit',
        '-m',
        `${updateOnly ? '조립스페이스 템플릿 업데이트' : '조립스페이스 템플릿 연결'}: ${templateSlug}`,
      ]);
    }
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    return { updated: true, head };
  } finally {
    if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath, { force: true });
    gitResult(targetDir, ['update-ref', '-d', 'refs/joripspace/candidate']);
  }
}

function readTemplateState(targetDir) {
  const file = path.join(targetDir, '.joripspace', 'template.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('.joripspace/template.json is invalid');
  }
}

function writeTemplateState(targetDir, slug, metadata, head) {
  const directory = path.join(targetDir, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'template.json'),
    `${JSON.stringify(
      {
        schema_version: 3,
        slug,
        template_id: String(metadata.template_id || ''),
        version_id: String(metadata.version_id || ''),
        version: String(metadata.version || ''),
        git_head_sha: head,
        remote_ref: 'refs/remotes/upstream/main',
      },
      null,
      2
    )}\n`
  );
}

function writeTemplateStateFromSource(targetDir, previous, source, head) {
  const directory = path.join(targetDir, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'template.json'),
    `${JSON.stringify(
      {
        ...previous,
        schema_version: 2,
        git_head_sha: head,
        remote_ref: 'refs/remotes/joripspace-template/main',
        remote_url: githubRemoteUrl(source.remote_url),
        remote_branch_ref: gitBranchRef(source.remote_ref),
      },
      null,
      2
    )}\n`
  );
}

function writeClonedTemplateState(targetDir, slug, source, head) {
  const directory = path.join(targetDir, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'template.json'),
    `${JSON.stringify(
      {
        schema_version: 2,
        slug,
        template_id: source.template_id,
        version_id: source.version_id,
        version: source.version,
        git_head_sha: head,
        remote_ref: 'refs/remotes/joripspace-template/main',
        remote_url: githubRemoteUrl(source.remote_url),
        remote_branch_ref: gitBranchRef(source.remote_ref),
      },
      null,
      2
    )}\n`
  );
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mergeManagedPackageScripts(file, previous) {
  if (!previous || !fs.existsSync(file)) return;
  const current = readJson(file);
  if (!current) return;
  current.scripts = current.scripts && typeof current.scripts === 'object' ? current.scripts : {};
  for (const [name, command] of Object.entries(previous.scripts || {})) {
    if (name.startsWith('joripspace:')) current.scripts[name] = command;
  }
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}

function readOptionalText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function restoreOptionalText(file, value) {
  if (value === null || value === undefined) return;
  fs.writeFileSync(file, value);
}

function mergeGitignore(file, previous) {
  if (previous === null) return;
  const current = readOptionalText(file) || '';
  const lines = current.split(/\r?\n/).filter(Boolean);
  const seen = new Set(lines);
  for (const line of previous.split(/\r?\n/).filter(Boolean)) {
    if (!seen.has(line)) {
      lines.push(line);
      seen.add(line);
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function isGitRepository(directory) {
  const result = gitResult(directory, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0 && String(result.stdout).trim() === 'true';
}

function ensureGitIdentity(directory) {
  const name = gitResult(directory, ['config', '--get', 'user.name']);
  const email = gitResult(directory, ['config', '--get', 'user.email']);
  if (
    name.status !== 0 ||
    email.status !== 0 ||
    !String(name.stdout).trim() ||
    !String(email.stdout).trim()
  ) {
    throw new Error('Git user.name and user.email must be configured before installing a history template');
  }
}

function git(directory, args, options = {}) {
  const result = gitResult(directory, args, options);
  if (result.error?.code === 'ENOENT') throw new Error('git command not found');
  if (result.status !== 0)
    throw new Error(String(result.stderr || result.stdout || 'git command failed').trim());
  return String(result.stdout || '');
}

function gitResult(directory, args, options = {}) {
  return spawnSync('git', options.withoutC ? args : ['-C', directory, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function requiredHeader(headers, name) {
  const value = String(headers.get(name) || '').trim();
  if (!value) throw new Error(`template response is missing ${name}`);
  return value;
}

function optionalHeader(headers, name) {
  return String(headers.get(name) || '').trim();
}

function githubRemoteUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('template Git remote URL is invalid');
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(part))
  ) {
    throw new Error('template Git remote URL is invalid');
  }
  return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, '')}.git`;
}

function gitBranchRef(value) {
  const normalized = String(value || '');
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(normalized) || normalized.includes('..'))
    throw new Error('template Git remote ref is invalid');
  return normalized;
}

function gitSha(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error('template Git SHA is invalid');
  return normalized;
}

function safeEqualHex(actual, expected) {
  const normalized = String(expected || '').toLowerCase();
  return (
    /^[0-9a-f]{64}$/.test(normalized) &&
    crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(normalized, 'hex'))
  );
}

async function fetchError(response) {
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {}
  return new Error(parsed?.error?.message || parsed?.message || text || `HTTP ${response.status}`);
}

function parseArchive(archive) {
  let tar;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: 100 * 1024 * 1024 });
  } catch {
    throw new Error('template archive is invalid or exceeds 100 MB');
  }
  const entries = [];
  let offset = 0;
  let pendingPath = '';
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarField(header.subarray(0, 100));
    const prefix = tarField(header.subarray(345, 500));
    const archivePath = pendingPath || [prefix, name].filter(Boolean).join('/');
    pendingPath = '';
    const size = tarOctal(header.subarray(124, 136));
    const mode = tarOctal(header.subarray(100, 108));
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('template archive is damaged');
    const data = tar.subarray(dataStart, dataEnd);
    if (type === 'L') pendingPath = tarField(data);
    if (type === 'x') pendingPath = paxPath(data) || pendingPath;
    if (type === '0' || type === '\0') {
      const relative = stripRoot(archivePath);
      if (relative) entries.push({ path: safePath(relative), data: Buffer.from(data), mode });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  const manifestEntry = entries.find((entry) => entry.path === 'joripspace-template.json');
  if (!manifestEntry) throw new Error('joripspace-template.json is missing');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new Error('joripspace-template.json is invalid');
  }
  const sourceRoot = normalizeSourceRoot(manifest.source_root);
  const files = entries
    .filter((entry) => sourceRoot === '.' || entry.path.startsWith(`${sourceRoot}/`))
    .map((entry) => ({
      ...entry,
      path: sourceRoot === '.' ? entry.path : safePath(entry.path.slice(sourceRoot.length + 1)),
    }));
  if (!files.length) throw new Error('template source_root contains no files');
  return { manifest, files };
}

function writeFiles(targetDir, files, force) {
  const collisions = files
    .map((file) => path.resolve(targetDir, ...file.path.split('/')))
    .filter(fs.existsSync);
  if (collisions.length && !force)
    throw new Error(`template would overwrite ${collisions.length} existing file(s). Re-run with --force.`);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const outputPath = path.resolve(targetDir, ...file.path.split('/'));
    const relative = path.relative(targetDir, outputPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('unsafe template path');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, file.data, { mode: file.mode & 0o111 ? 0o755 : 0o644 });
  }
}

function tarField(bytes) {
  const end = bytes.indexOf(0);
  return Buffer.from(end >= 0 ? bytes.subarray(0, end) : bytes)
    .toString('utf8')
    .trim();
}
function tarOctal(bytes) {
  const value = tarField(bytes).replace(/[^0-7].*$/, '');
  return value ? Number.parseInt(value, 8) : 0;
}
function paxPath(bytes) {
  for (const line of Buffer.from(bytes).toString('utf8').split('\n')) {
    const match = line.match(/^\d+ path=(.+)$/);
    if (match) return match[1];
  }
  return '';
}
function stripRoot(value) {
  const parts = String(value || '')
    .replace(/^\.?\//, '')
    .split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : '';
}
function safePath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('template contains an unsafe path');
  return normalized;
}
function normalizeSourceRoot(value) {
  const normalized = String(value || '.')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  return normalized === '' || normalized === '.' ? '.' : safePath(normalized);
}

module.exports = { applyGitBundle, createTemplateCommands };
