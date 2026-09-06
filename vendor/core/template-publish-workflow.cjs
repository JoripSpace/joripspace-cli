function buildTemplatePublishWorkflow({
  templateId,
  branch = 'main',
  manifestPath = 'joripspace-template.json',
}) {
  const publishScript = `${inlineTemplatePublishMain.toString()}\n\nawait inlineTemplatePublishMain();`
    .split('\n')
    .map((line) => `          ${line}`)
    .join('\n');
  return `# joripspace-template-workflow-version: 3
#
# JoripSpace 템플릿 배포 가이드
# 1. 이 파일과 joripspace-template.json이 추가된 설정 PR을 기본 브랜치에 병합합니다.
# 2. GitHub 저장소의 Releases에서 배포할 버전 태그를 만들고 Release를 Publish합니다.
# 3. Release 태그가 조립스페이스에 표시되는 공식 버전이 됩니다. 예: 1.0.1 또는 v1.0.1
# 4. Actions 탭의 "JoripSpace Template Publish" 작업이 초록색으로 완료되는지 확인합니다.
#
# 알아두세요
# - 일반 push나 Release 초안 저장만으로는 배포되지 않습니다. Published Release만 배포됩니다.
# - 별도 API 키나 Secret은 필요하지 않습니다. GitHub OIDC로 저장소와 Release를 검증합니다.
# - Release 태그는 아래에 지정된 기준 브랜치에 포함된 커밋을 가리켜야 합니다.
# - 오류가 나면 Actions 실행에서 실패한 단계와 메시지를 먼저 확인하세요.
# - 이 워크플로와 joripspace-template.json을 삭제하면 이후 업데이트를 배포할 수 없습니다.
name: JoripSpace Template Publish

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

concurrency:
  group: ${JSON.stringify(`joripspace-template-${String(templateId)}`)}
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
      - name: Build Git Bundle and files archive
        shell: bash
        env:
          JORIPSPACE_TEMPLATE_ID: ${JSON.stringify(String(templateId))}
          JORIPSPACE_MANIFEST_PATH: ${JSON.stringify(String(manifestPath))}
          JORIPSPACE_SOURCE_BRANCH: ${JSON.stringify(String(branch))}
        run: |
          set -euo pipefail
          manifest="$GITHUB_WORKSPACE/$JORIPSPACE_MANIFEST_PATH"
          test -f "$manifest" || { echo "joripspace-template.json is required" >&2; exit 1; }
          git show-ref --verify --quiet "refs/remotes/origin/$JORIPSPACE_SOURCE_BRANCH" || { echo "Registered source branch was not fetched" >&2; exit 1; }
          git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$JORIPSPACE_SOURCE_BRANCH" || { echo "Release tag must point to a commit on the registered source branch" >&2; exit 1; }
          source_root=$(node -e 'const m=require(process.argv[1]); const v=String(m.source_root || "."); if (v !== "." && (v.startsWith("/") || v.includes("\\\\") || v.split("/").some((p) => !p || p === "." || p === ".."))) throw new Error("Unsafe source_root"); process.stdout.write(v)' "$manifest")
          if [[ "$source_root" == "." ]]; then
            distribution_sha="$GITHUB_SHA"
          else
            distribution_sha=$(git subtree split --prefix="$source_root" "$GITHUB_SHA")
          fi
          if git ls-tree -r "$distribution_sha" | grep -Eq '^(120000|160000) '; then
            echo "Symlinks and submodules are not allowed in a template release" >&2
            exit 1
          fi
          bare="$RUNNER_TEMP/joripspace-template-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.git"
          bundle="$RUNNER_TEMP/joripspace-template-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.bundle"
          archive="$RUNNER_TEMP/joripspace-template-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.tar.gz"
          stage="$RUNNER_TEMP/joripspace-template-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-stage"
          git init --bare "$bare"
          git push "$bare" "$distribution_sha:refs/heads/main"
          git --git-dir="$bare" bundle create --version=2 "$bundle" refs/heads/main
          git --git-dir="$bare" bundle verify "$bundle"
          mkdir -p "$stage/release"
          if [[ "$source_root" == "." ]]; then
            git archive "$GITHUB_SHA" | tar -x -C "$stage/release"
          else
            mkdir -p "$stage/release/$source_root"
            git archive "$GITHUB_SHA:$source_root" | tar -x -C "$stage/release/$source_root"
          fi
          cp "$manifest" "$stage/release/joripspace-template.json"
          tar -czf "$archive" -C "$stage" release
          file_count=$(git ls-tree -r --name-only "$distribution_sha" | wc -l | tr -d ' ')
          source_bytes=$(git ls-tree -r -l "$distribution_sha" | awk '{ total += $4 } END { print total + 0 }')
          echo "JORIPSPACE_BUNDLE_PATH=$bundle" >> "$GITHUB_ENV"
          echo "JORIPSPACE_ARCHIVE_PATH=$archive" >> "$GITHUB_ENV"
          echo "JORIPSPACE_MANIFEST_PATH=$manifest" >> "$GITHUB_ENV"
          echo "JORIPSPACE_FILE_COUNT=$file_count" >> "$GITHUB_ENV"
          echo "JORIPSPACE_SOURCE_BYTES=$source_bytes" >> "$GITHUB_ENV"
      - name: Publish to JoripSpace
        shell: bash
        env:
          JORIPSPACE_TEMPLATE_ID: ${JSON.stringify(String(templateId))}
          JORIPSPACE_API_URL: "https://api.joripspace.com"
        run: |
          set -euo pipefail
          node --input-type=module <<'JORIPSPACE_SCRIPT'
          // Cloudflare's production bundler may annotate nested function names with
          // __name(). Keep the generated standalone Node script compatible with it.
          const __name = (value) => value;
${publishScript}
          JORIPSPACE_SCRIPT
`;
}

