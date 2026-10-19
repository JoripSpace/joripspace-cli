const DEFAULT_API_URL = 'https://api.joripspace.com';
const { message } = require('./locale');

function printHelp() {
  console.log(`JoripSpace CLI

Usage:
  joripspace login
  joripspace login --code "CONNECTION_CODE" --cwd PROJECT_FOLDER
  joripspace login --connect-token "CONNECTION_TOKEN" --cwd PROJECT_FOLDER
  joripspace logout
  joripspace me
  joripspace projects
  joripspace create --name NAME
  joripspace create --name NAME --agree-noncommercial --agree-billing --agree-retention --json
  joripspace link --project PROJECT --cwd PATH
  joripspace start PROJECT --cwd PATH --json
  joripspace github prepare --project PROJECT --cwd PATH [--entrypoint worker.js]
  joripspace knowledge search --query "USER_REQUEST"
  joripspace realtime-v2 docs
  joripspace realtime-v2 status --project PROJECT
  joripspace realtime-v2 activate --project PROJECT
  joripspace realtime-v2 rotate --project PROJECT
  joripspace realtime-v2 keys --project PROJECT --cursor CURSOR
  joripspace realtime-v2 revoke-key --project PROJECT --kid KEY_ID
  joripspace db schema --project PROJECT --token TOKEN
  joripspace db query --project PROJECT --token TOKEN --sql "SELECT name FROM sqlite_schema WHERE type = 'table'"
  joripspace db migrate --project PROJECT --token TOKEN --file migrations/001_init.sql
  joripspace storage list --project PROJECT --token TOKEN --prefix uploads/
  joripspace storage put --project PROJECT --token TOKEN --key uploads/hello.txt --text "hello"
  joripspace storage get --project PROJECT --token TOKEN --key uploads/hello.txt --out hello.txt
  joripspace storage delete --project PROJECT --token TOKEN --key uploads/hello.txt
  joripspace deploy --project PROJECT --token TOKEN --source worker.js --label "First deployment"
  joripspace templates
  joripspace template list --project PROJECT --cursor CURSOR
  joripspace deploy-template --project PROJECT --token TOKEN --template basic-worker --label "Deploy basic template" --var MESSAGE=Hello
  joripspace install-template --project PROJECT --token TOKEN --template TEMPLATE --dir . --deploy
  joripspace install-template --project PROJECT --token TOKEN --template TEMPLATE --dir . --files-only
  joripspace template pull --project PROJECT --token TOKEN --dir . [--yes]
  joripspace get --project PROJECT --token TOKEN
  joripspace report --project PROJECT --category bug --summary "ISSUE_SUMMARY" [--details TEXT] [--expected TEXT] [--actual TEXT] [--error-code CODE]
  joripspace deployments --project PROJECT --token TOKEN [--include-failure-details] [--json]
  joripspace deployment get --project PROJECT --deployment DEPLOYMENT_ID --json
  joripspace deployment pull --project PROJECT --deployment DEPLOYMENT_ID --cwd PATH [--force]
  joripspace checkpoint save --project PROJECT --token TOKEN --label "Work completed"
  joripspace checkpoint list --project PROJECT --token TOKEN --limit 20
  joripspace checkpoint get --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint update --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID --label "Checkpoint name"
  joripspace checkpoint restore --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint deploy --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint delete --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID --yes
  joripspace rollback --project PROJECT --token TOKEN --deployment DEPLOYMENT_ID
  joripspace secrets --project PROJECT
  joripspace secret list --project PROJECT
  joripspace secret generate --project PROJECT --name SESSION_SECRET
  joripspace secret set --project PROJECT --name API_KEY --value-stdin
  joripspace secret update --project PROJECT --name API_KEY --value-stdin
  joripspace crons --project PROJECT
  joripspace cron create --project PROJECT --schedule "0 * * * *" --path /jobs/hourly
  joripspace cron run --project PROJECT --cron-id CRON_ID
  joripspace cron delete --project PROJECT --cron-id CRON_ID --yes
  joripspace domains --project PROJECT --token TOKEN
  joripspace domain create --project PROJECT --token TOKEN --hostname www.example.com
  joripspace domain verify --project PROJECT --token TOKEN --hostname www.example.com
  joripspace domain delete --project PROJECT --token TOKEN --hostname www.example.com --yes
  joripspace mail connect --project PROJECT
  joripspace mail status --project PROJECT
  joripspace mail test --project PROJECT [--to ADDRESS] [--subject TEXT]
  joripspace events --project PROJECT --token TOKEN --event-type error
  joripspace usage-summary --project PROJECT --from 2026-06-01 --to 2026-06-30
  joripspace usage-breakdown --project PROJECT --from 2026-06-01 --to 2026-06-30 --group-by day
  joripspace usage-breakdown --project PROJECT --from 2026-06-01 --to 2026-06-30 --group-by month

Environment:
  JORIPSPACE_API_URL      Defaults to ${DEFAULT_API_URL}
  JORIPSPACE_ACCOUNT_ID   Used when --account is omitted
  JORIPSPACE_API_TOKEN    Used when --token is omitted
  JORIPSPACE_CONNECT_TOKEN Used when no API token is provided

Login:
  Run "joripspace login" in a terminal, approve the browser connection,
  then paste the displayed 5-minute connection code at the prompt.
  Agents use --json and pass the connection code with --code; they are never prompted.
  Existing connection tokens can still be saved with --connect-token.
  If a token is missing, do not inspect cookies, browser storage, or profile pages to find it.
  Open https://joripspace.com/connect/ and ask the user to paste the displayed connection code.
  New logins store tokens in Windows Credential Manager, macOS Keychain, or Linux Secret Service.
  Saved connections are reused in other project folders on the same OS user account.
  PROJECT_FOLDER/.env.joripspace stores only the API URL and account reference for new logins.
  Existing token-bearing .env.joripspace files and process environment tokens remain supported.
  Run login in an existing connected folder to move its token to the OS store without a new code.
  The CLI searches parent folders and never reads an ordinary application .env for authentication.
  If the OS store is unavailable or locked, new logins fail without a plaintext fallback.
  A successful connection also logs you in; no separate login step is required.
  logout removes the current account's OS credential and the current folder's legacy credentials.
  It does not revoke server tokens or remove credentials in other legacy project folders.
  Environment/command-line tokens must be unset by the caller before logout.

Project creation:
  create only creates a Free project; start only connects to an existing project.
  Login is verified with the server before any agreements are shown. Run login first if required.
  Names follow the same 3-50 character format, reserved-name, brand, and duplicate checks as the web.
  Terminals ask for each required agreement. JSON/agent calls return all agreement texts first.
  Agents must translate the full agreements into the user's language and get explicit consent
  before passing --agree-noncommercial, --agree-billing, and --agree-retention.
  --yes does not accept these agreements. Creation does not link or modify local project source.

Security:
  CLI tokens are for project lookup, workspace linking, project DB/storage work, server deployment, usage, and logs.
  Project checkpoints can be saved, restored locally, and deployed independently with the checkpoint command.
  Deployment rollback, value-blind Secret generation/listing, crons, domains, and mail status/test are available.
  Manage custom domains with the domain command.
  Manage members, billing, API tokens, external Secret values, webhooks, and project deletion in the web UI.

${message('Language', '언어')}:
  ${message('Messages follow the OS default locale: Korean or English. Unsupported locales use English.', '안내는 OS 기본 로캘에 따라 한국어 또는 영어로 표시합니다. 미지원 로캘은 영어를 사용합니다.')}
  ${message("Agents should explain results in the user's conversation language.", '에이전트는 사용자의 대화 언어로 결과를 설명해야 합니다.')}

Global flags:
  --api-url URL
  --cwd PATH
  --json                 Machine-readable output; never opens a browser or prompts for input.
  --help
`);
}

