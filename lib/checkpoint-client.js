const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync, zipSync } = require('fflate');
const {
  assertNonOverlappingFilePlan,
  backupAndRemoveProjectPaths,
  createExternalBackupRoot,
  resolveProjectFileTarget,
  safeProjectRelativePath,
} = require('./project-paths');
const { ensureProjectEnvIgnored } = require('./project-env');

const HARD_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.cache', 'coverage', 'tmp', 'temp']);
const HARD_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const AGENT_CONTROL_DIRS = new Set(['.agents', '.claude', '.codex', '.cursor', '.gemini', '.opencode']);
const AGENT_CONTROL_FILES = new Set(['agents.md', 'claude.md']);
const LOCAL_PROJECT_MARKER = '.joripspace/project';
const LEGACY_IDENTITY_FILE = '.joripspace/project.json';
const TRANSIENT_DEPLOY_MANIFEST = '.joripspace/deploy.json';
const CHECKPOINT_METADATA_FILES = new Set([
  LOCAL_PROJECT_MARKER,
  LEGACY_IDENTITY_FILE,
  TRANSIENT_DEPLOY_MANIFEST,
]);
const LOCAL_RESTORE_MARKERS = new Set([...CHECKPOINT_METADATA_FILES, '.gitignore']);

async function runCheckpointOperation(command, options) {
  if (command === 'save') return saveCheckpoint(options);
  if (command === 'restore') return restoreCheckpoint(options);
  throw new Error(`unknown checkpoint operation: ${command}`);
}

async function saveCheckpoint(options, sourceType = 'agent') {
  ensureTokenIgnoreInvariant(options.workspaceDir);
  const label = String(options.label || '').trim();
  if (!label) throw new Error('checkpoint save requires --label');
  if (label.length > 120) throw new Error('checkpoint label must be 120 characters or fewer');
  const files = projectFiles(options.workspaceDir);
  if (options.entrypoint) {
    const entrypoint = safeRestorePath(options.entrypoint);
    if (!files.some(([name]) => name === entrypoint)) {
      throw new Error(`deployment entrypoint was excluded from the archive: ${entrypoint}`);
    }
    upsertDeployManifest(files, options.workspaceDir, entrypoint);
  }
  if (!files.length) throw new Error('there are no project files to save');
  assertNonOverlappingFilePlan(files.map(([relative]) => relative));
  const archive = zipSync(Object.fromEntries(files.map(([name, bytes]) => [name, [bytes, { level: 6 }]])), {
    level: 6,
  });
  const session = await apiFetch(
    options,
    `/v1/projects/${encodeURIComponent(options.projectId)}/checkpoint-uploads`,
    {
      method: 'POST',
      json: { label, source_type: options.sourceType || sourceType, idempotency_key: crypto.randomUUID() },
    }
  );
  const chunkSize = Number(session.chunk_size || 6 * 1024 * 1024);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new Error('invalid checkpoint upload chunk size');
  let part = 1;
  for (let offset = 0; offset < archive.byteLength; offset += chunkSize) {
    const route = String(session.upload_part_url_template || '').replace('{part_number}', String(part));
    if (!route) throw new Error('checkpoint upload part URL is missing');
    await apiFetch(options, route, {
      method: 'PUT',
      bytes: archive.subarray(offset, Math.min(offset + chunkSize, archive.byteLength)),
      timeoutMs: options.deploy ? null : 45_000,
    });
    part += 1;
  }
  await apiFetch(options, String(session.complete_url || '') + (options.deploy ? '?wait=ready' : ''), {
    method: 'POST',
    json: {},
    timeoutMs: options.deploy ? null : 45_000,
  });
  const checkpoint = await waitReady(options, session.checkpoint_id);
  let deployment = null;
  if (options.deploy) {
    if (!checkpoint.deployable) throw new Error('this checkpoint is backup-only and cannot be deployed');
    deployment = await apiFetch(
      options,
      `/v1/projects/${encodeURIComponent(options.projectId)}/checkpoints/${encodeURIComponent(checkpoint.checkpoint_id)}/deploy`,
      { method: 'POST', json: {}, timeoutMs: null }
    );
  }
  return {
    status: 'saved',
    archive_bytes: archive.byteLength,
    file_count: files.length,
    checkpoint,
    deployment,
  };
}