async function inlineTemplatePublishMain() {
  const { readFile } = await import('node:fs/promises');
  const audience = 'https://api.joripspace.com/v1/template-publish/github';
  const templateId = requiredEnv('JORIPSPACE_TEMPLATE_ID');
  const apiUrl = requiredEnv('JORIPSPACE_API_URL').replace(/\/+$/, '');
  const [bundle, archive, manifest] = await Promise.all([
    readFile(requiredEnv('JORIPSPACE_BUNDLE_PATH')),
    readFile(requiredEnv('JORIPSPACE_ARCHIVE_PATH')),
    readFile(requiredEnv('JORIPSPACE_MANIFEST_PATH')),
  ]);
  const form = new FormData();
  form.append('bundle', new Blob([bundle], { type: 'application/x-git-bundle' }), 'template.bundle');
  form.append('archive', new Blob([archive], { type: 'application/gzip' }), 'template.tar.gz');
  form.append('manifest', new Blob([manifest], { type: 'application/json' }), 'joripspace-template.json');
  form.append('file_count', requiredEnv('JORIPSPACE_FILE_COUNT'));
  form.append('source_bytes', requiredEnv('JORIPSPACE_SOURCE_BYTES'));
  const token = await requestOidcToken();
  const response = await fetch(`${apiUrl}/v1/template-publish/${encodeURIComponent(templateId)}/versions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body: form,
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok)
    throw new Error(payload?.error?.message || `JoripSpace publish failed (${response.status}).`);
  process.stdout.write(`JoripSpace template published: ${payload.version || payload.version_id}\n`);

  async function requestOidcToken() {
    const requestUrl = requiredEnv('ACTIONS_ID_TOKEN_REQUEST_URL');
    const requestToken = requiredEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const separator = requestUrl.includes('?') ? '&' : '?';
    const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.value !== 'string')
      throw new Error(`GitHub OIDC token request failed (${response.status}).`);
    return payload.value;
  }
  function safeJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return { error: { message: value.slice(0, 500) } };
    }
  }
  function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  }
}

function templateGithubActionsPublishFile(templateConfig = {}) {
  return buildTemplatePublishWorkflow({
    templateId: String(templateConfig.template_id || '__JORIPSPACE_TEMPLATE_ID__'),
    branch: String(templateConfig.default_ref || 'main'),
    manifestPath: String(templateConfig.manifest_path || 'joripspace-template.json'),
  });
}

module.exports = { buildTemplatePublishWorkflow, templateGithubActionsPublishFile };