function printDeployHelp() {
  console.log(`JoripSpace deploy

Usage:
  joripspace deploy --project PROJECT --token TOKEN --source worker.js --label "First deployment"

Options:
  --source PATH       Deploy one source file. Entrypoint defaults to the file basename.
  --dir PATH          Deploy every safe file under a directory. Authentication is resolved from --cwd.
  --file NAME=PATH    Add one file mapping. Can be repeated.
  --entrypoint NAME   Server module entrypoint.
  --label TEXT        Required deployment label, up to 120 characters.
`);
}

function printDeployTemplateHelp() {
  console.log(`JoripSpace deploy-template

Usage:
  joripspace templates
  joripspace deploy-template --project PROJECT --token TOKEN --template basic-worker --label "Update message" --var MESSAGE=Hello

Options:
  --template ID     Template id from the templates command.
  --var KEY=VALUE   Template variable. Can be repeated.
  --label TEXT      Required deployment label, up to 120 characters.
`);
}

function printInstallTemplateHelp() {
  console.log(`JoripSpace install-template

Usage:
  joripspace install-template --project PROJECT --token TOKEN --template TEMPLATE --dir . --deploy

Options:
  --template SLUG    Marketplace template slug.
  --dir PATH         Install directory. Defaults to the current directory.
  --files-only       Copy template files without connecting Git history or template pull.
  --force            Allow overwriting files with the same path.
  --deploy           Deploy after installing the files.
  --entrypoint PATH  Override the manifest entrypoint for deployment.
  --label TEXT       Deployment label. A default is used when omitted.

Template updates:
  "joripspace template pull" checks availability without downloading. Add --yes only after reviewing
  and approving the update; the bundle is then fetched through the local JoripSpace upstream channel.
`);
}

module.exports = { printHelp, printDeployHelp, printDeployTemplateHelp, printInstallTemplateHelp };
