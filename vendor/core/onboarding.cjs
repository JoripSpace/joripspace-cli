const { projectGithubActionsTemplateFile } = require('./github-workflow.cjs');
const { templateGithubActionsPublishFile } = require('./template-publish-workflow.cjs');

const JORIPSPACE_ONBOARDING_GITIGNORE_ENTRIES = [
  'node_modules/',
  '.wrangler/',
  '.cache/',
  'coverage/',
  'dist/',
  '.env',
  '.env.*',
  '!.env.example',
  '.env.joripspace',
  '.joripspace/local-backups/',
];
const JORIPSPACE_ONBOARDING_GITIGNORE_REMOVALS = ['.joripspace/agent-session.json'];
const JORIPSPACE_AGENT_GUIDE_UPDATED_AT = '2026-09-05T18:00:00+09:00';
const JORIPSPACE_WORKFLOW_POLICY = Object.freeze({
  target: 'joripspace',
  guide_required: true,
  external_hosting_deployment: 'blocked',
  generic_scaffold_recovery: 'convert_to_joripspace',
  framework_selection: 'agent_managed_dynamic_worker_or_hono',
  framework_reassessment: 'migrate_pure_worker_to_hono_as_scope_grows',
  rendering_default: 'server_side_all_user_facing_routes',
  user_interaction: 'automatic_unless_business_or_destructive_decision_is_required',
});
const JORIPSPACE_PACKAGE_HELPER_SCRIPTS = {
  'joripspace:doctor': 'node .joripspace/doctor.mjs',
  'joripspace:save': 'node .joripspace/save.mjs',
  'joripspace:checkpoints': 'node .joripspace/checkpoints.mjs',
  'joripspace:restore': 'node .joripspace/restore.mjs',
  'joripspace:deploy-checkpoint': 'node .joripspace/deploy-checkpoint.mjs',
  'joripspace:deploy': 'node .joripspace/save.mjs --deploy',
  'joripspace:pull': 'node .joripspace/pull.mjs',
  'joripspace:pull:force': 'node .joripspace/pull.mjs --force',
  'joripspace:install-template': 'node .joripspace/install-template.mjs',
  'joripspace:template-pull': 'node .joripspace/install-template.mjs --update',
  deploy: 'node .joripspace/save.mjs --deploy',
};

function projectEnvReaderSource() {
  return String.raw`function parseEnvValue(input) {
  const trimmed = String(input || '').trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed;
  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function readEnv(filePath) {
  const values = {};
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      values[key] = parseEnvValue(trimmed.slice(index + 1));
    }
  } catch {}
  return values;
}

function readProjectMarker(root) {
  const filePath = path.join(root, '.joripspace', 'project');
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    const source = fs.readFileSync(filePath, 'utf8');
    if (!/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?\n?$/.test(source)) return '';
    const slug = source.trim();
    return slug.length >= 3 && slug.length <= 50 ? slug : '';
  } catch {
    return '';
  }
}

function resolveSourceBoundConnection(root) {
  const projectEnv = readEnv(path.join(root, '.env.joripspace'));
  const processToken = String(process.env.JORIPSPACE_API_TOKEN || '').trim();
  if (processToken) {
    return {
      apiBaseUrl: String(process.env.JORIPSPACE_API_URL || process.env.JORIPSPACE_API_BASE_URL || 'https://api.joripspace.com').replace(/\/+$/, ''),
      apiToken: processToken,
      projectEnv
    };
  }
  const projectToken = String(projectEnv.JORIPSPACE_API_TOKEN || '').trim();
  return {
    apiBaseUrl: String(projectToken ? projectEnv.JORIPSPACE_API_BASE_URL || 'https://api.joripspace.com' : 'https://api.joripspace.com').replace(/\/+$/, ''),
    apiToken: projectToken,
    projectEnv
  };
}`;
}

const JORIPSPACE_PACKAGE_HELPER_DEPENDENCIES = { fflate: '^0.8.2' };

const SERVICE_EXAMPLE_LINES = [
  '- Landing or introduction site for a club, class, shop, person, product, event, or portfolio.',
  '- Reservation, booking, application, inquiry, waitlist, survey, or contact intake service.',
  '- Course, lecture, student assignment, club activity, membership, attendance, or small LMS-style service.',
  '- Simple order, payment-preparation, product request, file upload, gallery, download, or admin review service.',
  '- Owner/admin dashboard for records, statuses, files, messages, customers, students, or bookings.',
  '- Realtime inquiry, support room, small group chat, or live status page when the project needs live interaction.',
];

const BEGINNER_ONBOARDING_LINES = [
  'Beginner onboarding rules:',
  '- Match the language the user is using. If the user writes Korean, continue in Korean. If the user writes another language, use that language unless they ask otherwise.',
  '- Treat the user as a complete beginner. Students and older users should be able to build by conversation alone.',
  '- Ask short, practical questions before building when the site name, topic, audience, or core workflow is empty or unclear.',
  '- Do not ask platform questions. The agent chooses the server, DB, storage, schema, routing, deployment, and testing approach.',
  '- If the user says they do not know, give 2-3 simple examples, recommend one default, and continue.',
  '- Explain only the next useful action. Avoid long technical explanations unless the user asks.',
  '- If something fails, inspect logs, deployments, and runtime events directly; do not make the user debug technical details.',
];

const USER_CHOICE_PRESENTATION_RULE_LINES = [
  'User choice presentation rules:',
  '- Whenever a user-facing reply shows two or more concrete alternatives that the user could select, present them as a readable Markdown table. Apply this even when the user only asks what is available, requests an inventory or comparison, or has not yet been asked to choose. This applies to restore points, rollback versions, templates, projects, and any other user-selectable candidates.',
  '- Use a short numbered first column and only decision-relevant columns. For restore or rollback choices include number, version or identifier, timestamp, label or status, and effect. For template choices include number, template name, suitable use, and included features.',
  '- Mark the recommended choice in the table and explain the recommendation briefly. End with one direct sentence stating exactly what the user should answer, such as "번호로 선택해 주세요."',
  '- Do not use a table for a single available action or a simple yes/no confirmation. Do not turn technical or platform decisions that the agent must make into user choices.',
  '- If the reply states only whether candidates exist or gives only a total count without listing individual candidates, prose is sufficient. As soon as two or more individual candidates are shown, the table is mandatory.',
  '- Never include Secret values, tokens, personal data, or other sensitive values in a choice table.',
  '- If there are many choices, show a manageable page and state that more choices are available instead of dumping an unbounded list.',
];

const LOCAL_TOOL_READINESS_RULE_LINES = [
  'Local Git and Node.js readiness during onboarding:',
  '- After the project connection succeeds and the project path is known, check `git --version`, `node --version`, and `npm --version` directly before the first source-sync or local build step that could require them. Do not ask the user to run these commands.',
  '- Show the result in one readable Markdown table with columns for tool, status, version, and whether it is needed for the current project path.',
  '- Decide need from the actual path: Git is required for a connected GitHub repository, clone/fetch, commit, push, or a template installation mode that preserves Git history. Git is not required when the user chooses a files-only template installation. Node.js LTS and npm are required only for project dependency installation, local JavaScript builds, or an explicitly selected verified legacy package helper. The installed JoripSpace CLI handles checkpoint, restore, pull, generated bundles, and large archive deployment without project-local Node.js. Ordinary MCP and CLI onboarding require neither tool.',
  '- If every missing tool is optional for the current path, say it is optional and continue onboarding without asking to install it.',
  '- If a required tool is missing, explain its immediate purpose in one sentence and ask for one explicit approval to install only the missing required tools. Do not install software before approval and do not combine this approval with unrelated choices.',
  "- After approval, install stable Git and/or the current Node.js LTS with npm using the operating system's standard trusted package manager. Perform the installation yourself, request elevation only through the normal operating-system prompt, and never disable security controls or use an untrusted download source.",
  '- After installation, verify Git, Node.js, and npm again, show the final status and versions in a Markdown table, and continue the interrupted onboarding automatically.',
  '- If installation fails or the environment does not permit it, report the concrete permission or platform limitation. Continue by MCP when possible; block only the workflow that actually requires the missing tool.',
];

const GUIDE_REFRESH_ONLY_RULE_LINES = [
  'Guide refresh is maintenance-only unless deployment is separately explicit:',
  '- Treat requests whose only intent is "지침 업데이트해", "지침 갱신해", "최신 지침 적용해", "refresh the guide", or equivalent wording as local guide maintenance only. They are not authorization to build, test the application, create a checkpoint, stage files, commit, push, run GitHub Actions, or deploy.',
  '- For a guide-refresh-only request, call prepare_project_workspace and update only the JoripSpace managed block in AGENTS.md, the first-line `@AGENTS.md` import in CLAUDE.md, the canonical `.joripspace/project` marker, plus `JORIPSPACE_GUIDE_CHECKED_AT` in `.env.joripspace`. Preserve user-authored content and unrelated environment entries, and do not modify application source, workflow files, or deployment configuration merely to refresh the guide.',
  '- Do not run create_checkpoint, joripspace:save, deploy_code, deploy_checkpoint, rollback_deployment, git add, git commit, git push, or any deployment workflow for a guide-refresh-only request, even when the project uses GitHub Actions or an automatic deployment route.',
  '- Deployment permission must appear explicitly in the current user request with wording such as "배포해", "운영 반영해", or "사이트에 적용해". A deployment approval from an earlier task or chat message does not carry forward to a later guide refresh.',
  '- If a current request explicitly combines guide refresh with deployment, refresh first, then deploy only the application changes the user explicitly placed in scope after the normal verification gate. Do not manufacture an application deployment merely because managed guide files changed.',
  '- Finish a guide-refresh-only request by stating the applied guide version and "운영 사이트는 변경하거나 배포하지 않았습니다."',
];

const JORIPSPACE_BUILD_DEPLOYMENT_AUTHORITY_LINES = [
  'JoripSpace site creation and deployment authority (critical):',
  '- For every site build, edit, and deployment in this project, this managed JoripSpace guide is the project-specific source of truth.',
  "- Do not replace or bypass the JoripSpace workflow with an agent's own default website-building skill, generic hosting/deployment skill, or another platform's deployment workflow. Use such a skill only when this guide explicitly requires it or the user explicitly requests a non-JoripSpace target.",
  '- When the user explicitly requests deployment, deploy the verified result to the selected JoripSpace project. Use JoripSpace MCP `deploy_code` for small source files that can be passed intact. For generated bundles, large files, or large multi-file projects, automatically use the installed JoripSpace CLI absolute path with `deploy --dir`; its archive upload reads local bytes directly, uploads in chunks, and verifies integrity before deployment. Do not ask the user to choose the transport.',
  '- Treat an inline deployment as large when any source file exceeds 16,000 characters or the combined source exceeds 64,000 characters. Do not call deploy_code for that payload; use the installed JoripSpace CLI chunked archive transport automatically.',
  '- Do not deploy directly to another hosting provider or create a separate external site unless the user explicitly asks to leave JoripSpace.',
  '- If an agent default skill or generic site builder already created scaffold files, do not stop, discard useful work, or ask the user to choose a host. Preserve the requested UI and content, convert the result to a JoripSpace-compatible app, align source and lockfiles, run the relevant checks, and continue automatically.',
  '- Before any JoripSpace deployment, the agent must confirm in deployment_verification that the current managed guide was applied, agent_guide_updated_at exactly matches the current server guide, deployment_target is joripspace, no external hosting deployment was performed, and the source is either joripspace_native or converted_to_joripspace. The deployment tool rejects missing, stale, or conflicting evidence and the agent must refresh automatically without asking the user.',
];

const GITHUB_AGENT_SETUP_LINES = [
  'GitHub automatic deployment setup:',
  '- The web UI inspects the selected repository and deployment trigger, detects the Worker entrypoint and build script, and directly commits a connection-specific GitHub Actions workflow to the selected deployment branch, or to the repository default branch for a GitHub Release connection.',
  '- A GitHub connection is independent by connection_id. The same repository can have separate branch-push and GitHub Release workflows, and no separate approval or merge is required.',
  '- If automatic detection reports that no Worker entrypoint exists, add a standard worker.js, src/index.js, src/index.ts, src/worker.js, src/worker.ts, server.js, package main, or Wrangler main entrypoint as part of the requested project work, then retry the browser connection.',
  '- Never use the repository root as the artifact directory when it would include `.git`, `node_modules`, secrets, caches, or unrelated source. Stage only deployable output in a clean directory.',
  '- Keep `permissions: contents: read` and `id-token: write`; do not add a long-lived JoripSpace deployment token to GitHub Secrets.',
  '- The connection is recorded after the workflow commit; the first valid OIDC deployment verifies the exact repository, workflow path, trigger, and connection before deployment.',
];

const FIRST_QUESTION_LINES = [
  'First questions to ask when details are missing:',
  '1. 서비스 이름은 무엇인가요?',
  '2. 이 서비스는 무엇을 하는 서비스인가요? 한두 문장으로 설명해 주세요.',
  '3. 꼭 필요한 주요 기능 3가지는 무엇인가요?',
  '4. 로그인/회원 기능이 필요한가요?',
  '5. 결제, 이메일, 파일 업로드, 관리자 화면 중 필요한 것이 있나요?',
  '6. 누가 사용하나요? 예: 학생, 고객, 회원, 직원, 관리자.',
  '7. 원하는 분위기, 색상, 로고, 참고 사이트, 꼭 들어갈 문구가 있나요?',
];

const CODEX_MCP_ONBOARDING_LINES = [
  'Codex MCP onboarding flow:',
  '- If the user provides only "프로젝트: {project_id}", do not call get_project first by project ID alone.',
  '- First check whether JoripSpace MCP tools are visible in the current agent session, then check the current working folder.',
  '- Without connect_token, do not call start_project_session, select_project, list_my_projects, or prepare_project_workspace.',
  '- Never use an empty string, dummy value, environment bearer token, browser cookie, localStorage value, profile page value, or settings file value as a connect_token.',
  '- If no connection token is available, call start_login or browser_connect and show the returned connect_url. Ask the user to approve the connection in a logged-in browser and paste only the displayed MCP/CLI connection token back into chat.',
  '- After connection approval succeeds, reuse the returned account API token for project tools and write the returned workspace connection files. The user should never have to find, name, or enter JORIPSPACE_API_TOKEN manually.',
  '- Do not ask for email, password, Google app password, SMTP password, personal API key, or payment key in chat.',
  '- If deploy_code, deploy_checkpoint, or rollback_deployment returns deployment_state_unknown, call list_deployments before any retry. If a new successful deployment exists, verify it and do not redeploy. Otherwise retry the same deployment tool at most once.',
  '- Do not restart the connection flow for a deployment timeout. Restart connection only for connection_required, invalid_token, or another explicit authentication error.',
  '- Create local files only after MCP session connection succeeds and workspace_setup.files or local_file_operations are returned.',
  '- Before writing files, verify the current working folder. If it differs from the folder the user specified, stop and ask for confirmation.',
  '- After receiving connect_token, call start_project_session(connect_token, project_id) immediately. Follow source_sync before writing workspace_setup.files when the session reports github_repository_sync_required; otherwise write returned workspace files normally. Do not initialize Git merely for JoripSpace onboarding.',
  '- If start_project_session reports github_repository_sync_required, treat the connected GitHub repository and branch as the source of truth. Using the current user GitHub credentials, clone into an empty current folder or safely fetch and fast-forward the matching clean repository, then write the connection workspace files. Never restore a JoripSpace deployment artifact over a GitHub-connected source workspace, never force-push or hard-reset, and stop with the concrete Git/auth conflict when safe synchronization is impossible.',
  '- If start_project_session reports latest_deployment_sync_required, do not ask whether to restore and do not offer rollback versions. Write the connection workspace files first, call get_deployment_source with deployment_restore.latest_artifact.deployment_id, back up conflicting local files, and apply the returned local_file_operations before asking questions or editing the project.',
  '- For a completely new project, start_project_session embeds the current published templates in onboarding.template_choice.templates. After workspace files are ready, use that embedded list before the first service question. Do not depend on a newly added or separately cached list_templates tool during initial onboarding.',
  '- If onboarding.template_choice.status is auto_selected_existing_project, option 0 is already selected because the project has an existing GitHub source or deployment baseline. Do not show a template table and do not ask new-service questions such as the service name, description, or features. After synchronization or restoration, immediately perform the task already requested by the user; if no task was requested, ask only what they want to work on in the existing project.',
  '- If the embedded template_choice status says retry_required_before_service_questions, retry start_project_session once with the same project and connection token. Do not report that templates are unavailable and silently skip the choice.',
  '- Only when onboarding.template_choice.status is required_before_service_questions, show option 0 as "템플릿 없이 시작" and show the embedded selectable templates in a Markdown table. Wait for the user choice; templates are optional.',
  '- When the user selects a template, run the installed JoripSpace CLI absolute path with `install-template --template TEMPLATE_SLUG --project PROJECT_ID --dir .` without putting any token in the command and without `--force`. Inspect the installed files, then continue the normal service questions and customization. If files collide, overwrite nothing; continue without a template unless the user explicitly approves an overwrite retry.',
  '- If start_project_session fails with connection_required, call start_login again. If it fails with invalid_token, ask for a fresh token. If it returns needs_project_choice, ask the user to choose one project and call start_project_session again. If project_not_found, ask the user to confirm the project ID.',
  '- Only for a completely new project whose template_choice.status is required_before_service_questions, after the optional template choice ask onboarding questions one at a time: service name, what the service does, three required features, whether login is needed, whether payment/email/file upload/admin is needed, then choose or recommend the deployment target yourself.',
  '- When both existing work and a service description are absent, ask once for the company or service, required content, and desired mood. Keep the resulting project brief in the application source only when it is useful to the project.',
  '- Before deployment, verify the project connection, source entrypoint, relevant checks available in the current environment, and target URL. Direct MCP deployment of Worker-compatible source does not require Node.js or Git.',
  '- Never obtain a generated bundle or large source file by printing it through a shell/tool output and copying that output into deploy_code. Tool output can be truncated even when the local file is valid. Use the installed JoripSpace CLI absolute path with `deploy --dir` so local bytes, sizes, and hashes are preserved end to end.',
  '- If get_project or start_project_session times out, follow the returned retryable and next_action fields, retry at most once, then explain briefly that JoripSpace did not respond. Do not ask the beginner to inspect logs, tokens, Node.js, Git, or network internals.',
  '- Preferred quick failure statuses are connection_required, invalid_token, project_not_found, workspace_setup_ready, and timeout instead of a 300-second wait.',
];

