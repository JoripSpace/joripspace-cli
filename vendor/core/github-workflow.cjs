function buildGithubWorkflow({ projectId, branch, buildCommand, artifactPath, entrypoint }) {
  const commands = String(buildCommand)
    .split('\n')
    .map((line) => `          ${line}`)
    .join('\n');
  const deployScript = `${inlineDeployMain.toString()}\n\nawait inlineDeployMain();`
    .split('\n')
    .map((line) => `          ${line}`)
    .join('\n');
  return `# joripspace-workflow-version: 8
name: JoripSpace Deploy

on:
  push:
    branches:
      - ${JSON.stringify(String(branch))}
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

concurrency:
  group: ${JSON.stringify(`joripspace-${String(projectId)}`)}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - name: Build
        run: |
          set -Eeuo pipefail
          trap 'code=$?; echo "::error title=JoripSpace build failed::Build failed at line $LINENO (exit $code)"; exit "$code"' ERR
${commands}
      - name: Deploy to JoripSpace
        shell: bash
        env:
          JORIPSPACE_PROJECT_ID: ${JSON.stringify(String(projectId))}
          JORIPSPACE_ARTIFACT_PATH: ${JSON.stringify(String(artifactPath))}
          JORIPSPACE_ENTRYPOINT: ${JSON.stringify(String(entrypoint))}
          JORIPSPACE_API_URL: "https://api.joripspace.com"
        run: |
          set -euo pipefail
          source_dir="$JORIPSPACE_ARTIFACT_PATH"
          if [[ ! -d "$source_dir" ]]; then
            echo "::error title=JoripSpace artifact preparation failed::JoripSpace artifact directory does not exist: $source_dir" >&2
            exit 1
          fi
          stage_dir="$RUNNER_TEMP/joripspace-artifact-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
          archive_path="$RUNNER_TEMP/joripspace-artifact-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.zip"
          rm -rf "$stage_dir"
          mkdir -p "$stage_dir"
          cp -R "$source_dir"/. "$stage_dir"/
          JORIPSPACE_STAGE_DIR="$stage_dir" node --input-type=module -e '
            import { writeFile } from "node:fs/promises";
            import { join } from "node:path";
            const root = process.env.JORIPSPACE_STAGE_DIR;
            const entrypoint = process.env.JORIPSPACE_ENTRYPOINT;
            await writeFile(join(root, ".joripspace-deploy.json"), JSON.stringify({ entrypoint }) + "\\n");
          '
          (cd "$stage_dir" && find . -type f -exec zip -q "$archive_path" -- {} +)
          JORIPSPACE_ARCHIVE_PATH="$archive_path" node --input-type=module <<'JORIPSPACE_SCRIPT'
${deployScript}
          JORIPSPACE_SCRIPT
`;
}

function projectGithubActionsTemplateFile(projectConfig = {}) {
  return buildGithubWorkflow({
    projectId: String(projectConfig.project_id || '__JORIPSPACE_PROJECT_ID__'),
    branch: '__JORIPSPACE_BRANCH__',
    buildCommand: '__JORIPSPACE_BUILD_COMMAND__',
    artifactPath: '__JORIPSPACE_ARTIFACT_PATH__',
    entrypoint: '__JORIPSPACE_ENTRYPOINT__',
  });
}

async function inlineDeployMain() {
  const { open } = await import('node:fs/promises');
  const audience = 'https://api.joripspace.com/v1/external-builds/github';
  const projectId = requiredEnv('JORIPSPACE_PROJECT_ID');
  const archivePath = requiredEnv('JORIPSPACE_ARCHIVE_PATH');
  const apiUrl = requiredEnv('JORIPSPACE_API_URL').replace(/\/+$/, '');
  const oidcToken = await requestOidcToken();
  const create = await api(`/v1/projects/${encodeURIComponent(projectId)}/checkpoint-uploads`, {
    method: 'POST',
    token: oidcToken,
    json: { source_type: 'deployment' },
  });
  const file = await open(archivePath, 'r');
  try {
    const chunkSize = Number(create.chunk_size || 8 * 1024 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    let partNumber = 1;
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const partPath = String(create.upload_part_url_template).replace('{part_number}', String(partNumber));
      await api(partPath, {
        method: 'PUT',
        token: oidcToken,
        body: buffer.subarray(0, bytesRead),
        contentType: 'application/octet-stream',
      });
      position += bytesRead;
      partNumber += 1;
    }
    if (position === 0) throw new Error('Build artifact ZIP is empty.');
  } finally {
    await file.close();
  }
  await api(create.complete_url, { method: 'POST', token: oidcToken, json: {} });
  const deployPath = `/v1/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(create.checkpoint_id)}/deploy`;
  for (let attempt = 1; attempt <= 150; attempt += 1) {
    const deployToken = await requestOidcToken();
    const result = await api(deployPath, {
      method: 'POST',
      token: deployToken,
      json: {},
      allowedStatuses: [404, 409],
    });
    if (!result.__retry) {
      process.stdout.write(
        `JoripSpace deployment succeeded: ${result.url || result.default_url || result.deployment_id || projectId}\n`
      );
      return;
    }
    if (
      !['checkpoint_not_found', 'checkpoint_not_ready', 'external_build_deploy_busy'].includes(
        result.error?.code
      )
    ) {
      throw apiError(result.__status, result);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('JoripSpace artifact processing did not finish within 5 minutes.');

  async function requestOidcToken() {
    const requestUrl = requiredEnv('ACTIONS_ID_TOKEN_REQUEST_URL');
    const requestToken = requiredEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const separator = requestUrl.includes('?') ? '&' : '?';
    const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.value !== 'string') {
      throw new Error(`GitHub OIDC token request failed (${response.status}).`);
    }
    return payload.value;
  }

  async function api(path, options) {
    const url = path.startsWith('http') ? path : `${apiUrl}${path}`;
    const headers = new Headers({ Authorization: `Bearer ${options.token}`, Accept: 'application/json' });
    let body = options.body;
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.json);
    } else if (options.contentType) headers.set('Content-Type', options.contentType);
    const response = await fetch(url, { method: options.method, headers, body });
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (response.ok) return payload;
    if ((options.allowedStatuses || []).includes(response.status)) {
      return { ...payload, __retry: true, __status: response.status };
    }
    throw apiError(response.status, payload);
  }

  function apiError(status, payload) {
    const error = new Error(payload?.error?.message || `JoripSpace request failed (${status}).`);
    error.code = payload?.error?.code || 'joripspace_request_failed';
    const diagnostic = JSON.stringify({ http_status: status, code: error.code, message: error.message, details: payload?.error?.details || null })
      .replace(/((?:authorization|[\w-]*(?:key|token|secret|password|credential)[\w-]*)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 16000);
    console.error(`JORIPSPACE_DIAGNOSTIC ${diagnostic}`);
    return error;
  }
  function safeJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return { error: { code: 'invalid_response', message: value.slice(0, 500) } };
    }
  }
  function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  }
}

module.exports = { buildGithubWorkflow, projectGithubActionsTemplateFile };