async function restoreCheckpoint(options) {
  ensureTokenIgnoreInvariant(options.workspaceDir);
  const checkpointId = String(options.checkpointId || '').trim();
  if (!checkpointId) throw new Error('checkpoint restore requires --checkpoint');
  const base = `/v1/projects/${encodeURIComponent(options.projectId)}/checkpoints/${encodeURIComponent(checkpointId)}`;
  const plan = await apiFetch(options, `${base}/restore-plan`);
  const response = await apiFetch(options, `${base}/download`, { raw: true, timeoutMs: 45_000 });
  const extracted = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const planned = verifyRestoreArchive(plan, extracted);
  verifyCheckpointIdentity(planned, options.projectId);
  const writable = planned.filter(([relative]) => !isLocalRestoreMarker(relative));
  assertNonOverlappingFilePlan(writable.map(([relative]) => relative));
  const plannedPaths = new Set([
    ...planned.map(([relative]) => portablePathKey(relative)),
    ...LOCAL_RESTORE_MARKERS,
  ]);
  const additions = [];
  const overwrites = [];
  const conflictPaths = new Set();
  for (const [relative, bytes] of writable) {
    const location = resolveProjectFileTarget(options.workspaceDir, relative, 'unsafe checkpoint path');
    if (location.blockers.length) {
      overwrites.push(relative);
      location.blockers.forEach((blocker) => conflictPaths.add(blocker));
    } else if (!fs.existsSync(location.target)) additions.push(relative);
    else if (!Buffer.from(fs.readFileSync(location.target)).equals(Buffer.from(bytes))) {
      overwrites.push(relative);
      conflictPaths.add(relative);
    }
  }
  const deletions = projectFiles(options.workspaceDir)
    .map(([relative]) => relative)
    .filter((relative) => !plannedPaths.has(portablePathKey(relative)));
  const protectedSkipped = planned
    .filter(([relative]) => isLocalRestoreMarker(relative))
    .map(([relative]) => relative);
  const preview = { additions, overwrites, deletions, protected_files_skipped: protectedSkipped };
  if (!options.apply) return { status: 'preview', checkpoint_id: checkpointId, ...preview };

  const safety = await saveCheckpoint(
    { ...options, label: '복원 전 안전 저장본', deploy: false },
    'restore_safety'
  );
  const backupRoot = createExternalBackupRoot(options.workspaceDir, 'checkpoint-restore', options.dataDir);
  backupAndRemoveProjectPaths(options.workspaceDir, [...conflictPaths, ...deletions], backupRoot);
  for (const [relative, bytes] of writable) {
    const location = resolveProjectFileTarget(options.workspaceDir, relative, 'unsafe checkpoint path');
    if (location.blockers.length) {
      throw new Error(`checkpoint target is blocked by a local path: ${location.blockers.join(', ')}`);
    }
    fs.mkdirSync(path.dirname(location.target), { recursive: true });
    fs.writeFileSync(location.target, bytes);
  }
  ensureTokenIgnoreInvariant(options.workspaceDir);
  for (const [relative, bytes] of writable) {
    const restored = fs.readFileSync(
      resolveProjectFileTarget(options.workspaceDir, relative, 'unsafe checkpoint path').target
    );
    if (!Buffer.from(restored).equals(Buffer.from(bytes))) {
      throw new Error(`checkpoint post-restore integrity check failed: ${relative}`);
    }
  }
  return {
    status: 'restored',
    checkpoint_id: checkpointId,
    ...preview,
    safety_checkpoint_id: safety.checkpoint.checkpoint_id,
    backup_root: backupRoot,
  };
}

function projectFiles(root) {
  const rules = ignoreRules(root);
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      let relative = toPosix(path.relative(root, full));
      if (hardExcluded(relative)) continue;
      const excluded = ignored(relative, rules);
      if (excluded && (!entry.isDirectory() || !negatedRuleCanInclude(relative, rules))) continue;
      relative = safeProjectRelativePath(relative, 'unsafe checkpoint path');
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink())
        throw new Error(`symbolic links cannot be included in checkpoints: ${relative}`);
      if (entry.isDirectory()) {
        if (!excluded || negatedRuleCanInclude(relative, rules)) walk(full);
      } else if (entry.isFile() && !excluded) {
        files.push([relative, new Uint8Array(fs.readFileSync(full))]);
      }
    }
  }
  walk(root);
  return files;
}