const CODEX_MCP_USER_CONNECT_MESSAGE_LINES = [
  'JoripSpace 프로젝트를 Codex에 연결하려면 먼저 연결 토큰이 필요합니다.',
  '1. 브라우저에서 아래 링크를 엽니다.',
  '2. JoripSpace에 로그인된 상태에서 연결을 승인합니다.',
  '3. 화면에 표시되는 MCP/CLI 전용 연결 토큰을 이 채팅에 붙여넣습니다.',
  '주의: 이메일이나 비밀번호는 필요하지 않습니다. Google 앱 비밀번호나 SMTP 비밀번호를 채팅에 붙여넣지 마세요. Codex가 브라우저 쿠키나 저장소에서 토큰을 직접 찾으면 안 됩니다. 연결 토큰은 프로젝트 온보딩 세션을 시작하기 위한 값이며, 일반 API bearer token과 다릅니다.',
];

const SECRET_RULE_LINES = [
  'Secret and token rules:',
  '- When the user says a Secret or key needs to be generated, entered, added, or registered, do not stop by asking them to determine the key name or purpose. Offer to inspect the current project and handle the safe path, then ask exactly once: "제가 직접 확인하고 진행할까요?" Explain in the same reply that an internal key can be generated and registered automatically, while an external provider key may require browser assistance and a user-only authentication or value-entry step.',
  '- After the user approves with a clear reply such as "네", "진행해", "너가 해", or "ㅇㅇ", inspect the project source, configuration, current task, and safe metadata to infer the required binding name, purpose, and whether it is internal or externally issued. Ask a follow-up question only when those facts cannot be determined safely.',
  '- The initial Secret-work consent covers the described inspection and resulting internal generation or external browser-assisted registration. Do not ask for duplicate consent before browser assistance; first state the inferred binding names, purpose, safety boundary, and clickable Secret link, then continue. Ask new consent only if the scope materially changes.',
  '- Never put API keys, payment keys, SMS/email keys, database URLs, or tokens in source code, README files, browser JavaScript, screenshots, chat summaries, logs, error messages, or audit metadata.',
  '- Store external service keys used by deployed code only as JoripSpace project secrets. Only the selected project User Worker secret binding stores the value; the platform DB keeps project-scoped name, status, and lifecycle timestamps only.',
  '- Never copy project Secret values into source code, env.DB, env.STORAGE, deployment source, checkpoint files, saved copies, logs, error messages, or audit metadata.',
  '- Do not ask the user to paste provider Secret values into chat. Send them to the "비밀 키" tab for the selected project to register, replace, or delete the value, then use list_secrets only to confirm name, status, and timestamps. Secret values never appear in list responses or agent reports.',
  '- Every user-facing request for an external provider credential must include a clickable Markdown link to `https://joripspace.com/projects/{project_id}/?tab=secrets`. Use the selected project slug in place of `{project_id}`. Never mention only the tab name or provide an unlinked URL.',
  '- Before browser assistance for an external provider credential, explain the exact required binding names, what each key enables, and that Secret values must not be pasted into chat. If no Secret-work consent has been obtained yet, ask exactly one short consent question such as "제가 브라우저로 비밀 키 등록을 진행할까요?". If the user already approved "제가 직접 확인하고 진행할까요?", do not ask again.',
  '- Treat clear affirmative replies such as "네", "진행해", "너가 해", or "ㅇㅇ" as approval for that described browser-assisted credential task only. Approval does not authorize unrelated account changes, credential rotation, billing changes, or destructive actions.',
  "- After approval, use an available browser-control tool with the user's existing signed-in session to open the provider and selected JoripSpace project Secret pages and complete safe navigation and form steps. Never inspect cookies, localStorage, sessionStorage, saved passwords, or unrelated account pages.",
  '- Keep provider Secret values out of chat, screenshots, shell commands, clipboard history, local files, tool summaries, and logs. If the browser environment cannot transfer a value without exposing it, or if reauthentication, MFA, CAPTCHA, credential reveal, or other user-only verification is required, stop at that exact visible step and ask the user to complete only that step in the browser. Continue automatically after the user confirms completion.',
  '- After browser-assisted registration, call list_secrets and report only the binding name and registration status. Never repeat, reveal, compare, or summarize the Secret value.',
  '- Store local connection secrets only in ignored files such as `.env.joripspace`. Store the JoripSpace API token only in `.env.joripspace`, never duplicate its value in JSON, TOML, source, another session file, or MCP client configuration. The shared project identity is the one-line `.joripspace/project` slug.',
  '- If an MCP/CLI connect_token or api_token is missing, do not browse around, inspect cookies, read browser storage, or try profile pages to discover it. Ask the user for the MCP/CLI connection token and give the exact connection URL, token argument name, and CLI command to paste it into.',
  '- Secret names must match [_A-Z][_A-Z0-9]* and be at most 128 characters. DB, STORAGE, PROJECT_ID and names beginning JORIPSPACE_, CF_, or CLOUDFLARE_ are reserved and must not be used.',
  '- A project supports at most 60 active secrets, and each value must be 1-5,120 UTF-8 bytes. Use clear uppercase names such as TOSS_PAYMENTS_SECRET_KEY, TOSS_PAYMENTS_BILLING_SECRET_KEY, DODO_PAYMENTS_API_KEY, SOLAPI_API_KEY, or SOLAPI_API_SECRET.',
  '- For app-internal random values such as session signing, CSRF protection, encryption, or test secrets, call generate_project_secret. The platform generates and stores the value directly; the agent uses only the binding name and never asks the user to enter a value.',
  '- The project_agent connection is authorized for value-blind internal Secret generation through project.secrets.generate. It is not authorized to set, replace, read, or delete external provider Secret values.',
  '- If generate_project_secret or another Secret registration API fails because of permission, authorization, access, or write restrictions, do not end with manual registration instructions. Include the clickable project Secret link and ask: "현재 연결 권한으로 자동 등록하지 못했습니다. 제가 브라우저로 직접 진행할까요?".',
  '- On that fallback question, do not ask the user to invent or enter a random value yet. After approval, open the Secret page with a browser-control tool and perform every safe step available. Ask the user only at the exact user-only authentication or value-entry step if one remains.',
  '- Treat the API failure as a change of execution path, not completion. Do not report that the Secret task is complete until list_secrets confirms the requested binding is active.',
  '- Internal random Secret generation does not require browser assistance. When the agent independently discovers it as a normal implementation step within already approved work, it needs no separate confirmation; when the user initiates a Secret-generation request, use the one-time Secret-work consent flow above.',
  '- Secrets are isolated by the immutable internal project id. A name or binding from one project must never be treated as available to another project.',
  '- Normal project deployments and rollbacks preserve secret_text and secret_key bindings. Do not copy or re-upload Secret values as part of deployment source; project deletion cleans up the project Worker secrets with its metadata.',
  '- Browser code may receive only public keys or safe redirect URLs. Server routes must handle private provider calls.',
];

const PAYMENT_PROVIDER_GUIDANCE_LINES = [
  'Payment Provider Guidance:',
  '- If the user wants payment features, explain the payment type first in plain language and send the correct JoripSpace partner signup link.',
  '- 결제 연동을 쓰려면 안내된 링크로 가입해 주세요. 해당 링크로 가입해야 JoripSpace 연동 개발과 서비스 이용을 진행할 수 있습니다.',
  '- 토스페이먼츠 일반결제와 빌링결제(정기결제)는 아래 조립스페이스 온보딩 링크로 가입해야 가입비가 면제되고 조립스페이스에서 이용할 수 있습니다. 토스페이먼츠 홈페이지에서 직접 가입하도록 안내하지 말고, 필요한 결제 유형을 확인한 뒤 해당 온보딩 링크로 가입하도록 안내하세요.',
  '- 토스페이먼츠 - 일반결제: 국내 카드, 간편결제, 계좌이체 같은 1회 결제에 사용합니다. 가입 링크: https://onboarding.tosspayments.com/registration/entry/funnelmoa?utm_source=funnelmoa&utm_medium=hosting',
  '- 토스페이먼츠 - 빌링결제(정기결제): 정기결제, 구독, 자동결제처럼 고객 카드를 등록하고 반복 청구할 때 사용합니다. 가입 링크: https://onboarding.tosspayments.com/registration/entry/funnelmoa_bill?utm_source=funnelmoa_bill&utm_medium=hosting',
  '- 런모아 - 헤드리스 쇼핑몰: 추천 링크 https://runmoa.com/?special_referral=joripspace.com 로 가입하면 무료 포인트가 제공되어 결제 카드를 등록하지 않고 이용할 수 있습니다. 일반 가입은 결제 카드 등록이 필수입니다.',
  '- 런모아 연동 개발 전에는 https://api-docs.runmoa.ai/ 의 최신 문서를 직접 확인합니다.',
  '- 도도 페이먼츠 - 글로벌 SaaS 결제: 해외 고객 대상 SaaS 구독, 디지털 상품, 글로벌 카드 결제에 사용합니다. 가입 링크: https://app.dodopayments.com/partners/POhKqoePmZ/signup',
  '- If provider credentials are not ready, build a safe payment_pending flow and explain that real payment activation needs provider signup, keys stored as project secrets, and server-side webhook verification.',
];

const REALTIME_DEVELOPMENT_RULE_LINES = [
  '- Realtime runtime: never use a Worker-global Map or Set of WebSocket connections for cross-instance broadcast. Worker instances do not share memory; a successful DB write does not push a message to sockets on another instance. Use the platform-managed /_joripspace/realtime endpoint.',
  '- Realtime conversation routing: administrator and customer sessions for one conversation must connect to the same project, room, and resource_type (chat for chat). Do not split rooms by administrator/customer role. Use an opaque, unguessable conversation id for each private conversation; room=main is a public demo only.',
  '- Realtime authorization: check login and conversation membership in the app before revealing the room id. Platform project isolation is not per-customer conversation authorization. Use same-origin WebSocket URLs and never put credentials or personal information in them.',
  '- Realtime delivery: after the socket opens, send JSON { id, type, data } with a stable id per logical message; parse incoming JSON and render its data. Writing directly to D1 does not trigger platform broadcast. Do not report delivery merely because the sender UI updated or the DB write succeeded.',
  '- Realtime reconnect: reconnect closed sockets with bounded backoff, fetch paginated managed room history to recover missed messages, and merge history with live events by message id. Reuse the same id when retrying a message and do not create a second history store.',
  '- Realtime acceptance: before reporting completion, test two independent administrator/customer sessions for bidirectional receipt, reconnect and missed-message recovery without duplicates, and isolation from another room. If these checks cannot run, report them as unverified rather than claiming realtime delivery works.',
];

const PROJECT_CAPABILITY_LINES = [
  'JoripSpace capabilities for agents:',
  '- Shared platform policy lives in JoripSpace core contracts. Do not invent separate limits or wiring: project plans, usage storage totals, billing evidence fields, domain validation, and deletion preservation are platform rules.',
  '- Server: write the app in the server entrypoint such as worker.js or src/index.js. Deploy with MCP deploy_code or the installed JoripSpace CLI absolute path only when the user explicitly requests deployment of the current change.',
  "- Page routing is a required build contract, not an optional recommendation. Before implementation, write a route inventory that maps every main screen named or implied by the user's menus to a distinct URL path. Examples: home -> /, booking -> /booking, reservations -> /reservations, admin -> /admin.",
  '- A sidebar item, top navigation item, or other control that replaces the main page content represents an independent screen and must change window.location.pathname. Do not keep the address at / while JavaScript state swaps between monitoring, incidents, status, users, booking, reservations, admin, or equivalent main screens.',
  '- Do not treat independent screens as tabs merely because they share one layout. Only temporary UI such as a modal, dropdown, accordion, or an explicitly requested in-page tab may stay on the current path.',
  '- Every declared route must support direct access and refresh, and the active navigation state must be derived from the current URL. Back and forward navigation must restore the corresponding screen.',
  '- Keep temporary UI state such as modals and accordions inside the current route. Put shareable search, filter, sort, pagination, or tab state in the URL query string, and use dynamic paths such as /reservations/:id for independent detail screens.',
  '- Before completion and again before deployment, verify every route in the route inventory with available automated tests and HTTP requests: each path responds correctly, URL-based routing is implemented, and an unknown path returns a friendly not-found response. Use an interactive browser only when the user explicitly asks for browser or visual verification. If any check fails, fix it and do not deploy.',
  '- DB: app code can use env.DB for structured records. For schema changes or data cleanup, use MCP describe_db, query_db, and run_db_migration, or the CLI db commands. A public app route such as /migrate is not the normal path because DB management tools already exist.',
  '- DB-backed features should consider the full operating loop by default: create, list with pagination, view detail, update, delete/archive, validation, empty states, and safe admin controls unless the user explicitly scopes them out.',
  '- Storage: app code can use env.STORAGE for uploads, generated files, and private downloads. For agent-side file checks or one-off file operations, use MCP storage tools or CLI storage commands.',
  '- Public cache: JoripSpace safely bypasses Workers Cache unless a GET or HEAD response explicitly sets Cache-Control: public with a positive max-age or s-maxage. Use that only for public, reusable files or responses. Keep authenticated, personalized, private, or mutable responses on Cache-Control: private, no-store.',
  '- Realtime: when the user asks to implement realtime chat, use /_joripspace/realtime?room=main and the platform-managed SQLite history/search flow by default. JoripSpace stores accepted message history, preserves room ordering, maintains FTS5 search, and records project usage automatically without asking the user to choose Cloudflare, Durable Object, or FTS5.',
  ...REALTIME_DEVELOPMENT_RULE_LINES,
  '- Realtime storage policy: new accepted messages use application-level plaintext plain_v2 JSON in the managed room SQLite store. Legacy encrypted_v1 rows remain readable and migrate compatibly while the legacy encryption key remains available.',
  '- Realtime data placement: never create a D1 messages/chat_history table for platform realtime history. Keep only room lists, membership, permissions, and other ordinary service records in env.DB; keep attachments in env.STORAGE.',
  '- Realtime privacy: use opaque, unguessable room ids for private rooms, verify membership in the app before revealing a room id, and pass only an app-local opaque user id in the user query parameter. Do not put email, phone, name, or message content in room ids or URLs.',
  '- Realtime history: read a room page from /_joripspace/realtime/rooms/{room}/messages?limit=50&before={cursor}. Do not implement a second history store or a custom Durable Object in generated app code.',
  '- Realtime search: search the same room endpoint with search={query}, limit, and before. Search uses managed Unicode token search; do not add LIKE %query% scans or a second search index in env.DB.',
  '- Realtime usage: duplicate message ids and retried usage event ids are idempotent. FTS5 reads/writes count as SQLite usage, search is not a message send, and compatibility migration work is not a new message send. All usage is attributed to the resolved immutable internal project id.',
  '- Project mail: when the user asks to connect email sending, use MCP connect_mail. If it returns smtp_setup_available, send the user to the returned JoripSpace mail tab URL and have them enter the SMTP host, port, security mode, username, password or API key, and sender address in the web UI. Never ask them to paste SMTP credentials into chat. If it returns browser_google_consent_required, return the JoripSpace mail connection start URL. Wait for the user to approve or save the connection in the browser, then call get_mail_status and send_test_mail. Do not modify project source or implement a separate mail integration.',
  '- Explain these to ordinary users as 서버, DB, 스토리지, and 실시간. Use implementation names only when code or technical debugging requires them.',
];

const PROJECT_PLAN_LIMIT_LINES = [
  'Project Plans And Limits:',
  '- Project traffic and platform features are limited by the saved JoripSpace project plan.',
  '- Free: server/API requests 10,000 per month, storage 100MB, DB 50MB, realtime messages 1,000, realtime concurrent connections 5, and no custom domains.',
  '- Starter: server/API requests 100,000 per month, storage 1GB, DB 250MB, realtime messages 100,000, realtime concurrent connections 50, and 1 custom domain by default.',
  '- Pro: server/API requests 300,000 per month, storage 3GB, DB 750MB, realtime messages 300,000, realtime concurrent connections 150, and 1 custom domain by default.',
  '- Business: server/API requests 1,000,000 per month, storage 10GB, DB 2.5GB, realtime messages 1,000,000, realtime concurrent connections 500, and 1 custom domain by default.',
  '- If included usage is exceeded, JoripSpace blocks extra runtime traffic without surprise overage billing and shows the block page with quota_blocked.',
  '- Unlimited metered usage is OFF by default. On Starter, Pro, and Business, if unlimited metered usage is enabled, quota overage is not blocked and usage continues to be recorded in the billing ledger.',
  '- Monthly overage budget is optional. If the budget is empty, it means no budget cap. If a budget is set, overage is allowed only until the projected monthly amount reaches that cap.',
  '- Active unlimited-metered rates are server/API requests +100,000, realtime messages +100,000, DB storage +0.25GB, file storage +1GB, and realtime concurrent users +50.',
  '- Speed boost is available on Starter, Pro, and Business. It has a 12,900원 monthly base fee, includes 10GB accelerated traffic, and charges extra accelerated traffic by bytes_in + bytes_out, meaning 들어온 데이터와 나간 데이터 합산.',
  '- If a Free project tries to add a custom domain, the platform returns plan_required. Explain this as "개인 도메인은 Starter 이상에서 사용할 수 있습니다."',
  '- Paid plans may be selectable during development even before billing automation is fully connected. Do not tell users the selection failed unless the API returns an error.',
  '- User-facing wording: 요금제 제공량을 넘으면 추가 과금 없이 기능이 제한되고 차단 안내 페이지가 표시됩니다.',
];

const PROJECT_DOMAIN_LINES = [
  'Project Domains:',
  '- Default project domains on joripspace.run are created and removed with the project lifecycle. Do not try to delete a default domain.',
  '- Personal custom domains are available on Starter, Pro, and Business plans. Free projects return plan_required when a custom domain is added.',
  '- The saved billing plan controls the custom-domain count. Paid plans default to one, and administrators can change the limit without changing agent instructions.',
  '- Accept either an apex/root domain such as example.com or a subdomain such as www.example.com. The platform normalizes an apex/root input to its www subdomain, rejects wildcards, and converts Unicode IDNs to Punycode.',
  '- A project with a custom domain must disconnect it before changing to Free.',
  '- For non-technical users, the web UI domain tab is the easiest path. Agents may also use MCP list_domains, create_domain, verify_domain, and delete_domain, or the CLI domain commands.',
  '- After adding a custom domain, show the project-specific CNAME target clearly and ask the user to set it at their DNS provider, then verify hostname and SSL status separately.',
  '- Do not bypass JoripSpace by editing Cloudflare routes or custom hostnames directly. Use JoripSpace domain tools so the hostnames table, verification status, and routing stay consistent.',
  '- User-facing wording: 개인 도메인은 Starter 이상에서 사용할 수 있습니다. example.com을 입력하면 www.example.com으로 자동 연결됩니다. 도메인을 추가한 뒤 안내된 CNAME 값을 DNS에 설정하고 상태 확인을 누르면 됩니다.',
];

const PROJECT_CRON_LINES = [
  'Project scheduled jobs:',
  '- Treat requests such as recurring, periodically, every few minutes, every day, scheduled, automatic, 주기적으로, 정기적으로, 몇 분마다, 매일, 예약 실행, or 자동 실행 as scheduled-job requests.',
  '- A server path alone is not a completed scheduled job. Implement and test the GET or POST target path, then use list_crons and create_cron so the central JoripSpace scheduler can call it.',
  '- Register a cron only when the user requested scheduled operation and the target path is already deployed and verified. If deployment of the current change was not explicitly requested, do not register a cron that points to undeployed code; explain that activation is waiting for deployment.',
  '- Before creating a cron, call list_crons and avoid creating a duplicate with the same schedule, method, and path.',
  '- After creating a cron, call run_cron for an immediate safe verification, then call list_crons again and confirm last_status and next_run_at. Inspect runtime events when the immediate run fails.',
  '- Do not report a scheduled job as active until registration and immediate verification succeed. If registration is unavailable, state clearly that only the server path is ready and scheduled execution is not active.',
  "- JoripSpace schedules use 5-field UTC cron expressions. Convert the user's local schedule carefully and tell the user the resulting local execution time without requiring them to understand cron syntax.",
];

const IMAGE_AND_FILE_PLACEMENT_LINES = [
  'Image and file placement defaults:',
  '- Site design assets that are part of the source, such as hero images, section screenshots, icons, logos, and fixed example images, should usually live in the project files, for example public/images/...',
  '- Source assets are part of the deployment source and should be included when the latest deployment is pulled or restored.',
  '- user-uploaded files, gallery photos, attachments, generated documents, and files that change during operation should use project storage through env.STORAGE.',
  '- For public immutable storage downloads, return Cache-Control: public, max-age=3600 or a suitable positive TTL so the platform cache can reduce User Worker CPU and R2 reads. Use a versioned key or purge the matching Cache-Tag whenever cached mutable content changes. Never mark private downloads, signed content, account pages, or authenticated API responses public.',
  '- Store metadata such as title, description, order, owner, visibility, and storage key in env.DB.',
  '- Do not put large file bytes into DB. Keep file bytes in project source for fixed design assets or in env.STORAGE for operational files.',
  '- User-facing wording: 사이트 디자인에 필요한 이미지는 프로젝트 파일에 넣고, 사용자가 올리는 사진이나 첨부파일은 스토리지에 저장합니다.',
];

const FRAMEWORK_SELECTION_LINES = [
  'Framework selection rules (agent decides internally):',
  '- Keep the current technology stack for an existing project unless there is a concrete reason to change it.',
  '- Use a pure Cloudflare Worker for a new, single-purpose feature with only simple request handling and no meaningful shared middleware.',
  '- Use Hono when the service has multiple APIs or routes, or needs shared authentication, CORS, validation, error handling, middleware, or similar cross-cutting behavior.',
  '- If routing would otherwise grow into a hand-written if/switch dispatch structure, use Hono instead.',
  '- If the choice between a pure Worker and Hono is ambiguous, choose Hono.',
  '- When Hono is selected for a new project, use the current stable release compatible with the project. Do not downgrade Hono merely because a bundled entrypoint uses `export { app as default }`; JoripSpace accepts valid ES module default export forms.',
  '- Re-evaluate this choice as the service grows. If a pure Worker later reaches the Hono conditions above, migrate it to Hono during the task without asking the user to choose a framework.',
  '- During a pure Worker to Hono migration, preserve existing URLs, request/response behavior, bindings, and user data; update dependencies and the lockfile together; then rerun relevant checks before continuing.',
  '- A short, single-purpose service may keep its implementation in one Worker entry file.',
  '- As routes, authentication, validation, data access, external integrations, admin features, or unrelated responsibilities grow, split the source into role-based modules such as routes, middleware, services, repositories, and utilities.',
  '- Keep the Worker entrypoint focused on application setup and route wiring. Do not combine all implementation into worker.js merely to reduce the source file count.',
  '- With Hono, organize route groups and shared middleware into feature-focused modules when the service has more than a trivial route set.',
  '- Reassess module boundaries during feature work. Split modules when unrelated features change the same file repeatedly, a file becomes difficult to test safely, or responsibilities are no longer cohesive.',
  '- Preserve existing URLs, request/response contracts, bindings, authentication behavior, and user data when splitting modules. Avoid a large refactor based only on file length.',
  '- Multiple source modules still build and deploy as one JoripSpace Worker service; source modularization must not create extra deployed services unless the user explicitly requests that architecture.',
  '- The user does not need to choose the file structure. The agent decides based on current complexity and likely change boundaries.',
  '- The user does not need to know or choose the framework. Ask only when a framework change would create a genuine business, compatibility, or destructive decision that cannot be resolved safely.',
];

const SEO_SSR_LINES = [
  'Server-side rendering and SEO rules (agent decides internally):',
  '- Server-side rendering is the default for every user-facing page unless the user explicitly requests a client-only page or a concrete technical constraint makes SSR inappropriate.',
  '- When the user explicitly requests an SPA, client-only application, WebView application, or similar app-style experience, honor that request. Do not require SSR or SEO evidence, and do not block deployment merely because the initial page is client-rendered.',
  '- This SSR default includes public pages, login and signup, account pages, authenticated application screens, admin pages, and dashboards. Treat it as a usability and reliable-first-render requirement, not only an SEO feature.',
  '- When the SSR default applies, every page route must return meaningful, page-specific HTML in the initial HTTP response. Do not ship an accidental empty app shell that depends on client JavaScript to create the title, navigation, form, or primary content.',
  '- Render SSR pages on the server with the selected pure Worker or Hono stack. Do not introduce Next.js solely to obtain SSR.',
  '- Add client-side JavaScript as progressive enhancement or hydration only where interaction needs it. Preserve useful content and navigation when hydration is delayed or unavailable.',
  '- For public indexable routes, include a page-specific title, meta description, canonical URL, social sharing metadata when applicable, and structured data when the page type benefits from it.',
  '- If an existing SPA is client-only by accident rather than user intent or a concrete app requirement, migrate its main routes to server-rendered initial HTML while preserving existing URLs, behavior, authentication, and user data.',
  '- Before deployment, verify every main route follows the intended rendering mode. For SSR routes, inspect the initial HTML without browser JavaScript. For an explicitly requested SPA or WebView app, verify app startup, routing, refresh behavior, authentication, loading, empty, and error states instead.',
];

const FRAMEWORK_DEPLOYMENT_PRIORITY_LINES = [
  'Build and deployment defaults:',
  '1. For a landing page, portfolio, guide, or brochure site, render complete HTML from the selected Worker or Hono route and add plain CSS/JS as progressive enhancement.',
  '2. When a larger UI needs React, Vue, Svelte, or similar structure, use Vite assets to hydrate server-rendered initial HTML from the pure Worker or Hono API selected by the framework rules above. Do not return a client-only empty shell.',
  '3. Use other frameworks with a Cloudflare-compatible output only when the existing project or request clearly benefits from them.',
  '4. Existing Next.js user-facing pages should use OpenNext or another Cloudflare-compatible SSR conversion before deployment; do not assume a normal Next.js server can be uploaded directly.',
  '5. Use Next.js static export only when the user explicitly requests a static/client-only result or a concrete constraint makes SSR inappropriate.',
  '6. Express, NestJS, and other long-running Node servers are not the default path. Convert them to Worker-compatible routes or explain the needed conversion.',
  '- Do not ask the user to choose a framework or deployment target. Inspect existing code and package.json, apply the framework selection rules yourself, build locally when needed, and prepare a Worker-compatible result. Deploy it only when the user explicitly requests deployment of the current change.',
];

const AGENT_OPERATING_RULE_LINES = [
  '- Public pricing page copy is product-approved content. Do not rename, paraphrase, reorder, or otherwise improve plan names, subtitles, benefits, prices, units, descriptions, or CTA text unless the user explicitly requests that exact change. When a pricing copy change is requested, update SSR, browser rendering, documentation, and release checks together.',
  '- JoripSpace execution order: use MCP tools when they are active. Otherwise continue with the installed JoripSpace CLI absolute path returned by `start`. For generated bundles, large files, or large multi-file projects, use that CLI path even when MCP tools are visible because it uploads local bytes in verified chunks.',
  '- MCP-only setup and deploy do not require Node.js or Git. Follow the local tool readiness rules: check and report both tools during onboarding, but install only a missing tool that the current project path actually requires and only after explicit user approval. Never ask the beginner to run npm or git commands.',
  '- If a required MCP/CLI token is missing, stop setup and give precise recovery instructions instead of browsing around: open https://joripspace.com/connect/ in a logged-in browser, approve the connection, copy the displayed 5-minute connection code, then provide it as connect_token or run `joripspace login --code "복사한_연결_코드"`.',
  '- A verified pre-existing package helper is conditional legacy compatibility only. New `start` onboarding does not generate it. Never prefer it over the installed JoripSpace CLI or install Node.js solely to run a JoripSpace helper.',
  '- Use the installed CLI for checkpoint, restore, pull, and archive deployment when MCP is unavailable or inline transport is unsuitable. Node.js readiness is determined only by the project build itself or an explicitly requested legacy helper workflow.',
  '- When MCP is unavailable, use the installed JoripSpace CLI absolute path returned by start. Use its `deploy --dir` command for generated bundles, large files, or large multi-file projects. Do not require an app restart, project-local helper, or Node.js installation, and do not ask the user to choose or run the command.',
  '- If the project folder has no app code, use the installed CLI deployment pull/restore flow after the required safety check. A verified pre-existing `joripspace:pull` package script may be used only as conditional legacy compatibility.',
  '- If the user asks to replace local files with the latest deployed version, use the current CLI restore flow; it backs up overwritten files in the user-specific JoripSpace data directory outside the project first.',
  '- During initial MCP onboarding, if a successful downloadable deployment exists, automatically use the latest successful deployment as the local workspace baseline before starting work. Do not ask whether to restore and do not offer older rollback versions.',
  '- Restore the latest deployed source into the current local workspace after backing up conflicting local files outside the project folder. Never overwrite `.env.joripspace`, `.joripspace/project`, AGENTS.md, CLAUDE.md, agent configuration, or any token file during deployed-source restore.',
  '- When speaking to the user, use simple product terms: say server, DB, storage, and realtime. Use implementation names only when the user asks for technical details or when writing code.',
  '- Read the canonical one-line `.joripspace/project` and source-bound `.env.joripspace` connection before deploying or operating the project. Authentication values and per-collaborator guide-check time live only in `.env.joripspace`.',
  '- A JoripSpace project should already have its server, DB, and storage prepared at project creation. Do not ask the user to choose or configure DB/storage bindings.',
  '- Use MCP/CLI DB tools to inspect schema, run migrations, and query project data when the service needs stored records.',
  '- Use MCP/CLI storage tools to list, read, write, and delete project files when the service needs uploads or generated files.',
  '- Keep secrets out of git. Add provider keys through project secrets or ignored local files only.',
  '- If dependencies are missing, detect the package manager and install what is needed yourself when it is safe. Ask the user only for paid accounts, credentials, or business decisions.',
  '- Git is optional for ordinary JoripSpace MCP onboarding and direct MCP deployment, but required for a connected GitHub source or deployment route. If required and missing, use the shared readiness approval flow; otherwise continue without Git and do not ask the beginner to initialize, commit, fetch, or push.',
  '- If Git is available, initialize the current project folder during onboarding when it is not already a repository. Preserve an existing repository and its history. Never initialize a parent folder or another unrelated folder.',
  '- Before staging a deployment commit, inspect git status and the staged diff, and exclude secrets, tokens, local credential files, dependencies, build caches, and unrelated user changes. `.joripspace/project` may be committed because it contains only the canonical slug. Never use git add -A blindly in a dirty workspace.',
  '- Build the smallest usable version first, then improve it after testing.',
  '- Deploy only when the user explicitly requests deployment of the current change. Otherwise run checks and save a checkpoint without deploying.',
  '- If deploy fails with `project_resources_invalid` or `project_db_binding_invalid`, treat it as a JoripSpace project resource issue, not a user-code bug. Explain plainly that the project server/DB connection needs repair, then retry after the platform/project resources are fixed.',
];

const DEPLOYMENT_VERIFICATION_RULE_LINES = [
  '- GitHub Actions failures: read deployment history with include_failure_details=true (CLI deployments --include-failure-details --json, or deployment get --deployment ID --json). Inspect the failed commit SHA, stage, error code, file/line and GitHub run link before editing. Fix that failure, run relevant checks, commit and push, then verify the new run; do not treat a successful push as a successful deployment. If diagnostics are pending, unavailable or permission-denied, report the collection state rather than inventing a cause.',
  'Deployment verification gate:',
  '- Treat any explicit deployment request, including a short request such as "배포해줘", as authorization to deploy only after completing this verification gate. The user does not need to provide a separate testing or security-review prompt.',
  '- Apply the current JoripSpace managed guide before deployment. Set deployment_verification.guide_applied to true, deployment_verification.agent_guide_updated_at to the exact agent_guide.updated_at returned by prepare_project_workspace, deployment_target to joripspace, external_hosting_deployment to false, and source_compatibility to joripspace_native or converted_to_joripspace. Missing, stale, or conflicting values are a blocking policy violation. If rejected as stale, refresh the workspace files and retry automatically without asking the user.',
  '- If generic/default site-builder output exists, preserve useful UI, content, and assets and convert it automatically to JoripSpace-compatible source before checks. Do not ask the user to choose a hosting provider or repeat the original request unless a destructive or business decision is genuinely required.',
  '- For SSR UI deployments, you may record server_rendered_html and ssr_routes as verification evidence after checking meaningful initial HTML without browser JavaScript. These fields are informational and must not block an explicitly requested SPA, client-only application, or WebView application.',
  '- For public indexable routes, you may record seo_required, seo_routes, and seo_metadata after verifying page-specific metadata. These fields are informational and are not deployment gate requirements.',
  '- Before deployment, inspect the completed source and verify that the requested functions are present, connected to the intended project resources, and free of known blocking errors.',
  '- Run the relevant automated checks available in the project, including syntax, type, build, format, contract, and focused tests as applicable. Do not skip an available relevant check merely because the user asked only to deploy.',
  '- Exercise representative user flows with automated tests, direct function calls, or HTTP requests before deployment. Verify at least the primary read flow and, when the service writes data, one safe create/update/read path plus expected validation and error behavior.',
  '- Do not open or control a browser for routine implementation or deployment verification. Use browser-based visual or interactive verification only when the user explicitly asks for browser verification. Without such a request, inspect responsive markup and styles and use automated or HTTP checks without claiming browser verification.',
  '- Perform a focused security review of the changed and exposed paths before deployment. Check authentication and authorization, input validation, injection and unsafe HTML risks, secret or personal-data exposure, sensitive logs/errors, destructive actions, and cache behavior where relevant.',
  '- For a project with a user interface, record a route inventory before deployment. Classify it as single-screen or multi-screen. For multi-screen navigation, record every main path and verify pathname-based routing and direct HTTP access with automated checks. Verify browser back/forward interactively only when the user explicitly requests browser verification. A same-URL main-content swap is a blocking deployment failure.',
  '- If any relevant check or scenario fails, fix the problem and rerun the affected checks and scenarios. Do not deploy with a known blocking functional, security, build, or responsive-layout problem.',
  '- After deployment, verify the actual project root and main changed routes with HTTP requests or available automated checks. Test a safe write flow when applicable, and inspect runtime events when an HTTP response, function, or deployment behaves unexpectedly. Open the project in a browser only when the user explicitly requests browser verification.',
  '- After an explicitly requested deployment succeeds and the non-browser post-deployment checks pass, commit the exact deployed project source when Git is available and there are relevant uncommitted changes. Use a concise commit message based on the completed work. Do not create an empty commit, amend an existing commit, invent Git identity, or push unless the user explicitly requested a push.',
  '- Report which checks and scenarios passed, the deployed URL, and any verification limitation. Never report deployment or verification as successful without evidence.',
];