function hardExcluded(relative) {
  const normalized = toPosix(relative).replace(/^\.\//, '').toLowerCase();
  const parts = normalized.split('/');
  const base = parts.at(-1) || '';
  return (
    HARD_FILES.has(base) ||
    parts.some((part) => HARD_DIRS.has(part)) ||
    parts.some((part) => AGENT_CONTROL_DIRS.has(part)) ||
    AGENT_CONTROL_FILES.has(base) ||
    parts.includes('.joripspace') ||
    base === '.env.joripspace' ||
    /\.(log|tmp|temp)$/i.test(base)
  );
}

function verifyCheckpointIdentity(planned, projectId) {
  for (const [relative, bytes] of planned) {
    if (isCanonicalProjectMarker(relative)) {
      const marker = Buffer.from(bytes).toString('utf8');
      if (!/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?\n?$/.test(marker)) {
        throw new Error('checkpoint project marker is not a canonical project slug');
      }
      if (marker.trim() !== String(projectId)) {
        throw new Error('checkpoint project metadata does not match the connected project');
      }
      continue;
    }
    if (!isLegacyIdentityFile(relative)) continue;
    let config;
    try {
      config = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new Error('checkpoint project metadata is not valid JSON');
    }
    const identities = [config?.project_id, config?.project_slug]
      .filter(Boolean)
      .map((value) => String(value));
    if (!identities.length || identities.some((identity) => identity !== String(projectId))) {
      throw new Error('checkpoint project metadata does not match the connected project');
    }
  }
}

function ensureTokenIgnoreInvariant(workspaceDir) {
  if (fs.existsSync(path.join(workspaceDir, '.env.joripspace'))) {
    ensureProjectEnvIgnored(workspaceDir);
  }
}

function verifyRestoreArchive(plan, extracted) {
  if (!plan || !Array.isArray(plan.files)) throw new Error('checkpoint restore plan has no valid files');
  const expected = new Map();
  for (const file of plan.files) {
    const relative = safeRestorePath(file?.path);
    if (expected.has(relative))
      throw new Error(`checkpoint restore plan contains a duplicate path: ${relative}`);
    const byteSize = Number(file?.byte_size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || typeof file?.content_hash !== 'string') {
      throw new Error(`checkpoint restore plan metadata is invalid: ${relative}`);
    }
    expected.set(relative, { byteSize, contentHash: file.content_hash });
  }
  const planned = [];
  for (const [name, bytes] of Object.entries(extracted)) {
    const relative = safeRestorePath(name);
    const metadata = expected.get(relative);
    if (!metadata) throw new Error(`checkpoint archive contains an unplanned file: ${relative}`);
    if (bytes.byteLength !== metadata.byteSize) {
      throw new Error(`checkpoint byte size check failed: ${relative}`);
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('base64url');
    if (!metadata.contentHash || metadata.contentHash !== actual) {
      throw new Error(`checkpoint integrity check failed: ${relative}`);
    }
    planned.push([relative, bytes]);
    expected.delete(relative);
  }
  if (expected.size) {
    throw new Error(`checkpoint archive is missing planned files: ${[...expected.keys()].join(', ')}`);
  }
  assertNonOverlappingFilePlan(planned.map(([relative]) => relative));
  return planned;
}

function upsertDeployManifest(files, workspaceDir, entrypoint) {
  const normalized = safeRestorePath(entrypoint);
  const bytes = new Uint8Array(Buffer.from(`${JSON.stringify({ entrypoint: normalized }, null, 2)}\n`));
  const index = files.findIndex(([name]) => isTransientDeployManifest(name));
  if (index >= 0) files[index] = [TRANSIENT_DEPLOY_MANIFEST, bytes];
  else files.push([TRANSIENT_DEPLOY_MANIFEST, bytes]);
}

function ignoreRules(root) {
  const rules = [];
  for (const name of ['.gitignore', '.ignore', '.joripspaceignore']) {
    try {
      for (const line of fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.startsWith('#')) rules.push(value);
      }
    } catch {}
  }
  return rules;
}

function globRegex(pattern) {
  const clean = pattern.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '/**');
  const escaped = clean
    .replace(/[.+^$(){}|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^(?:${escaped})(?:/.*)?$`);
}

function ignored(relative, rules) {
  if (hardExcluded(relative)) return true;
  const normalized = toPosix(relative);
  let result = false;
  for (const rule of rules) {
    if (globRegex(rule).test(normalized)) result = !rule.startsWith('!');
  }
  return result;
}

function negatedRuleCanInclude(directory, rules) {
  const prefix = `${toPosix(directory).replace(/\/$/, '')}/`;
  return rules.some((rule) => {
    if (!rule.startsWith('!')) return false;
    const target = rule.slice(1).replace(/^\//, '').replace(/\*.*$/, '');
    return target.startsWith(prefix) || prefix.startsWith(`${target.replace(/\/$/, '')}/`);
  });
}

function safeRestorePath(name) {
  const normalized = safeProjectRelativePath(name, 'unsafe checkpoint path');
  if (hardExcluded(normalized) && !isCheckpointMetadataFile(normalized)) {
    throw new Error(`protected file cannot be restored: ${normalized}`);
  }
  return normalized;
}

function portablePathKey(relative) {
  return toPosix(String(relative || '')).toLowerCase();
}

function isCheckpointMetadataFile(relative) {
  return CHECKPOINT_METADATA_FILES.has(portablePathKey(relative));
}

function isCanonicalProjectMarker(relative) {
  return portablePathKey(relative) === LOCAL_PROJECT_MARKER;
}

function isLegacyIdentityFile(relative) {
  return portablePathKey(relative) === LEGACY_IDENTITY_FILE;
}

function isTransientDeployManifest(relative) {
  return portablePathKey(relative) === TRANSIENT_DEPLOY_MANIFEST;
}

function isLocalRestoreMarker(relative) {
  return LOCAL_RESTORE_MARKERS.has(portablePathKey(relative));
}

async function waitReady(options, checkpointId) {
  for (let attempt = 0; options.deploy || attempt < 120; attempt += 1) {
    const result = await apiFetch(
      options,
      `/v1/projects/${encodeURIComponent(options.projectId)}/checkpoints/${encodeURIComponent(checkpointId)}`
    );
    if (result.status === 'ready') return result;
    if (result.status === 'failed' || result.status === 'deleted') {
      throw new Error(result.error_message || 'checkpoint processing failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('checkpoint processing is still pending; check the checkpoint list before retrying');
}

async function apiFetch(options, route, request = {}) {
  if (!route) throw new Error('checkpoint API route is missing');
  const url = new URL(route, `${options.apiBaseUrl}/`);
  if (url.origin !== new URL(options.apiBaseUrl).origin)
    throw new Error('checkpoint upload URL changed origin');
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs === null ? null : (request.timeoutMs ?? 25_000);
  const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: request.method || 'GET',
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        'x-joripspace-session-context': 'cli',
        ...(request.json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: request.bytes || (request.json === undefined ? undefined : JSON.stringify(request.json)),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('checkpoint request timed out');
      timeoutError.code = 'request_timeout';
      throw timeoutError;
    }
    const requestError = new Error(error instanceof Error ? error.message : String(error));
    requestError.code = 'request_failed';
    throw requestError;
  } finally {
    clearTimeout(timer);
  }
  if (request.raw) {
    if (!response.ok) {
      const apiError = new Error(`checkpoint download failed (HTTP ${response.status})`);
      apiError.code = 'http_error';
      apiError.status = response.status;
      throw apiError;
    }
    return response;
  }
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const apiError = new Error(
      body?.error?.message || body?.message || `checkpoint request failed (HTTP ${response.status})`
    );
    apiError.code = body?.error?.code || 'http_error';
    apiError.status = response.status;
    if (body?.error?.details !== undefined) apiError.details = body.error.details;
    throw apiError;
  }
  return body;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

module.exports = {
  hardExcluded,
  projectFiles,
  runCheckpointOperation,
  safeRestorePath,
  verifyRestoreArchive,
};