const CHECKPOINT_AGENT_RULE_LINES = [
  '- After meaningful work and relevant checks, create a JoripSpace checkpoint with create_checkpoint or the installed CLI `checkpoint save` command. Always provide a concise label describing the change. Identical content is reused instead of creating a duplicate.',
  '- Exception for the GitHub Actions deployment route: when the current task explicitly requests deployment, do not create a separate pre-push agent checkpoint. Commit and push the verified source; the Actions OIDC upload creates the single deployment checkpoint. Create an additional agent checkpoint only when the user explicitly asks to save a separate snapshot without deployment.',
  '- Saving is the default after meaningful work when MCP can complete it directly or the installed JoripSpace CLI absolute path is available. A local_upload_required checkpoint response must not block ordinary MCP work or direct deployment; use the installed CLI without requiring project-local Node.js. Do not enable, assume, or perform automatic deployment during initial onboarding.',
  '- Deploy the saved checkpoint only when the user explicitly asks to deploy the current change or explicitly asks for completed work to be deployed automatically. Without that request, stop after creating and verifying the checkpoint.',
  '- If tests or checks fail, do not deploy. A clearly labeled 작업 중 checkpoint may be created when preserving the current files is useful.',
  '- Documentation-only changes create a checkpoint but do not require a server deployment. Exception: a guide-refresh-only request updates managed guide/session files without creating a checkpoint.',
  '- Before restoring files, create a restore_safety checkpoint and a local backup in the user-specific JoripSpace data directory outside the project. Preview additions, overwrites, deletions, and protected paths first; never overwrite conflicts without approval.',
  '- Treat local file restore and production rollback as separate confirmed actions. 이전 상태로 돌아가 means explain and confirm both independently.',
  '- Whenever two or more restore points or rollback versions are shown, including in response to an availability or inventory question such as "복원 가능한 것들이 있나?", show them as a Markdown table with number, version or identifier, timestamp, label or status, and effect. Do not wait until the user explicitly asks to choose one.',
  '- Customer project secrets, .env files, certificates, and private keys may be included in checkpoints and deployments with redacted warnings; never print their values or file contents. Continue excluding JoripSpace connection credentials, .git, node_modules, .wrangler, agent instructions/configuration, and `.joripspace/project`. Preserve the local canonical marker during restore.',
  '- Prefer MCP checkpoint tools. If MCP is unavailable, use the installed JoripSpace CLI absolute path with checkpoint save, checkpoint list, checkpoint restore, and checkpoint deploy. Existing npm run joripspace:* helpers are conditional legacy compatibility only and are never required by new start onboarding.',
];

const AFTER_CONNECTION_RULE_LINES = [
  'After MCP or CLI setup:',
  "- At the start of each new distinct user task, call search_knowledge once with the user's plain request before answering, planning, asking questions, or starting work. Apply the returned user_guidance, recommendation, and actions to both the response and the work, including short user requests. Do not repeat the search for every follow-up in the same task unless the topic changes or current guidance is needed.",
  '- If search_knowledge returns no direct match, use its prioritized fallback guidance and ask at most three short business questions. If the knowledge service fails, continue with the built-in JoripSpace guide and explain only when the failure blocks the task.',
  '- Do not stop with only "yes, it is possible" or a capability checklist.',
  '- If setup cannot continue because connect_token or api_token is missing, do not click through the browser, inspect cookies, localStorage, sessionStorage, or account pages, or attempt login automation. Tell the user exactly where to get the token and how to paste it back.',
  '- The user does not need to say "onboarding". After connection succeeds, continue into project selection, workspace file writing, and the first service questions automatically.',
  '- Prefer a single start_project_session tool call when it is available. It combines session lookup, project choice handling, workspace file instructions, and first questions.',
  '- If an MCP response includes workspace_setup.files, write those files into the current working folder immediately before replying.',
  '- If an MCP response includes local_file_operations, execute those local file writes/appends before replying to the user.',
  '- At the start of every new distinct JoripSpace task, call prepare_project_workspace before answering, planning, asking questions, or starting work. A new chat does not prove that the local guide is current, and a same-day guide update must not be skipped. Do not use cron or ask the user to run a refresh command.',
  '- Compare the returned AGENTS.md managed block and agent_guide.updated_at with the local JoripSpace managed block on every task-start check. When it differs, replace only the JoripSpace block and preserve user-authored content. Keep `@AGENTS.md` as the first unique CLAUDE.md line, validate `.joripspace/project`, and upsert `.env.joripspace` without discarding unrelated entries. Migrate a legacy token-bearing `.joripspace/agent-session.json` into the env file and remove it only after verification.',
  '- Before application work in a Git-history template project, read `.joripspace/template.json` and use the installed JoripSpace CLI `template pull` check to compare its `git_head_sha` with the latest entitled version. This check must not download a bundle or modify Git. When an update exists, report its version plus the local working-tree state and ask for explicit user approval. Only after approval, rerun the CLI command with `--yes`; it replaces `.git/joripspace/upstream.bundle`, fetches `upstream/main`, and merges the official descendant while preserving the user `origin`. If the user declines, continue without updating. Never pull automatically and never download or merge an update automatically; when there are uncommitted changes, rewritten history, divergence, or likely conflicts, stop and explain the safe next action.',
  '- If the current request is only to update or refresh the guide, follow the shared guide-refresh-only rules. Do not turn that maintenance request into source work, a checkpoint, Git activity, GitHub Actions, or deployment.',
  '- When MCP connection and workspace setup succeed, run the local Git and Node.js readiness check before the first service question. Ask about installation only when a missing tool is required for the current path; otherwise continue without installation. Never ask the user to run npm or git commands, locate API environment variables, or repeat the connection token.',
  '- Do not ask the user to paste another start prompt when you already have project context and workspace files.',
  '- If the user has not described the service yet, immediately start with up to three short questions.',
  '- If the user asks what to do next, do not only provide examples. Start the onboarding questions when the project is already selected.',
  '- If the user says they do not know what to build, suggest 2-3 simple service examples and pick a practical default.',
  '- Whenever those examples or any other concrete alternatives require the user to choose, follow the shared user choice presentation rules and show them as a Markdown table.',
  '- End each user-facing reply with the next thing to click, check, or answer.',
  '- If MCP tools do not appear immediately in an app, do not require a restart. Continue the current task with the installed JoripSpace CLI absolute path; prefer MCP automatically in a later session when it is active.',
];

const REQUIRED_ONBOARDING_MARKERS = [
  'Match the language the user is using',
  'Whenever a user-facing reply shows two or more concrete alternatives that the user could select',
  'Apply this even when the user only asks what is available, requests an inventory or comparison',
  'As soon as two or more individual candidates are shown, the table is mandatory',
  'For restore or rollback choices include number, version or identifier, timestamp, label or status, and effect',
  'For template choices include number, template name, suitable use, and included features',
  'Local Git and Node.js readiness during onboarding',
  'check `git --version`, `node --version`, and `npm --version` directly',
  'ask for one explicit approval to install only the missing required tools',
  'After installation, verify Git, Node.js, and npm again',
  'Guide refresh is maintenance-only unless deployment is separately explicit',
  'They are not authorization to build, test the application, create a checkpoint, stage files, commit, push, run GitHub Actions, or deploy',
  '운영 사이트는 변경하거나 배포하지 않았습니다.',
  'JoripSpace site creation and deployment authority (critical)',
  "agent's own default website-building skill",
  'deploy the verified result to the selected JoripSpace project',
  'convert the result to a JoripSpace-compatible app',
  'deployment_verification.guide_applied',
  'deployment_verification.agent_guide_updated_at',
  'source_compatibility to joripspace_native or converted_to_joripspace',
  'Framework selection rules (agent decides internally)',
  'Use a pure Cloudflare Worker for a new, single-purpose feature',
  'Use Hono when the service has multiple APIs or routes',
  'If routing would otherwise grow into a hand-written if/switch dispatch structure, use Hono instead',
  'If the choice between a pure Worker and Hono is ambiguous, choose Hono',
  'Do not downgrade Hono merely because a bundled entrypoint uses `export { app as default }`',
  'Re-evaluate this choice as the service grows',
  'migrate it to Hono during the task without asking the user to choose a framework',
  'A short, single-purpose service may keep its implementation in one Worker entry file',
  'split the source into role-based modules such as routes, middleware, services, repositories, and utilities',
  'Do not combine all implementation into worker.js merely to reduce the source file count',
  'Multiple source modules still build and deploy as one JoripSpace Worker service',
  'The user does not need to choose the file structure',
  'Server-side rendering and SEO rules (agent decides internally)',
  'Server-side rendering is the default for every user-facing page',
  'When the user explicitly requests an SPA, client-only application, WebView application, or similar app-style experience, honor that request',
  'This SSR default includes public pages, login and signup, account pages, authenticated application screens, admin pages, and dashboards',
  'When the SSR default applies, every page route must return meaningful, page-specific HTML in the initial HTTP response',
  'Render SSR pages on the server with the selected pure Worker or Hono stack',
  'Do not introduce Next.js solely to obtain SSR',
  'For an explicitly requested SPA or WebView app, verify app startup, routing, refresh behavior, authentication, loading, empty, and error states instead',
  'server_rendered_html and ssr_routes as verification evidence',
  'These fields are informational and must not block an explicitly requested SPA',
  'These fields are informational and are not deployment gate requirements',
  'First questions to ask when details are missing',
  'Secret and token rules',
  'do not browse around',
  'connect_token',
  'JoripSpace project secrets',
  'Only the selected project User Worker secret binding stores the value',
  'Secret values never appear in list responses',
  '제가 직접 확인하고 진행할까요?',
  'do not stop by asking them to determine the key name or purpose',
  'Do not ask for duplicate consent before browser assistance',
  'Every user-facing request for an external provider credential must include a clickable Markdown link',
  '제가 브라우저로 비밀 키 등록을 진행할까요?',
  'After browser-assisted registration, call list_secrets',
  '현재 연결 권한으로 자동 등록하지 못했습니다. 제가 브라우저로 직접 진행할까요?',
  'do not end with manual registration instructions',
  'DB, STORAGE, PROJECT_ID',
  'JORIPSPACE_, CF_, or CLOUDFLARE_',
  '60 active secrets',
  '1-5,120 UTF-8 bytes',
  'generate_project_secret',
  'project.secrets.generate',
  '.env.joripspace',
  'JORIPSPACE_GUIDE_CHECKED_AT',
  'never duplicate its value in JSON',
  'The shared project identity is the one-line `.joripspace/project` slug.',
  'Realtime inquiry',
  'After MCP or CLI setup',
  'start of every new distinct JoripSpace task',
  'project_db_binding_invalid',
  '아이디어가 아직 정리되지 않아도 됩니다',
  'JoripSpace capabilities for agents',
  'Shared platform policy lives in JoripSpace core contracts',
  'Project Plans And Limits',
  'Project Domains',
  'Project scheduled jobs',
  'A server path alone is not a completed scheduled job.',
  'list_crons and create_cron',
  'run_cron for an immediate safe verification',
  'Project mail',
  'connect_mail',
  'get_mail_status',
  'send_test_mail',
  'smtp_setup_available',
  'SMTP credentials',
  'quota_blocked',
  'plan_required',
  'create_domain',
  'verify_domain',
  'CNAME',
  'server/API requests 300,000',
  'Build and deployment defaults',
  'Image and file placement defaults',
  'Use a pure Cloudflare Worker',
  'Vite assets',
  'Next.js static export',
  'OpenNext',
  'package.json',
  'public/images',
  'deployment source',
  'user-uploaded',
  'list with pagination',
  'run_db_migration',
  'env.DB',
  'env.STORAGE',
  '/_joripspace/realtime',
  'plaintext plain_v2 JSON',
  'duplicate message ids and retried usage event ids are idempotent',
  'compatibility migration work is not a new message send',
  'installed JoripSpace CLI absolute path',
  'Existing npm run joripspace:* scripts are conditional legacy compatibility only',
  'one-line `.joripspace/project` slug',
  '<!-- joripspace:start -->',
  '<!-- joripspace:end -->',
  'run the relevant checks',
  'Deployment verification gate:',
  'The user does not need to provide a separate testing or security-review prompt.',
  'Do not open or control a browser for routine implementation or deployment verification.',
  'only when the user explicitly asks for browser verification',
  'After an explicitly requested deployment succeeds and the non-browser post-deployment checks pass',
  'Perform a focused security review',
  'Do not deploy with a known blocking functional, security, build, or responsive-layout problem.',
  'MCP-only setup and deploy do not require Node.js or Git.',
  'Do not install Node.js or Git',
  'The user should never have to find, name, or enter JORIPSPACE_API_TOKEN manually.',
  'Do not restart the connection flow for a deployment timeout.',
  'local_upload_required checkpoint response uses the installed CLI absolute path',
];

function projectLabel(projectConfig = {}) {
  const projectId = String(projectConfig.project_id || projectConfig.project_slug || '').trim();
  return projectId ? `\n\nProject: ${projectId}` : '';
}

function beginnerStartPrompts(projectConfig = {}) {
  const label = projectLabel(projectConfig);
  const joripspaceBuildInstruction =
    '사이트 제작과 배포에는 AI 에이전트의 기본 사이트 제작·호스팅 스킬이나 다른 플랫폼 방식을 대신 사용하지 말고, JoripSpace 프로젝트 지침과 MCP 흐름을 따라 이 JoripSpace 프로젝트에 제작·배포해 주세요.';
  return {
    create: [
      '이 JoripSpace 프로젝트에서 만들 서비스를 MCP 기본 온보딩 순서대로 질문하면서 정리하고, 필요한 파일을 만든 뒤 배포와 확인까지 진행해 주세요.',
      joripspaceBuildInstruction,
      '아이디어가 아직 정리되지 않아도 됩니다. 사이트 이름, 목적, 사용자, 필요한 기능을 쉬운 예시와 짧은 질문으로 정리해 주세요.',
      'API 키나 결제 키는 코드에 넣지 말고 JoripSpace 프로젝트 secret 또는 gitignore 처리된 로컬 파일에만 저장해 주세요.',
      label.trimStart().replace('Project:', '프로젝트:'),
    ]
      .filter(Boolean)
      .join('\n'),
    update: [
      '이 JoripSpace 프로젝트의 기존 사이트를 확인한 뒤, 바꾸고 싶은 내용을 짧은 질문으로 정리하고 직접 수정, 배포, 확인까지 진행해 주세요.',
      joripspaceBuildInstruction,
      '요청이 애매하면 쉬운 선택지 2-3개를 보여주고 안전한 기본값을 추천한 뒤 진행해 주세요.',
      'API 키나 결제 키는 코드에 넣지 말고 JoripSpace 프로젝트 secret 또는 gitignore 처리된 로컬 파일에만 저장해 주세요.',
      label.trimStart().replace('Project:', '프로젝트:'),
    ]
      .filter(Boolean)
      .join('\n'),
    fix: [
      '이 JoripSpace 프로젝트에서 오류나 배포 상태를 확인하고, 로그를 직접 살펴본 뒤 수정, 재배포, 확인까지 진행해 주세요.',
      joripspaceBuildInstruction,
      '결과는 쉬운 말로 설명하고, 제가 다음에 눌러야 할 것, 확인할 것, 답해야 할 것만 명확히 알려주세요.',
      '기술 로그를 직접 보라고 하거나 서버, DB, 스토리지, MCP, 배포 설정을 저에게 고르게 하지 마세요.',
      label.trimStart().replace('Project:', '프로젝트:'),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function beginnerStartPrompt(kind = 'create', projectConfig = {}) {
  const prompts = beginnerStartPrompts(projectConfig);
  return prompts[kind] || prompts.create;
}

function projectDeploymentRoutingLines(projectConfig = {}) {
  const deployment =
    projectConfig.deployment && typeof projectConfig.deployment === 'object' ? projectConfig.deployment : {};
  if (deployment.mode === 'github_actions') {
    const repository = String(deployment.repository || '(connected repository)');
    const branch = String(deployment.branch || '(connected branch)');
    const triggerType = String(deployment.trigger_type || 'branch');
    const trigger = triggerType === 'release' ? 'GitHub Release published' : `${branch} branch push`;
    const workflowPath = String(
      deployment.workflow_path || `.github/workflows/joripspace-${projectConfig.project_id || 'deploy'}.yml`
    );
    return [
      'Current deployment route: GitHub Actions.',
      `- Connected repository: ${repository}`,
      `- Connected deployment trigger: ${trigger}`,
      `- Expected workflow: ${workflowPath}`,
      '- A normal user request such as "배포해줘" is sufficient. Do not ask the user to mention GitHub, Actions, OIDC, workflow setup, commit, or push separately.',
      '- For an explicit deployment request, inspect and update the workflow when missing or stale, run the required checks, commit the exact relevant changes, and safely push them to the connected deployment branch (or the default branch used by a Release connection) so GitHub Actions performs the deployment.',
      '- Do not create a checkpoint through MCP, the installed CLI, or a verified legacy helper before this push. GitHub Actions creates the deployment checkpoint, so a pre-push agent checkpoint would duplicate storage and history. Only create a separate checkpoint when the user explicitly asks to save one independently of deployment.',
      '- Do not call deploy_code, deploy_checkpoint, the installed CLI direct deploy command, or a verified legacy direct package helper for this project while this GitHub route is connected.',
      '- Never force-push or overwrite unrelated user changes. If the connected branch cannot be updated safely, report the concrete Git conflict or permission blocker.',
      '- After the connected source change or GitHub Release, verify the resulting JoripSpace deployment through available deployment status or HTTP checks before reporting success.',
      '- A successful report must state deployment method GitHub Actions, repository, trigger, workflow path, source commit SHA, Actions result, and JoripSpace deployment ID. Do not report only a checkpoint number or deployment ID.',
    ];
  }
  return [
    'Current deployment route: direct JoripSpace deployment.',
    '- A normal user request such as "배포해줘" is sufficient. Do not ask the user to choose GitHub or repeat deployment plumbing.',
    '- Run the required checks, then use the JoripSpace MCP checkpoint/deployment path when active or the installed JoripSpace CLI absolute path returned by `start`. Use a verified pre-existing direct package helper only as conditional legacy compatibility.',
    '- Do not create a GitHub Actions workflow or push to GitHub solely to deploy while the project connection is absent, disconnected, invalid, or suspended.',
  ];
}

function projectSecretManagementLines(projectConfig = {}) {
  const projectId = String(projectConfig.project_id || projectConfig.project_slug || '').trim();
  const encodedProjectId = projectId ? encodeURIComponent(projectId) : '{project_id}';
  return [
    `- Secret management link (always include this as a clickable Markdown link when an external provider credential is required): https://joripspace.com/projects/${encodedProjectId}/?tab=secrets`,
  ];
}

function projectAgentsFile() {
  return [
    '<!-- joripspace:start -->',
    '',
    'Before working on this project, read `https://api.joripspace.com/onboarding.md`.',
    '',
    'The JoripSpace project is stored in `.joripspace/project`.',
    '',
    'Use the installed JoripSpace CLI for JoripSpace infrastructure, domains, and deployment. Do not configure or wait for MCP.',
    '',
    '<!-- joripspace:end -->',
  ].join('\n');
}

function projectClaudeFile() {
  return '@AGENTS.md\n';
}

function upsertProjectAgentsContent(existingContent = '', projectConfig = {}) {
  const managed = projectAgentsFile(projectConfig).trim();
  const existing = String(existingContent || '');
  if (!existing.trim()) return `${managed}\n`;
  const markerPairs = [
    ['<!-- joripspace:start -->', '<!-- joripspace:end -->'],
    ['<!-- joripspace:managed:start -->', '<!-- joripspace:managed:end -->'],
  ];
  let unmanaged = existing;
  for (const [startMarker, endMarker] of markerPairs) {
    const starts = unmanaged.split(startMarker).length - 1;
    const ends = unmanaged.split(endMarker).length - 1;
    if (starts !== ends) throw new Error('AGENTS.md의 JoripSpace 관리 영역이 손상되었습니다.');
    const escapedStart = startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    unmanaged = unmanaged.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g'), '');
  }
  const preserved = unmanaged.trim();
  return preserved ? `${preserved}\n\n${managed}\n` : `${managed}\n`;
}

function projectMarkerFile(projectConfig = {}) {
  const projectSlug = String(projectConfig.project_slug || projectConfig.project_id || '')
    .trim()
    .toLowerCase();
  if (
    projectSlug.length < 3 ||
    projectSlug.length > 50 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(projectSlug)
  ) {
    throw new Error('JoripSpace 프로젝트 slug가 올바르지 않습니다.');
  }
  return `${projectSlug}\n`;
}

function projectPackageHelperScripts() {
  return { ...JORIPSPACE_PACKAGE_HELPER_SCRIPTS };
}

function projectPackageHelperDependencies() {
  return { ...JORIPSPACE_PACKAGE_HELPER_DEPENDENCIES };
}

function projectDoctorHelperFile() {
  return String.raw`#!/usr/bin/env node
  import crypto from 'node:crypto';
  import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const REQUIRED_SCRIPTS = {
  'joripspace:doctor': 'node .joripspace/doctor.mjs',
  'joripspace:save': 'node .joripspace/save.mjs',
  'joripspace:checkpoints': 'node .joripspace/checkpoints.mjs',
  'joripspace:restore': 'node .joripspace/restore.mjs',
  'joripspace:deploy-checkpoint': 'node .joripspace/deploy-checkpoint.mjs',
  'joripspace:deploy': 'node .joripspace/save.mjs --deploy',
  'joripspace:pull': 'node .joripspace/pull.mjs',
  'joripspace:pull:force': 'node .joripspace/pull.mjs --force',
  'joripspace:install-template': 'node .joripspace/install-template.mjs',
  'joripspace:template-pull': 'node .joripspace/install-template.mjs --update'
};
const OPTIONAL_DEPLOY_SCRIPT = 'node .joripspace/save.mjs --deploy';
const ENTRYPOINT_CANDIDATES = ['worker.js', 'src/worker.js', 'src/index.js', 'server.js', 'dist/worker.js'];
const RECOMMENDED_STACK_ORDER = [
  '1. Keep the current stack for an existing project unless complexity or compatibility requires a change.',
  '2. Pure Worker for one simple purpose without shared middleware.',
  '3. Hono for multiple routes, shared auth/CORS/validation/error handling, hand-written routing growth, or ambiguity.',
  '4. Re-evaluate and migrate a growing pure Worker to Hono while preserving behavior.',
  '5. Server-render every user-facing route by default, including login, account, admin, and dashboards.',
  '6. Plain HTML/CSS/JS or Vite frontend structure as appropriate, with server-rendered initial HTML.',
  '7. Other Cloudflare-compatible framework output when the existing project requires it.',
  '8. Next.js static export or OpenNext conversion only when the existing stack or request requires Next.js.',
  '9. Express, NestJS, or long-running Node servers only after converting to Worker-compatible routes.'
];
const IMAGE_AND_FILE_PLACEMENT = {
  source_assets: [
    'Hero images, section screenshots, icons, logos, and fixed example images live in project files such as public/images/...',
    'These files are part of the deployment source and are restored when the latest deployment source is pulled.'
  ],
  storage_files: [
    'user-uploaded files, gallery photos, attachments, generated documents, and operational files live in env.STORAGE.',
    'Store title, description, order, owner, visibility, and storage key metadata in env.DB.'
  ],
  user_words: '사이트 디자인에 필요한 이미지는 프로젝트 파일에 넣고, 사용자가 올리는 사진이나 첨부파일은 스토리지에 저장합니다.'
};
const CAPABILITIES = {
  server: {
    available: true,
    agent_path: 'Use MCP deploy_code for intact small source. Use the installed JoripSpace CLI absolute path for generated bundles and large projects so local bytes are uploaded in verified chunks.',
    user_words: '서버 배포 가능'
  },
  db: {
    available: true,
    app_code: 'Use env.DB inside server code for structured records.',
    agent_path: 'Use MCP describe_db, query_db, and run_db_migration, or CLI db commands, for schema/data work.',
    user_words: 'DB 사용 가능'
  },
  storage: {
    available: true,
    app_code: 'Use env.STORAGE inside server code for uploads and generated files.',
    agent_path: 'Use MCP list/read/write/delete_storage_object tools or CLI storage commands for one-off file work.',
    user_words: '스토리지 사용 가능'
  },
  realtime: {
    available: true,
    app_code: 'Use /_joripspace/realtime?room=main from browser code. Accepted history and Unicode FTS5 search are managed by the platform; page or search /_joripspace/realtime/rooms/{room}/messages.',
    agent_path: 'No extra binding or custom Durable Object is required. Never create a D1 chat-history table for platform realtime.',
    user_words: '실시간 기능 사용 가능'
  },
  plan_limits: {
    user_words: '요금제 제공량을 넘으면 추가 과금 없이 기능이 제한되고 차단 안내 페이지가 표시됩니다.',
    unlimited_metered_usage: 'OFF by default. Starter and higher plans can enable it so overage is not blocked and usage is still recorded.',
    unlimited_metered_budget: 'Optional. Empty means no budget cap. A numeric monthly budget caps overage and blocks when projected overage exceeds it.',
    speed_boost:
      'Starter 이상 프로젝트는 속도 부스트를 켤 수 있습니다. 개인 도메인은 프로젝트 기본 주소를 CNAME 대상으로 한 번만 연결하며, 이후 속도 부스트를 켜거나 끌 때 고객 DNS를 다시 변경하지 않습니다. 기존 직접 CNAME만 프로젝트 기본 주소로 한 번 변경합니다. 프로젝트별 Argo 데이터 사용량은 별도로 집계하거나 과금하지 않습니다.',
    speed_boost_ledger_items: [],
    quota_error: 'quota_blocked',
    custom_domain_error: 'plan_required',
    free: {
      requests_per_month: 10000,
      storage: '100MB',
      db: '50MB',
      realtime_messages_per_month: 1000,
      realtime_concurrent_connections: 5,
      custom_domain: false
      ,custom_domain_limit: 0
    },
    starter: {
      requests_per_month: 100000,
      storage: '1GB',
      db: '250MB',
      realtime_messages_per_month: 100000,
      realtime_concurrent_connections: 50,
      custom_domain: true
      ,custom_domain_limit: 1
    },
    pro: {
      requests_per_month: 300000,
      storage: '3GB',
      db: '750MB',
      realtime_messages_per_month: 300000,
      realtime_concurrent_connections: 150,
      custom_domain: true
      ,custom_domain_limit: 1
    },
    business: {
      requests_per_month: 1000000,
      storage: '10GB',
      db: '2.5GB',
      realtime_messages_per_month: 1000000,
      realtime_concurrent_connections: 500,
      custom_domain: true
      ,custom_domain_limit: 1
    }
  },
  project_domains: {
    user_words: '개인 도메인은 Starter 이상에서 사용할 수 있습니다. DNS에 CNAME 값을 설정한 뒤 상태 확인을 누릅니다.',
    default_domain_delete: false,
    free_error: 'plan_required',
    agent_path: 'Use web UI for non-technical users, or MCP list_domains/create_domain/verify_domain/delete_domain and CLI domain commands when agent tools are available.',
    dns_record: 'CNAME',
    wildcard: false,
    apex: false,
    idn: 'punycode',
    free_downgrade_requires_disconnect: true
  },
  recommended_stack_order: RECOMMENDED_STACK_ORDER,
  image_and_file_placement: IMAGE_AND_FILE_PLACEMENT
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

${projectEnvReaderSource()}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function ensurePackageScripts() {
  const packagePath = path.join(ROOT, 'package.json');
  const packageJson = readJson(packagePath) || { private: true, scripts: {} };
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object' || Array.isArray(packageJson.scripts)) {
    packageJson.scripts = {};
  }
  for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
    if (!packageJson.scripts[name]) packageJson.scripts[name] = command;
  }
  if (!packageJson.scripts.deploy) packageJson.scripts.deploy = OPTIONAL_DEPLOY_SCRIPT;
  writeJson(packagePath, packageJson);
}

function hasGitignoreEntry(entry) {
  try {
    return fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()).includes(entry);
  } catch {
    return false;
  }
}

function detectEntrypoint() {
  return ENTRYPOINT_CANDIDATES.find((candidate) => fs.existsSync(path.join(ROOT, candidate))) || '';
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const fixMode = process.argv.includes('--fix');
  if (fixMode) ensurePackageScripts();

  const env = readEnv(path.join(ROOT, '.env.joripspace'));
  const project = { project_slug: readProjectMarker(ROOT) };
  const packageJson = readJson(path.join(ROOT, 'package.json')) || {};
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const issues = [];

  const projectId = project.project_slug || env.JORIPSPACE_PROJECT_ID || '';
  const apiBaseUrl = env.JORIPSPACE_API_BASE_URL || project.api_base_url || '';
  const tokenPresent = Boolean(process.env.JORIPSPACE_API_TOKEN || env.JORIPSPACE_API_TOKEN);
  const entrypoint = detectEntrypoint();

  if (!projectId) issues.push({ code: 'missing_project_id', message: 'JoripSpace 프로젝트 ID를 찾지 못했습니다.', next_action: 'MCP 연결 또는 joripspace link를 다시 실행하세요.' });
  if (!apiBaseUrl) issues.push({ code: 'missing_api_base_url', message: 'JoripSpace API 주소를 찾지 못했습니다.', next_action: 'MCP 연결 또는 joripspace link를 다시 실행하세요.' });
  if (!tokenPresent) issues.push({ code: 'missing_api_token', message: '배포 토큰을 찾지 못했습니다.', next_action: 'JoripSpace 연결을 다시 승인해 주세요.' });
  for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
    if (scripts[name] !== command) issues.push({ code: 'missing_package_script', script: name, message: 'package.json에 ' + name + ' 스크립트가 없습니다.', next_action: 'npm run joripspace:doctor -- --fix 를 실행하세요.' });
  }
  if (!entrypoint) issues.push({ code: 'missing_entrypoint', message: '배포할 서버 진입 파일을 찾지 못했습니다.', next_action: 'worker.js 또는 src/index.js처럼 export default가 있는 서버 파일을 만들어 주세요.' });
  if (!hasGitignoreEntry('.env.joripspace')) issues.push({ code: 'gitignore_missing_env', message: '.env.joripspace가 .gitignore에 없습니다.', next_action: '.env.joripspace를 .gitignore에 추가하세요.' });

  const result = {
    ok: issues.length === 0,
    project_id: projectId || null,
    api_base_url: apiBaseUrl || null,
    token_present: tokenPresent,
    entrypoint: entrypoint || null,
    package_scripts: {
      'joripspace:doctor': scripts['joripspace:doctor'] || null,
      'joripspace:save': scripts['joripspace:save'] || null,
      'joripspace:checkpoints': scripts['joripspace:checkpoints'] || null,
      'joripspace:restore': scripts['joripspace:restore'] || null,
      'joripspace:deploy-checkpoint': scripts['joripspace:deploy-checkpoint'] || null,
      'joripspace:deploy': scripts['joripspace:deploy'] || null,
      'joripspace:pull': scripts['joripspace:pull'] || null,
      deploy: scripts.deploy || null
    },
    capabilities: CAPABILITIES,
    issues
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (result.ok) {
    console.log('JoripSpace 연결 상태가 정상입니다.');
    console.log('배포 준비가 된 파일: ' + entrypoint);
    console.log('배포 명령: npm run joripspace:deploy');
    console.log('사용 가능 기능: 서버, DB, 스토리지, 실시간');
    console.log('DB 구조 변경은 MCP/CLI 마이그레이션 도구를 사용하면 됩니다.');
    console.log('스토리지 파일 작업은 MCP/CLI 스토리지 도구를 사용하면 됩니다.');
    console.log('실시간 메시지는 /_joripspace/realtime?room=main 으로 연결하면 됩니다.');
    return;
  }

  console.log('JoripSpace 연결 설정을 확인해야 합니다.');
  for (const issue of issues) {
    console.log('- ' + issue.message + ' ' + issue.next_action);
  }
  process.exitCode = 1;
}

main();
`;
}

function projectDeployHelperFile() {
  return String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ENTRYPOINT_CANDIDATES = ['worker.js', 'src/worker.js', 'src/index.js', 'server.js', 'dist/worker.js'];
const IGNORED_DIRS = new Set(['.git', '.joripspace', '.agents', '.claude', '.codex', '.cursor', '.gemini', '.opencode', '.wrangler', 'node_modules', '.cache', 'coverage']);
const IGNORED_FILES = new Set(['agents.md', 'claude.md', '.npmrc', '.pypirc', '.netrc', '_netrc']);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

${projectEnvReaderSource()}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function shouldIgnore(relativePath) {
  const normalized = toPosix(relativePath).toLowerCase();
  const parts = normalized.split('/');
  const base = parts.at(-1) || '';
  if (IGNORED_FILES.has(base)) return true;
  if (base.startsWith('.env') || base.startsWith('.dev.vars')) return true;
  if (parts.includes('.ssh') || normalized === '.aws/credentials') return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (normalized.startsWith('.joripspace/')) return true;
  if (normalized.startsWith('tests/') || normalized.startsWith('test/') || normalized.startsWith('docs/')) return true;
  return parts.some((part) => IGNORED_DIRS.has(part));
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(ROOT, fullPath);
    if (shouldIgnore(relative)) continue;
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function detectEntrypoint() {
  const explicit = argValue('--entrypoint');
  if (explicit) return toPosix(explicit);
  return ENTRYPOINT_CANDIDATES.find((candidate) => fs.existsSync(path.join(ROOT, candidate))) || '';
}

function loadConnection() {
  const connection = resolveSourceBoundConnection(ROOT);
  const env = connection.projectEnv;
  const project = { project_slug: readProjectMarker(ROOT) };
  return {
    project,
    projectId: project.project_slug || process.env.JORIPSPACE_PROJECT_ID || env.JORIPSPACE_PROJECT_ID || '',
    apiBaseUrl: connection.apiBaseUrl,
    apiToken: connection.apiToken
  };
}

function hasModuleWorkerDefaultExport(source) {
  const text = String(source || '');
  return /\bexport\s+default\b/.test(text) ||
    /\bexport\s*\{[^}]*\bas\s+default\b[^}]*\}/s.test(text) ||
    /\bexport\s*\{[^}]*\bdefault\b[^}]*\}\s*from\s*['"]/s.test(text);
}

function buildPayload(entrypoint) {
  if (!entrypoint) {
    throw new Error('배포할 서버 진입 파일을 찾지 못했습니다. worker.js 또는 src/index.js처럼 기본 내보내기가 있는 파일을 만들어 주세요.');
  }
  const entrypointPath = path.join(ROOT, entrypoint);
  if (!fs.existsSync(entrypointPath)) {
    throw new Error('지정한 entrypoint 파일이 없습니다: ' + entrypoint);
  }

  const files = {};
  for (const filePath of walkFiles(ROOT)) {
    const relative = toPosix(path.relative(ROOT, filePath));
    files[relative] = fs.readFileSync(filePath, 'utf8');
  }

  if (!Object.prototype.hasOwnProperty.call(files, entrypoint)) {
    files[entrypoint] = fs.readFileSync(entrypointPath, 'utf8');
  }
  if (!hasModuleWorkerDefaultExport(files[entrypoint])) {
    throw new Error('서버 진입 파일 형식이 올바르지 않습니다. 유효한 ES 모듈 기본 내보내기가 필요합니다: ' + entrypoint);
  }
  return { entrypoint, files };
}

function friendlyError(body, fallback) {
  const error = body && body.error ? body.error : {};
  const code = error.code || body?.code || '';
  const message = error.message || body?.message || fallback;
  if (code === 'project_resources_invalid' || code === 'project_db_binding_invalid') {
    return formatDeploymentFailure('JoripSpace 프로젝트 서버/DB 연결 설정을 복구해야 합니다. 사용자 코드 문제가 아니므로 관리자 복구 후 다시 배포해 주세요. (' + code + ')', error.details);
  }
  return formatDeploymentFailure(message, error.details);
}

function formatDeploymentFailure(message, details) {
  if (!details || typeof details !== 'object' || !details.deployment_id) return message;
  const lines = [message, '배포 ID: ' + details.deployment_id];
  if (details.error_stage) lines.push('실패 단계: ' + details.error_stage);
  if (details.error_code) lines.push('오류 코드: ' + details.error_code);
  if (details.error_details && details.error_details !== message) lines.push('상세 오류: ' + details.error_details);
  return lines.join('\n');
}

async function main() {
  const { project, projectId, apiBaseUrl, apiToken } = loadConnection();
  if (!projectId) throw new Error('JoripSpace 프로젝트 ID를 찾지 못했습니다. MCP 연결 또는 joripspace link를 다시 실행하세요.');
  if (!apiToken) throw new Error('JoripSpace 배포 토큰을 찾지 못했습니다. JoripSpace 연결을 다시 승인해 주세요.');

  const entrypoint = detectEntrypoint();
  const payload = buildPayload(entrypoint);
  const label = argValue('--label').trim();
  if (!label) throw new Error('--label에 배포한 내용을 입력해 주세요.');
  if (label.length > 120) throw new Error('배포 이름은 120자 이하여야 합니다.');
  const response = await fetch(apiBaseUrl + '/v1/projects/' + encodeURIComponent(projectId) + '/deploy', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiToken,
      'content-type': 'application/json',
      'x-joripspace-session-context': 'package-helper'
    },
    body: JSON.stringify({ ...payload, label })
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    throw new Error(friendlyError(body, '배포에 실패했습니다. 잠시 후 다시 시도해 주세요.'));
  }
  console.log('JoripSpace 배포가 완료되었습니다.');
  console.log('프로젝트: ' + projectId);
  if (body.default_url) console.log('URL: ' + body.default_url);
  if (body.deployment_id) console.log('Deployment: ' + body.deployment_id);
  for (const warning of body.warnings || []) console.warn('경고: ' + warning.message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
}

function projectPullHelperFile() {
  return String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PROTECTED_PREFIXES = ['.git/', '.joripspace/', '.agents/', '.claude/', '.codex/', '.cursor/', '.gemini/', '.opencode/', 'node_modules/'];
const PROTECTED_FILES = new Set(['.gitignore', 'agents.md', 'claude.md', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}



${projectEnvReaderSource()}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function safeRelativePath(fileName) {
  const normalized = toPosix(String(fileName || ''));
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error('배포본에 안전하지 않은 파일 경로가 있습니다: ' + fileName);
  }
  return normalized;
}

function protectedRestorePath(fileName) {
  const normalized = toPosix(String(fileName || '')).replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1) || '';
  return PROTECTED_FILES.has(lower) ||
    PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    base === '.env.joripspace';
}

function assertNonOverlappingPlan(relatives) {
  const paths = new Map();
  for (const relative of relatives) {
    const key = relative.toLowerCase();
    if (paths.has(key)) throw new Error('배포본에 중복된 교차 플랫폼 경로가 있습니다: ' + relative);
    paths.set(key, relative);
  }
  for (const relative of paths.values()) {
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      if (paths.has(parts.slice(0, length).join('/').toLowerCase())) throw new Error('배포본에 파일/디렉터리 경로 충돌이 있습니다: ' + relative);
    }
  }
}

function restoreTarget(relative) {
  const root = fs.realpathSync.native(ROOT);
  const parts = relative.split('/');
  const target = path.resolve(root, ...parts);
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) throw new Error('복원 경로가 프로젝트 밖을 가리킵니다: ' + relative);
  const blockers = [];
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('복원 경로에 심볼릭 링크 또는 junction이 있습니다: ' + parts.slice(0, index + 1).join('/'));
    const isTarget = index === parts.length - 1;
    if ((!isTarget && !stat.isDirectory()) || (isTarget && !stat.isFile())) {
      blockers.push(parts.slice(0, index + 1).join('/'));
      break;
    }
  }
  return { blockers, target };
}

function backupDirectory(relative) {
  const normalized = toPosix(relative);
  const root = fs.realpathSync.native(ROOT);
  const target = path.resolve(root, ...normalized.split('/'));
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) throw new Error('백업 경로가 프로젝트 밖을 가리킵니다: ' + relative);
  let current = root;
  const parts = normalized.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('백업 경로에 심볼릭 링크 또는 junction이 있습니다: ' + parts.slice(0, index + 1).join('/'));
    if (!stat.isDirectory()) throw new Error('백업 디렉터리가 파일에 막혀 있습니다: ' + normalized);
  }
  return target;
}

function backupAndRemove(relatives, backupRoot) {
  const sorted = [...new Set(relatives)].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const selected = sorted.filter((candidate) => !sorted.some((parent) => parent !== candidate && candidate.startsWith(parent + '/')));
  const safeBackupRoot = backupDirectory(toPosix(path.relative(ROOT, backupRoot)));
  fs.mkdirSync(safeBackupRoot, { recursive: true });
  for (const relative of selected) {
    const location = restoreTarget(relative);
    if (location.blockers.length) throw new Error('백업 경로가 로컬 파일에 막혀 있습니다: ' + relative);
    let stat;
    try { stat = fs.lstatSync(location.target); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    const backup = path.join(safeBackupRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (stat.isDirectory()) fs.cpSync(location.target, backup, { recursive: true, errorOnExist: true });
    else fs.copyFileSync(location.target, backup, fs.constants.COPYFILE_EXCL);
    fs.rmSync(location.target, { recursive: stat.isDirectory(), force: true });
  }
}

function loadConnection() {
  const connection = resolveSourceBoundConnection(ROOT);
  const env = connection.projectEnv;
  const project = { project_slug: readProjectMarker(ROOT) };
  return {
    projectId: project.project_slug || process.env.JORIPSPACE_PROJECT_ID || env.JORIPSPACE_PROJECT_ID || '',
    apiBaseUrl: connection.apiBaseUrl,
    apiToken: connection.apiToken
  };
}

async function fetchSource(connection, deploymentId) {
  const target = deploymentId || 'latest';
  const response = await fetch(connection.apiBaseUrl + '/v1/projects/' + encodeURIComponent(connection.projectId) + '/deployments/' + encodeURIComponent(target) + '/source', {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + connection.apiToken,
      'x-joripspace-session-context': 'package-helper'
    }
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || '최신 배포본을 가져오지 못했습니다.';
    throw new Error(message);
  }
  return body;
}

function writeFiles(source, force) {
  const files = source.files && typeof source.files === 'object' && !Array.isArray(source.files) ? source.files : null;
  if (!files) throw new Error('배포본 파일 목록이 올바르지 않습니다.');

  const protectedFiles = Object.keys(files).filter(protectedRestorePath);
  const planned = Object.entries(files)
    .filter(([name]) => !protectedRestorePath(name))
    .map(([name, content]) => [safeRelativePath(name), String(content)]);
  assertNonOverlappingPlan(planned.map(([relative]) => relative));
  const conflicts = new Set();
  for (const [relative, content] of planned) {
    const location = restoreTarget(relative);
    if (location.blockers.length) location.blockers.forEach((blocker) => conflicts.add(blocker));
    else if (fs.existsSync(location.target) && fs.readFileSync(location.target, 'utf8') !== content) conflicts.add(relative);
  }

  if (conflicts.size > 0 && !force) {
    console.log('로컬 파일과 최신 배포본이 충돌합니다. 아무 파일도 바꾸지 않았습니다.');
    for (const relative of conflicts) console.log('- ' + relative);
    console.log('교체하려면 사용자 승인 후 npm run joripspace:pull:force 를 실행하세요.');
    process.exitCode = 1;
    return;
  }

  const backupRoot = path.join(ROOT, '.joripspace', 'local-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  if (conflicts.size > 0) backupAndRemove([...conflicts], backupRoot);

  for (const [relative, content] of planned) {
    const location = restoreTarget(relative);
    if (location.blockers.length) throw new Error('복원 대상이 로컬 파일에 막혀 있습니다: ' + location.blockers.join(', '));
    fs.mkdirSync(path.dirname(location.target), { recursive: true });
    fs.writeFileSync(location.target, content);
  }

  console.log('최신 배포본을 로컬 파일로 가져왔습니다.');
  console.log('프로젝트: ' + source.project_id);
  console.log('배포 버전: ' + source.version);
  console.log('파일 수: ' + planned.length);
  if (protectedFiles.length > 0) {
    console.log('연결 토큰과 온보딩 설정을 보호하기 위해 제외한 파일: ' + protectedFiles.length);
  }
  if (conflicts.size > 0) console.log('교체 전 파일 백업: ' + path.relative(ROOT, backupRoot));
}

async function main() {
  const force = process.argv.includes('--force');
  const deploymentId = argValue('--deployment') || argValue('--deployment-id') || '';
  const connection = loadConnection();
  if (!connection.projectId) throw new Error('JoripSpace 프로젝트 ID를 찾지 못했습니다. MCP 연결 또는 joripspace link를 다시 실행하세요.');
  if (!connection.apiToken) throw new Error('JoripSpace 토큰을 찾지 못했습니다. JoripSpace 연결을 다시 승인해 주세요.');
  const source = await fetchSource(connection, deploymentId);
  writeFiles(source, force);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
}

function projectCheckpointClientFile() {
  return String.raw`import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { strToU8, unzipSync, zipSync } from 'fflate';

const ROOT = process.cwd();
const HARD_DIRS = new Set(['.git', '.agents', '.claude', '.codex', '.cursor', '.gemini', '.opencode', 'node_modules', '.wrangler', '.cache', 'coverage', 'tmp', 'temp']);
const HARD_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'agents.md', 'claude.md']);
const LOCAL_IDENTITY_FILE = '.joripspace/project';
const LOCAL_RESTORE_MARKERS = new Set([LOCAL_IDENTITY_FILE, '.gitignore']);
const TEXT_ENCODER = new TextEncoder();

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

${projectEnvReaderSource()}

function connection() {
  ensureProjectEnvSafety();
  const connection = resolveSourceBoundConnection(ROOT);
  const env = connection.projectEnv;
  const result = {
    projectId: readProjectMarker(ROOT) || process.env.JORIPSPACE_PROJECT_ID || env.JORIPSPACE_PROJECT_ID || '',
    apiBaseUrl: connection.apiBaseUrl,
    apiToken: connection.apiToken
  };
  if (!result.projectId || !result.apiToken) throw new Error('JoripSpace 프로젝트 연결 정보가 없습니다. 연결을 다시 승인해 주세요.');
  return result;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function decodedArg(plainName, encodedName) {
  const encoded = arg(encodedName);
  if (!encoded) return arg(plainName);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(encodedName + ' 값이 올바르지 않습니다.');
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw new Error(encodedName + ' 값이 올바르지 않습니다.');
  }
  return decoded;
}

function ensureProjectEnvSafety() {
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--error-unmatch', '--', '.env.joripspace'], { encoding: 'utf8', windowsHide: true });
  if (tracked.status === 0) throw new Error('.env.joripspace가 Git에 추적되고 있습니다. git rm --cached -- .env.joripspace 후 다시 실행하세요.');
  if (tracked.error?.code === 'ENOENT' && fs.existsSync(path.join(ROOT, '.git'))) {
    throw new Error('.env.joripspace의 Git 추적 상태를 확인하려면 Git이 필요합니다.');
  }
  const location = restoreTarget('.gitignore');
  if (location.blockers.length) throw new Error('.gitignore 경로가 로컬 파일에 막혀 있습니다.');
  let source = '';
  try { source = fs.readFileSync(location.target, 'utf8'); } catch {}
  const lines = source.split(/\r?\n/).filter((line) => line.trim() !== '.env.joripspace');
  while (lines.at(-1) === '') lines.pop();
  lines.push('.env.joripspace');
  const next = lines.join('\n') + '\n';
  if (next !== source) fs.writeFileSync(location.target, next, 'utf8');
}

function posix(value) { return value.split(path.sep).join('/'); }

function portablePathKey(relative) { return posix(String(relative || '')).toLowerCase(); }
function isLocalIdentityFile(relative) { return portablePathKey(relative) === LOCAL_IDENTITY_FILE; }
function isLocalRestoreMarker(relative) { return LOCAL_RESTORE_MARKERS.has(portablePathKey(relative)); }

function hardExcluded(relative) {
  const normalized = posix(relative).replace(/^\.\//, '');
  const lower = normalized.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1) || '';
  return HARD_FILES.has(base) || parts.some((part) => HARD_DIRS.has(part)) ||
    parts.includes('.joripspace') || base === '.env.joripspace' ||
    /\.(log|tmp|temp)$/i.test(base);
}

function ignoreRules() {
  const rules = [];
  for (const name of ['.gitignore', '.ignore', '.joripspaceignore']) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.startsWith('#')) rules.push(value);
      }
    } catch {}
  }
  return rules;
}

function globRegex(pattern) {
  const clean = pattern.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '/**');
  const escaped = clean.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.');
  return new RegExp('^(?:' + escaped + ')(?:/.*)?$');
}

function ignored(relative, rules) {
  if (hardExcluded(relative)) return true;
  const normalized = posix(relative);
  let result = false;
  for (const rule of rules) {
    if (globRegex(rule).test(normalized)) result = !rule.startsWith('!');
  }
  return result;
}

function projectFiles() {
  const rules = ignoreRules();
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = posix(path.relative(ROOT, full));
      if (hardExcluded(relative)) continue;
      const excluded = ignored(relative, rules);
      if (excluded && (!entry.isDirectory() || !negatedRuleCanInclude(relative, rules))) continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('심볼릭 링크는 저장본에 포함할 수 없습니다: ' + relative);
      if (entry.isDirectory()) {
        if (!excluded || negatedRuleCanInclude(relative, rules)) walk(full);
      } else if (entry.isFile() && !excluded) {
        files.push([relative, new Uint8Array(fs.readFileSync(full))]);
      }
    }
  }
  walk(ROOT);
  return files;
}

function negatedRuleCanInclude(directory, rules) {
  const prefix = posix(directory).replace(/\/$/, '') + '/';
  return rules.some((rule) => {
    if (!rule.startsWith('!')) return false;
    const target = rule.slice(1).replace(/^\//, '').replace(/\*.*$/, '');
    return target.startsWith(prefix) || prefix.startsWith(target.replace(/\/$/, '') + '/');
  });
}

async function apiFetch(connection, route, options = {}) {
  const response = await fetch(connection.apiBaseUrl + route, {
    method: options.method || 'GET',
    headers: {
      authorization: 'Bearer ' + connection.apiToken,
      'x-joripspace-session-context': 'package-helper',
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    },
    body: options.bytes || (options.json === undefined ? undefined : JSON.stringify(options.json))
  });
  if (options.raw) {
    if (!response.ok) throw new Error('저장본 파일을 받지 못했습니다. (' + response.status + ')');
    return response;
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || 'JoripSpace 요청에 실패했습니다. (' + response.status + ')';
    const details = body?.error?.details;
    if (!details || typeof details !== 'object' || !details.deployment_id) throw new Error(message);
    const lines = [message, '배포 ID: ' + details.deployment_id];
    if (details.error_stage) lines.push('실패 단계: ' + details.error_stage);
    if (details.error_code) lines.push('오류 코드: ' + details.error_code);
    if (details.error_details && details.error_details !== message) lines.push('상세 오류: ' + details.error_details);
    throw new Error(lines.join('\n'));
  }
  return body;
}

async function waitReady(connection, checkpointId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await apiFetch(connection, '/v1/projects/' + encodeURIComponent(connection.projectId) + '/checkpoints/' + encodeURIComponent(checkpointId));
    if (result.status === 'ready') return result;
    if (result.status === 'failed' || result.status === 'deleted') throw new Error(result.error_message || '저장본 처리에 실패했습니다.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('저장본 처리 시간이 길어지고 있습니다. 저장본 목록에서 상태를 확인해 주세요.');
}

function printWarnings(warnings) {
  for (const warning of warnings || []) console.warn('경고: ' + warning.message);
}

export async function saveCheckpoint(label = '', deploy = false, sourceType = 'agent') {
  const target = connection();
  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel) throw new Error('--label에 저장하거나 배포한 내용을 입력해 주세요.');
  if (normalizedLabel.length > 120) throw new Error('저장본 이름은 120자 이하여야 합니다.');
  const files = projectFiles();
  if (!files.length) throw new Error('저장할 프로젝트 파일이 없습니다.');
  assertNonOverlappingPlan(files.map(([relative]) => relative));
  const archive = zipSync(Object.fromEntries(files.map(([name, bytes]) => [name, [bytes, { level: 6 }]])), { level: 6 });
  const session = await apiFetch(target, '/v1/projects/' + encodeURIComponent(target.projectId) + '/checkpoint-uploads', {
    method: 'POST',
    json: { label: normalizedLabel, source_type: sourceType, idempotency_key: crypto.randomUUID() }
  });
  const chunkSize = Number(session.chunk_size || 6 * 1024 * 1024);
  let part = 1;
  for (let offset = 0; offset < archive.byteLength; offset += chunkSize) {
    const route = String(session.upload_part_url_template).replace('{part_number}', String(part));
    await apiFetch(target, route, { method: 'PUT', bytes: archive.subarray(offset, Math.min(offset + chunkSize, archive.byteLength)) });
    part += 1;
  }
  await apiFetch(target, session.complete_url, { method: 'POST', json: {} });
  const ready = await waitReady(target, session.checkpoint_id);
  console.log('저장본 #' + ready.sequence + '을 만들었습니다. 파일 ' + ready.file_count + '개');
  printWarnings(ready.warnings);
  if (deploy) {
    if (!ready.deployable) throw new Error('이 저장본은 백업 전용이라 서버에 배포할 수 없습니다.');
    const result = await apiFetch(target, '/v1/projects/' + encodeURIComponent(target.projectId) + '/checkpoints/' + encodeURIComponent(ready.checkpoint_id) + '/deploy', { method: 'POST', json: {} });
    console.log('같은 저장본으로 배포했습니다: ' + (result.url || target.projectId));
  }
  return ready;
}

async function listCheckpoints() {
  const target = connection();
  const result = await apiFetch(target, '/v1/projects/' + encodeURIComponent(target.projectId) + '/checkpoints?limit=100');
  for (const item of result.checkpoints || []) {
    console.log('#' + item.sequence + ' ' + (item.label || '(이름 없음)') + ' · ' + item.status + (item.deployable ? ' · 배포 가능' : ' · 백업 전용'));
  }
}

function safeRestorePath(name) {
  const normalized = posix(String(name || ''));
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..' || part === '' || part === '.' || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error('안전하지 않은 복원 경로입니다: ' + name);
  if (hardExcluded(normalized)) throw new Error('보호된 파일은 복원할 수 없습니다: ' + normalized);
  return normalized;
}

function verifyRestoreArchive(plan, extracted) {
  if (!plan || !Array.isArray(plan.files)) throw new Error('저장본 복원 계획에 파일 목록이 없습니다.');
  const expected = new Map();
  for (const file of plan.files) {
    const relative = safeRestorePath(file?.path);
    if (expected.has(relative)) throw new Error('저장본 복원 계획에 중복 경로가 있습니다: ' + relative);
    const byteSize = Number(file?.byte_size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || typeof file?.content_hash !== 'string') throw new Error('저장본 복원 메타데이터가 올바르지 않습니다: ' + relative);
    expected.set(relative, { byteSize, contentHash: file.content_hash });
  }
  const planned = [];
  for (const [name, bytes] of Object.entries(extracted)) {
    const relative = safeRestorePath(name);
    const metadata = expected.get(relative);
    if (!metadata) throw new Error('저장본 압축 파일에 계획되지 않은 파일이 있습니다: ' + relative);
    if (bytes.byteLength !== metadata.byteSize) throw new Error('파일 크기 확인에 실패했습니다: ' + relative);
    const actual = crypto.createHash('sha256').update(bytes).digest('base64url');
    if (!metadata.contentHash || metadata.contentHash !== actual) throw new Error('파일 무결성 확인에 실패했습니다: ' + relative);
    planned.push([relative, bytes]);
    expected.delete(relative);
  }
  if (expected.size) throw new Error('저장본 압축 파일에 계획된 파일이 없습니다: ' + [...expected.keys()].join(', '));
  assertNonOverlappingPlan(planned.map(([relative]) => relative));
  return planned;
}

function verifyCheckpointIdentity(planned, projectId) {
  const entry = planned.find(([relative]) => isLocalIdentityFile(relative));
  if (!entry) return;
  const identity = Buffer.from(entry[1]).toString('utf8').trim();
  if (!identity || identity !== String(projectId)) {
    throw new Error('저장본 프로젝트 연결 정보가 현재 프로젝트와 일치하지 않습니다.');
  }
}

function assertNonOverlappingPlan(relatives) {
  const paths = new Map();
  for (const relative of relatives) {
    const key = relative.toLowerCase();
    if (paths.has(key)) throw new Error('저장본에 중복된 교차 플랫폼 경로가 있습니다: ' + relative);
    paths.set(key, relative);
  }
  for (const relative of paths.values()) {
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      if (paths.has(parts.slice(0, length).join('/').toLowerCase())) throw new Error('저장본에 파일/디렉터리 경로 충돌이 있습니다: ' + relative);
    }
  }
}

function restoreTarget(relative) {
  const root = fs.realpathSync.native(ROOT);
  const parts = relative.split('/');
  const target = path.resolve(root, ...parts);
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) throw new Error('복원 경로가 프로젝트 밖을 가리킵니다: ' + relative);
  const blockers = [];
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('복원 경로에 심볼릭 링크 또는 junction이 있습니다: ' + parts.slice(0, index + 1).join('/'));
    const actual = fs.realpathSync.native(current);
    const actualRelative = path.relative(root, actual);
    if (actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative)) throw new Error('복원 경로가 프로젝트 밖을 가리킵니다: ' + relative);
    const isTarget = index === parts.length - 1;
    if ((!isTarget && !stat.isDirectory()) || (isTarget && !stat.isFile())) {
      blockers.push(parts.slice(0, index + 1).join('/'));
      break;
    }
  }
  return { blockers, target };
}

function backupAndRemove(relatives, backupRoot) {
  const sorted = [...new Set(relatives)].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const selected = sorted.filter((candidate) => !sorted.some((parent) => parent !== candidate && candidate.startsWith(parent + '/')));
  const backupRelative = posix(path.relative(ROOT, backupRoot));
  const backupTarget = restoreDirectoryTarget(backupRelative);
  fs.mkdirSync(backupTarget, { recursive: true });
  for (const relative of selected) {
    const location = restoreTarget(relative);
    if (location.blockers.length) throw new Error('백업 경로가 로컬 파일에 막혀 있습니다: ' + relative);
    let stat;
    try { stat = fs.lstatSync(location.target); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    const backup = path.join(backupTarget, ...relative.split('/'));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (stat.isDirectory()) fs.cpSync(location.target, backup, { recursive: true, errorOnExist: true });
    else fs.copyFileSync(location.target, backup, fs.constants.COPYFILE_EXCL);
    fs.rmSync(location.target, { recursive: stat.isDirectory(), force: true });
  }
}

function restoreDirectoryTarget(relative) {
  const normalized = posix(String(relative || '')).replace(/^\/+/, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..' || part === '' || part === '.' || /[ .]$/.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))) throw new Error('안전하지 않은 백업 경로입니다: ' + relative);
  const root = fs.realpathSync.native(ROOT);
  const target = path.resolve(root, ...normalized.split('/'));
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) throw new Error('백업 경로가 프로젝트 밖을 가리킵니다: ' + relative);
  let current = root;
  for (const [index, part] of normalized.split('/').entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('백업 경로에 심볼릭 링크 또는 junction이 있습니다: ' + normalized.split('/').slice(0, index + 1).join('/'));
    if (!stat.isDirectory()) throw new Error('백업 디렉터리 경로가 파일에 막혀 있습니다: ' + normalized);
  }
  return target;
}

async function restoreCheckpoint() {
  const checkpointId = decodedArg('--checkpoint', '--checkpoint-base64') || arg('--checkpoint-id');
  if (!checkpointId) throw new Error('--checkpoint 저장본_ID가 필요합니다.');
  const target = connection();
  const base = '/v1/projects/' + encodeURIComponent(target.projectId) + '/checkpoints/' + encodeURIComponent(checkpointId);
  const plan = await apiFetch(target, base + '/restore-plan');
  const response = await apiFetch(target, base + '/download', { raw: true });
  const extracted = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const planned = verifyRestoreArchive(plan, extracted);
  verifyCheckpointIdentity(planned, target.projectId);
  const writable = planned.filter(([relative]) => !isLocalRestoreMarker(relative));
  const plannedPaths = new Set([...planned.map(([relative]) => portablePathKey(relative)), ...LOCAL_RESTORE_MARKERS]);
  const additions = [];
  const overwrites = [];
  const conflictPaths = new Set();
  for (const [relative, bytes] of writable) {
    const location = restoreTarget(relative);
    if (location.blockers.length) {
      overwrites.push(relative);
      for (const blocker of location.blockers) conflictPaths.add(blocker);
    } else if (!fs.existsSync(location.target)) additions.push(relative);
    else if (!Buffer.from(fs.readFileSync(location.target)).equals(Buffer.from(bytes))) {
      overwrites.push(relative);
      conflictPaths.add(relative);
    }
  }
  const deletions = projectFiles().map(([relative]) => relative).filter((relative) => !plannedPaths.has(portablePathKey(relative)));
  console.log('추가 ' + additions.length + '개, 덮어쓰기 ' + overwrites.length + '개, 삭제 ' + deletions.length + '개');
  for (const name of additions) console.log('+ ' + name);
  for (const name of overwrites) console.log('~ ' + name);
  for (const name of deletions) console.log('- ' + name);
  if (!process.argv.includes('--apply')) {
    console.log('미리보기만 했습니다. 승인 후 --apply를 붙여 다시 실행하세요.');
    return;
  }
  await saveCheckpoint('복원 전 안전 저장본', false, 'restore_safety');
  const backupRoot = path.join(ROOT, '.joripspace', 'local-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  backupAndRemove([...conflictPaths, ...deletions], backupRoot);
  for (const [relative, bytes] of writable) {
    const location = restoreTarget(relative);
    if (location.blockers.length) throw new Error('복원 대상이 로컬 파일에 막혀 있습니다: ' + location.blockers.join(', '));
    fs.mkdirSync(path.dirname(location.target), { recursive: true });
    fs.writeFileSync(location.target, bytes);
  }
  ensureProjectEnvSafety();
  for (const [relative, bytes] of writable) {
    const restored = fs.readFileSync(restoreTarget(relative).target);
    if (!Buffer.from(restored).equals(Buffer.from(bytes))) throw new Error('복원 후 무결성 확인에 실패했습니다: ' + relative);
  }
  console.log('로컬 파일을 복원했습니다. 운영 서버는 변경하지 않았습니다.');
}

async function deployCheckpoint() {
  const checkpointId = decodedArg('--checkpoint', '--checkpoint-base64') || arg('--checkpoint-id');
  if (!checkpointId) throw new Error('--checkpoint 저장본_ID가 필요합니다.');
  const target = connection();
  const result = await apiFetch(target, '/v1/projects/' + encodeURIComponent(target.projectId) + '/checkpoints/' + encodeURIComponent(checkpointId) + '/deploy', { method: 'POST', json: {} });
  console.log('저장본을 배포했습니다: ' + (result.url || target.projectId));
}

export async function runCheckpointCommand(command) {
  if (command === 'save') return saveCheckpoint(decodedArg('--label', '--label-base64'), process.argv.includes('--deploy'));
  if (command === 'list') return listCheckpoints();
  if (command === 'restore') return restoreCheckpoint();
  if (command === 'deploy') return deployCheckpoint();
  throw new Error('알 수 없는 저장본 명령입니다.');
}
`;
}

function checkpointHelperWrapper(command) {
  return `#!/usr/bin/env node\nimport { runCheckpointCommand } from './checkpoint-client.mjs';\nrunCheckpointCommand('${command}').catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });\n`;
}

function projectSaveHelperFile() {
  return checkpointHelperWrapper('save');
}
function projectCheckpointsHelperFile() {
  return checkpointHelperWrapper('list');
}
function projectRestoreHelperFile() {
  return checkpointHelperWrapper('restore');
}
function projectDeployCheckpointHelperFile() {
  return checkpointHelperWrapper('deploy');
}

function projectInstallTemplateHelperFile() {
  return String.raw`#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const template = required(args.template, '--template');
const project = required(args.project || readProjectId(), '--project');
const target = path.resolve(args.dir || '.');
const connection = resolveSourceBoundConnection(process.cwd());
const apiUrl = connection.apiBaseUrl;
const token = required(connection.apiToken, 'JORIPSPACE_API_TOKEN');
const headers = { Authorization: 'Bearer ' + token, 'X-Joripspace-Session-Context': 'agent-helper' };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-template-'));
try {
  const claim = await fetch(apiUrl + '/v1/templates/' + encodeURIComponent(template) + '/claim', { method: 'POST', headers });
  if (!claim.ok && ![404, 409].includes(claim.status)) throw await responseError(claim);
  let granted = null;
  let updateCurrent = false;
  if (!args.filesOnly) {
    if (args.update) {
      const state = templateState(target);
      if (!state || state.slug !== template) throw new Error('현재 작업공간의 템플릿 계보가 일치하지 않습니다.');
      const check = await fetch(apiUrl + '/v1/templates/' + encodeURIComponent(template) + '/git-update?project_id=' + encodeURIComponent(project) + '&current_head=' + encodeURIComponent(state.git_head_sha), { headers });
      if (!check.ok) throw await responseError(check);
      const available = await check.json();
      if (!available.update_available) {
        console.log('Template is already current: ' + template);
        console.log('Template HEAD: ' + state.git_head_sha);
        updateCurrent = true;
      }
      if (!updateCurrent && !args.yes) throw new Error('템플릿 업데이트 ' + available.version + '을 사용할 수 있습니다. 변경 내용을 확인하고 사용자 동의를 받은 뒤 --yes를 붙여 다시 실행하세요.');
    }
    if (!updateCurrent) {
      const grant = await fetch(apiUrl + '/v1/templates/' + encodeURIComponent(template) + '/git-bundle-grants?project_id=' + encodeURIComponent(project), { method: 'POST', headers });
      if (grant.ok) {
        const metadata = await grant.json();
        const bundle = await fetch(metadata.download_url);
        if (!bundle.ok) throw await responseError(bundle);
        granted = { metadata, bytes: Buffer.from(await bundle.arrayBuffer()) };
      } else if (grant.status !== 409) throw await responseError(grant);
    }
  }
  if (updateCurrent) {
    // Availability checks are read-only and need no further action.
  } else if (granted) {
    await applyGitHistory(target, template, granted.bytes, granted.metadata, Boolean(args.update), temp);
  } else {
      if (args.update) throw new Error('파일만 설치한 템플릿은 template pull로 업데이트할 수 없습니다.');
      const response = await fetch(apiUrl + '/v1/templates/' + encodeURIComponent(template) + '/download?project_id=' + encodeURIComponent(project), { headers });
      if (!response.ok) throw await responseError(response);
      const archive = path.join(temp, 'template.tar.gz');
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      const extract = path.join(temp, 'extract');
      fs.mkdirSync(extract);
      const inventory = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      if (inventory.status !== 0) throw new Error('템플릿 압축 목록을 확인하지 못했습니다.');
      for (const line of String(inventory.stdout || '').split(/\r?\n/).filter(Boolean)) {
        const archivePath = line.replace(/\\/g, '/');
        const parts = archivePath.split('/');
        if (archivePath.startsWith('/') || parts.some((part) => part === '..')) {
          throw new Error('템플릿 압축에 안전하지 않은 경로가 포함되어 있습니다.');
        }
      }
      const types = spawnSync('tar', ['-tzvf', archive], { encoding: 'utf8' });
      if (types.status !== 0 || String(types.stdout || '').split(/\r?\n/).some((line) => ['l', 'h'].includes(line[0]))) {
        throw new Error('템플릿 압축에 안전하지 않은 링크가 포함되어 있습니다.');
      }
      const unpack = spawnSync('tar', ['-xzf', archive, '-C', extract], { encoding: 'utf8' });
      if (unpack.status !== 0) throw new Error('템플릿 압축을 풀지 못했습니다: ' + String(unpack.stderr || unpack.stdout || 'tar 실행 실패').trim());
      const roots = fs.readdirSync(extract, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      if (roots.length !== 1) throw new Error('템플릿 압축 구조가 올바르지 않습니다.');
      const repositoryRoot = path.join(extract, roots[0].name);
      const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'joripspace-template.json'), 'utf8'));
      const sourceRoot = safeRelative(String(manifest.source_root || '.'));
      const source = sourceRoot === '.' ? repositoryRoot : path.join(repositoryRoot, ...sourceRoot.split('/'));
      const files = collectFiles(source);
      const collisions = files.map((file) => path.join(target, ...file.relative.split('/'))).filter(fs.existsSync);
      if (collisions.length && !args.force) throw new Error('템플릿이 기존 파일 ' + collisions.length + '개와 충돌합니다. 아무 파일도 덮어쓰지 않았습니다.');
      for (const file of files) {
        const destination = path.join(target, ...file.relative.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file.absolute, destination);
      }
      console.log('Template installed: ' + template);
      console.log('Directory: ' + target);
      console.log('Files: ' + files.length);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith('--')) continue;
    if (key === '--force' || key === '--update' || key === '--files-only' || key === '--yes') {
      result[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
    }
    else result[key.slice(2)] = values[++index] || '';
  }
  return result;
}
function required(value, label) { if (!value) throw new Error(label + ' 값이 필요합니다.'); return String(value); }
${projectEnvReaderSource()}
function readProjectId() {
  return readProjectMarker(process.cwd());
}
function safeRelative(value) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (normalized === '.') return normalized;
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('템플릿 source_root가 안전하지 않습니다.');
  return normalized;
}
function collectFiles(root) {
  if (!fs.statSync(root).isDirectory()) throw new Error('템플릿 source_root를 찾을 수 없습니다.');
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('템플릿에 심볼릭 링크가 포함되어 있습니다.');
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push({ relative: safeRelative(relative), absolute });
    }
  };
  visit(root);
  if (!files.length) throw new Error('템플릿에 설치할 파일이 없습니다.');
  return files;
}
function installPublicGitClone(target, slug, source, temp) {
  const remoteUrl = githubRemoteUrl(source.remote_url);
  const remoteRef = gitBranchRef(source.remote_ref);
  const remoteBranch = remoteRef.slice('refs/heads/'.length);
  fs.mkdirSync(target, { recursive: true });
  const existingRepository = isGitRepository(target);
  if (existingRepository) {
    if (gitResult(target, ['rev-parse', '--verify', 'HEAD']).status === 0) return null;
    if (git(target, ['ls-files', '-z']).length) return null;
  }
  const cloneDir = path.join(temp, 'public-clone');
  const clone = gitResult(target, [...cloneLocalConfigArgs(target), 'clone', '--branch', remoteBranch, '--single-branch', '--no-tags', remoteUrl, cloneDir]);
  if (clone.status !== 0) return null;
  const head = gitSha(git(cloneDir, ['rev-parse', 'HEAD']).trim());
  const files = git(cloneDir, ['ls-files', '-z']).split('\0').filter(Boolean);
  const allowedCollisions = new Set(['package.json', '.gitignore']);
  const collisions = files.filter((file) => fs.existsSync(path.join(target, ...file.split('/'))) && !allowedCollisions.has(file));
  if (collisions.length) return null;
  const previousPackage = readJson(path.join(target, 'package.json'));
  const previousGitignore = readOptionalText(path.join(target, '.gitignore'));
  if (!existingRepository) git(target, ['init']);
  const branch = gitResult(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branchName = branch.status === 0 && String(branch.stdout || '').trim() ? String(branch.stdout || '').trim() : 'main';
  for (const file of allowedCollisions) {
    const destination = path.join(target, file);
    if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  }
  try {
    git(target, ['fetch', '--no-tags', cloneDir, remoteRef]);
    git(target, ['checkout', '-B', branchName, 'FETCH_HEAD']);
  } catch (error) {
    restoreOptionalText(path.join(target, 'package.json'), previousPackage && JSON.stringify(previousPackage, null, 2) + '\n');
    restoreOptionalText(path.join(target, '.gitignore'), previousGitignore);
    throw error;
  }
  mergeManagedPackageScripts(path.join(target, 'package.json'), previousPackage);
  mergeGitignore(path.join(target, '.gitignore'), previousGitignore);
  configureTemplateRemote(target, remoteUrl, remoteRef);
  git(target, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
  writeClonedTemplateState(target, slug, source, head);
  return { head };
}
function cloneLocalConfigArgs(target) {
  const result = [];
  const rewrites = gitResult(target, ['config', '--get-regexp', '^url\\..*\\.insteadOf$']);
  if (rewrites.status === 0) {
    for (const line of String(rewrites.stdout || '').split(/\r?\n/).filter(Boolean)) {
      const separator = line.search(/\s/);
      if (separator > 0) result.push('-c', line.slice(0, separator) + '=' + line.slice(separator).trim());
    }
  }
  const fileProtocol = gitResult(target, ['config', '--get', 'protocol.file.allow']);
  if (fileProtocol.status === 0 && String(fileProtocol.stdout || '').trim()) {
    result.push('-c', 'protocol.file.allow=' + String(fileProtocol.stdout || '').trim());
  }
  return result;
}
async function applyGitHistory(target, slug, bundle, metadata, updateOnly, temp) {
  const expectedHash = String(metadata.bundle_sha256 || '').toLowerCase();
  const actualHash = crypto.createHash('sha256').update(bundle).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || !crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw new Error('템플릿 Git bundle 무결성 확인에 실패했습니다.');
  }
  const head = gitSha(metadata.git_head_sha);
  const sourceRef = gitBranchRef(metadata.git_ref);
  if (!['refs/heads/main', 'refs/heads/joripspace-template-main'].includes(sourceRef)) throw new Error('템플릿 Git ref가 올바르지 않습니다.');
  git(target, ['--version'], true);
  if (!isGitRepository(target)) {
    if (updateOnly) throw new Error('템플릿 업데이트는 Git 저장소에서만 실행할 수 있습니다.');
    fs.mkdirSync(target, { recursive: true });
    git(target, ['init']);
  }
  const gitDirectory = path.resolve(target, git(target, ['rev-parse', '--git-dir']).trim());
  const bundleDirectory = path.join(gitDirectory, 'joripspace');
  fs.mkdirSync(bundleDirectory, { recursive: true });
  const candidatePath = path.join(bundleDirectory, 'upstream-' + crypto.randomUUID() + '.bundle');
  const bundlePath = path.join(bundleDirectory, 'upstream.bundle');
  const backupPath = path.join(bundleDirectory, 'upstream.bundle.previous');
  fs.writeFileSync(candidatePath, bundle, { flag: 'wx' });
  git(target, ['bundle', 'verify', candidatePath]);
  git(target, ['fetch', '--no-tags', candidatePath, sourceRef + ':refs/joripspace/candidate']);
  const fetchedHead = git(target, ['rev-parse', 'refs/joripspace/candidate']).trim().toLowerCase();
  if (fetchedHead !== head) throw new Error('템플릿 Git HEAD가 bundle과 일치하지 않습니다.');
  const state = templateState(target);
  if (updateOnly) {
    if (!state || state.slug !== slug) throw new Error('현재 작업공간의 템플릿 계보가 일치하지 않습니다.');
    if (state.git_head_sha === head) {
      installBundleRemote(target, candidatePath, bundlePath, backupPath, sourceRef);
      writeTemplateState(target, slug, metadata, head);
      git(target, ['add', '.joripspace/template.json']);
      if (gitResult(target, ['diff', '--cached', '--quiet']).status !== 0) {
        ensureGitIdentity(target);
        git(target, ['commit', '-m', '조립스페이스 공식 업데이트 채널 연결: ' + slug]);
      }
      console.log('Template is already current: ' + slug);
      return;
    }
    if (gitResult(target, ['merge-base', '--is-ancestor', gitSha(state.git_head_sha), head]).status !== 0) {
      throw new Error('템플릿 히스토리가 변경되어 자동 업데이트를 중단했습니다.');
    }
    if (git(target, ['status', '--porcelain']).trim()) {
      throw new Error('커밋되지 않은 변경이 있습니다. commit 또는 stash 후 다시 실행하세요.');
    }
    ensureGitIdentity(target);
    const merge = gitResult(target, ['merge', '--no-ff', '--no-commit', head]);
    if (merge.status !== 0) {
      throw new Error('템플릿 병합 충돌이 발생했습니다. 강제 덮어쓰기 없이 충돌을 해결해 주세요.\n' + String(merge.stderr || merge.stdout || '').trim());
    }
    installBundleRemote(target, candidatePath, bundlePath, backupPath, sourceRef);
    writeTemplateState(target, slug, metadata, head);
    git(target, ['add', '.joripspace/template.json']);
    git(target, ['commit', '-m', '조립스페이스 템플릿 업데이트: ' + slug]);
    console.log('Template updated: ' + slug);
    console.log('Template HEAD: ' + head);
    return;
  }

  if (state) throw new Error('이미 템플릿 계보가 연결된 작업공간입니다. 업데이트 명령을 사용하세요.');
  ensureGitIdentity(target);
  const extract = path.join(temp, 'git-tree');
  const treeArchive = path.join(temp, 'git-tree.tar');
  fs.mkdirSync(extract);
  git(target, ['archive', '--format=tar', '--output', treeArchive, head]);
  const unpack = spawnSync('tar', ['-xf', treeArchive, '-C', extract], { encoding: 'utf8', windowsHide: true });
  if (unpack.status !== 0) throw new Error('템플릿 Git 트리를 풀지 못했습니다: ' + String(unpack.stderr || unpack.stdout || '').trim());
  const files = collectFiles(extract);
  const collisions = files.filter((file) => file.relative !== 'package.json').map((file) => path.join(target, ...file.relative.split('/'))).filter(fs.existsSync);
  if (collisions.length && !args.force) throw new Error('템플릿이 기존 파일 ' + collisions.length + '개와 충돌합니다. 아무 파일도 덮어쓰지 않았습니다.');
  const previousPackage = readJson(path.join(target, 'package.json'));
  for (const file of files) {
    const destination = path.join(target, ...file.relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolute, destination);
  }
  mergeManagedPackageScripts(path.join(target, 'package.json'), previousPackage);
  installBundleRemote(target, candidatePath, bundlePath, backupPath, sourceRef);
  writeTemplateState(target, slug, metadata, head);
  for (const file of files) git(target, ['add', '--', file.relative]);
  git(target, ['add', '.joripspace/template.json']);
  if (gitResult(target, ['diff', '--cached', '--quiet']).status !== 0) {
    git(target, ['commit', '-m', '조립스페이스 템플릿 설치: ' + slug]);
  }
  const lineage = gitResult(target, ['merge', '--strategy=ours', '--no-edit', '--allow-unrelated-histories', head]);
  if (lineage.status !== 0) throw new Error('템플릿 Git 계보를 연결하지 못했습니다: ' + String(lineage.stderr || lineage.stdout || '').trim());
  console.log('Template installed with Git history: ' + slug);
  console.log('Directory: ' + target);
  console.log('Template HEAD: ' + head);
}
function installBundleRemote(target, candidatePath, bundlePath, backupPath, sourceRef) {
  const current = gitResult(target, ['config', '--get', 'remote.upstream.url']);
  if (current.status === 0 && String(current.stdout || '').trim() !== '.git/joripspace/upstream.bundle') {
    throw new Error('기존 upstream remote는 조립스페이스 관리 채널이 아닙니다.');
  }
  if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
  if (fs.existsSync(bundlePath)) fs.renameSync(bundlePath, backupPath);
  try { fs.renameSync(candidatePath, bundlePath); }
  catch (error) {
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, bundlePath);
    throw error;
  }
  if (current.status !== 0) git(target, ['remote', 'add', 'upstream', '.git/joripspace/upstream.bundle']);
  git(target, ['config', '--replace-all', 'remote.upstream.fetch', sourceRef + ':refs/remotes/upstream/main']);
  git(target, ['config', '--replace-all', 'remote.upstream.tagOpt', '--no-tags']);
  git(target, ['fetch', '--no-tags', 'upstream']);
  git(target, ['update-ref', '-d', 'refs/joripspace/candidate']);
  if (gitResult(target, ['remote', 'get-url', 'joripspace-template']).status === 0) git(target, ['remote', 'remove', 'joripspace-template']);
  if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
}
function templateState(target) {
  const file = path.join(target, '.joripspace', 'template.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('.joripspace/template.json 형식이 올바르지 않습니다.'); }
}
function writeTemplateState(target, slug, metadata, head) {
  const directory = path.join(target, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'template.json'), JSON.stringify({
    schema_version: 3,
    slug,
    template_id: String(metadata.template_id || ''),
    version_id: String(metadata.version_id || ''),
    version: String(metadata.version || ''),
    git_head_sha: head,
    remote_ref: 'refs/remotes/upstream/main'
  }, null, 2) + '\n');
}
function applyGitRemote(target, slug, remoteUrl, remoteRef) {
  const state = templateState(target);
  if (!state || state.slug !== slug) throw new Error('현재 작업공간의 템플릿 계보가 일치하지 않습니다.');
  if (!isGitRepository(target)) throw new Error('템플릿 업데이트는 Git 저장소에서만 실행할 수 있습니다.');
  if (git(target, ['status', '--porcelain']).trim()) {
    throw new Error('커밋되지 않은 변경이 있습니다. commit 또는 stash 후 다시 실행하세요.');
  }
  git(target, ['fetch', '--no-tags', remoteUrl, remoteRef]);
  const head = gitSha(git(target, ['rev-parse', 'FETCH_HEAD']).trim());
  const previousHead = gitSha(state.git_head_sha);
  if (head === previousHead) {
    configureTemplateRemote(target, remoteUrl, remoteRef);
    git(target, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
    console.log('Template is already current: ' + slug);
    console.log('Template HEAD: ' + head);
    return;
  }
  if (gitResult(target, ['merge-base', '--is-ancestor', previousHead, head]).status !== 0) {
    throw new Error('템플릿 히스토리가 변경되어 자동 업데이트를 중단했습니다.');
  }
  ensureGitIdentity(target);
  const merge = gitResult(target, ['merge', '--no-ff', '--no-commit', head]);
  if (merge.status !== 0) {
    throw new Error('템플릿 병합 충돌이 발생했습니다. 강제 덮어쓰기 없이 충돌을 해결해 주세요.\n' + String(merge.stderr || merge.stdout || '').trim());
  }
  configureTemplateRemote(target, remoteUrl, remoteRef);
  git(target, ['update-ref', 'refs/remotes/joripspace-template/main', head]);
  writeRemoteTemplateState(target, state, remoteUrl, remoteRef, head);
  git(target, ['add', '.joripspace/template.json']);
  git(target, ['commit', '-m', '조립스페이스 템플릿 업데이트: ' + slug]);
  console.log('Template updated: ' + slug);
  console.log('Template HEAD: ' + head);
}
function writeRemoteTemplateState(target, state, remoteUrl, remoteRef, head) {
  const directory = path.join(target, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'template.json'), JSON.stringify({
    ...state,
    schema_version: 2,
    git_head_sha: head,
    remote_ref: 'refs/remotes/joripspace-template/main',
    remote_url: remoteUrl,
    remote_branch_ref: remoteRef
  }, null, 2) + '\n');
}
function writeClonedTemplateState(target, slug, source, head) {
  const directory = path.join(target, '.joripspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'template.json'), JSON.stringify({
    schema_version: 2,
    slug,
    template_id: source.template_id,
    version_id: source.version_id,
    version: source.version,
    git_head_sha: head,
    remote_ref: 'refs/remotes/joripspace-template/main',
    remote_url: githubRemoteUrl(source.remote_url),
    remote_branch_ref: gitBranchRef(source.remote_ref)
  }, null, 2) + '\n');
}
function configureTemplateRemote(target, remoteUrl, remoteRef) {
  const current = gitResult(target, ['config', '--get', 'remote.joripspace-template.url']);
  if (current.status === 0) {
    if (String(current.stdout || '').trim() !== remoteUrl) throw new Error('기존 joripspace-template remote가 다른 저장소를 가리킵니다.');
  } else {
    git(target, ['remote', 'add', 'joripspace-template', remoteUrl]);
  }
  git(target, ['config', '--replace-all', 'remote.joripspace-template.fetch', '+' + remoteRef + ':refs/remotes/joripspace-template/main']);
  git(target, ['config', '--replace-all', 'remote.joripspace-template.pushurl', 'disabled://joripspace-template-push']);
  configureTemplateUpstream(target, remoteRef);
}
function configureTemplateUpstream(target, remoteRef) {
  const origin = gitResult(target, ['config', '--get', 'remote.origin.url']);
  if (origin.status === 0 && String(origin.stdout || '').trim()) return;
  const branch = gitResult(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branchName = String(branch.stdout || '').trim();
  if (branch.status !== 0 || !branchName) return;
  git(target, ['config', 'branch.' + branchName + '.remote', 'joripspace-template']);
  git(target, ['config', 'branch.' + branchName + '.merge', remoteRef]);
  git(target, ['config', 'branch.' + branchName + '.rebase', 'false']);
}
function githubRemoteUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('템플릿 Git remote URL이 올바르지 않습니다.'); }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(part))) {
    throw new Error('템플릿 Git remote URL이 올바르지 않습니다.');
  }
  return 'https://github.com/' + parts[0] + '/' + parts[1].replace(/\.git$/i, '') + '.git';
}
function gitBranchRef(value) {
  const normalized = String(value || '');
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(normalized) || normalized.includes('..')) throw new Error('템플릿 Git remote ref가 올바르지 않습니다.');
  return normalized;
}
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function mergeManagedPackageScripts(file, previous) {
  if (!fs.existsSync(file) || !previous) return;
  const current = readJson(file);
  if (!current) return;
  current.scripts = current.scripts && typeof current.scripts === 'object' ? current.scripts : {};
  for (const [name, command] of Object.entries(previous.scripts || {})) {
    if (name.startsWith('joripspace:')) current.scripts[name] = command;
  }
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
}
function readOptionalText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function restoreOptionalText(file, value) {
  if (value !== null && value !== undefined) fs.writeFileSync(file, value);
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
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
function isGitRepository(target) {
  const result = gitResult(target, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0 && String(result.stdout || '').trim() === 'true';
}
function ensureGitIdentity(target) {
  const name = gitResult(target, ['config', '--get', 'user.name']);
  const email = gitResult(target, ['config', '--get', 'user.email']);
  if (name.status !== 0 || email.status !== 0 || !String(name.stdout || '').trim() || !String(email.stdout || '').trim()) {
    throw new Error('Git user.name과 user.email 설정이 필요합니다.');
  }
}
function git(target, values, withoutDirectory = false) {
  const result = withoutDirectory
    ? spawnSync('git', values, { encoding: 'utf8', windowsHide: true })
    : gitResult(target, values);
  if (result.error?.code === 'ENOENT') throw new Error('git 명령을 찾을 수 없습니다.');
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'git 실행 실패').trim());
  return String(result.stdout || '');
}
function gitResult(target, values) {
  return spawnSync('git', ['-C', target, ...values], { encoding: 'utf8', windowsHide: true });
}
function header(headers, name) {
  const value = String(headers.get(name) || '').trim();
  if (!value) throw new Error('템플릿 응답에 ' + name + ' 값이 없습니다.');
  return value;
}
function gitSha(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error('템플릿 Git SHA가 올바르지 않습니다.');
  return normalized;
}
async function responseError(response) {
  const text = await response.text();
  try { const parsed = JSON.parse(text); return new Error(parsed?.error?.message || parsed?.message || 'HTTP ' + response.status); }
  catch { return new Error(text || 'HTTP ' + response.status); }
}
`;
}

function onboardingGitignoreContent() {
  return `${JORIPSPACE_ONBOARDING_GITIGNORE_ENTRIES.join('\n')}\n`;
}

function projectAgentSessionFile(projectConfig = {}) {
  const projectId = String(projectConfig.project_id || '');
  const projectSlug = String(projectConfig.project_slug || projectId);
  return `${JSON.stringify(
    {
      schema_version: 2,
      scope: 'shared_workspace',
      project: {
        id: projectId,
        slug: projectSlug,
        config_file: '.joripspace/project',
      },
      agent_guide: {
        updated_at: String(projectConfig.agent_guide_updated_at || JORIPSPACE_AGENT_GUIDE_UPDATED_AT),
      },
      collaboration: {
        git_tracked: true,
      },
      local_auth: {
        env_file: '.env.joripspace',
        required_environment: ['JORIPSPACE_API_TOKEN'],
        credential_values_in_session: false,
      },
    },
    null,
    2
  )}\n`;
}

module.exports = {
  JORIPSPACE_AGENT_GUIDE_UPDATED_AT,
  JORIPSPACE_WORKFLOW_POLICY,
  JORIPSPACE_ONBOARDING_GITIGNORE_ENTRIES,
  JORIPSPACE_PACKAGE_HELPER_SCRIPTS,
  JORIPSPACE_PACKAGE_HELPER_DEPENDENCIES,
  SERVICE_EXAMPLE_LINES,
  BEGINNER_ONBOARDING_LINES,
  USER_CHOICE_PRESENTATION_RULE_LINES,
  LOCAL_TOOL_READINESS_RULE_LINES,
  GUIDE_REFRESH_ONLY_RULE_LINES,
  JORIPSPACE_BUILD_DEPLOYMENT_AUTHORITY_LINES,
  FIRST_QUESTION_LINES,
  CODEX_MCP_ONBOARDING_LINES,
  CODEX_MCP_USER_CONNECT_MESSAGE_LINES,
  SECRET_RULE_LINES,
  PAYMENT_PROVIDER_GUIDANCE_LINES,
  PROJECT_CAPABILITY_LINES,
  REALTIME_DEVELOPMENT_RULE_LINES,
  PROJECT_PLAN_LIMIT_LINES,
  PROJECT_DOMAIN_LINES,
  PROJECT_CRON_LINES,
  IMAGE_AND_FILE_PLACEMENT_LINES,
  FRAMEWORK_SELECTION_LINES,
  SEO_SSR_LINES,
  FRAMEWORK_DEPLOYMENT_PRIORITY_LINES,
  AGENT_OPERATING_RULE_LINES,
  DEPLOYMENT_VERIFICATION_RULE_LINES,
  CHECKPOINT_AGENT_RULE_LINES,
  AFTER_CONNECTION_RULE_LINES,
  REQUIRED_ONBOARDING_MARKERS,
  beginnerStartPrompt,
  beginnerStartPrompts,
  projectAgentsFile,
  projectClaudeFile,
  projectMarkerFile,
  upsertProjectAgentsContent,
  projectPackageHelperScripts,
  projectPackageHelperDependencies,
  projectDoctorHelperFile,
  projectDeployHelperFile,
  projectPullHelperFile,
  projectCheckpointClientFile,
  projectSaveHelperFile,
  projectCheckpointsHelperFile,
  projectRestoreHelperFile,
  projectDeployCheckpointHelperFile,
  projectInstallTemplateHelperFile,
  projectGithubActionsTemplateFile,
  templateGithubActionsPublishFile,
  onboardingGitignoreContent,
  projectAgentSessionFile,
  JORIPSPACE_ONBOARDING_GITIGNORE_REMOVALS,
};
