const DEFAULT_API_URL = 'https://api.joripspace.com';

function printHelp() {
  console.log(`JoripSpace CLI

Usage:
  joripspace login
  joripspace login --code "복사한_연결_코드" --cwd PROJECT_FOLDER
  joripspace login --connect-token "복사한_연결_토큰" --cwd PROJECT_FOLDER
  joripspace me
  joripspace projects
  joripspace link --project PROJECT --cwd PATH
  joripspace start PROJECT --cwd PATH --json
  joripspace knowledge search --query "사용자 요청"
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
  joripspace deploy --project PROJECT --token TOKEN --source worker.js --label "첫 배포"
  joripspace templates
  joripspace template list --project PROJECT --cursor CURSOR
  joripspace deploy-template --project PROJECT --token TOKEN --template basic-worker --label "기본 템플릿 배포" --var MESSAGE=Hello
  joripspace install-template --project PROJECT --token TOKEN --template TEMPLATE --dir . --deploy
  joripspace install-template --project PROJECT --token TOKEN --template TEMPLATE --dir . --files-only
  joripspace template pull --project PROJECT --token TOKEN --dir . [--yes]
  joripspace get --project PROJECT --token TOKEN
  joripspace deployments --project PROJECT --token TOKEN [--include-failure-details] [--json]
  joripspace deployment get --project PROJECT --deployment DEPLOYMENT_ID --json
  joripspace deployment pull --project PROJECT --deployment DEPLOYMENT_ID --cwd PATH [--force]
  joripspace checkpoint save --project PROJECT --token TOKEN --label "작업 완료"
  joripspace checkpoint list --project PROJECT --token TOKEN --limit 20
  joripspace checkpoint get --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint update --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID --label "이름"
  joripspace checkpoint restore --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint deploy --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID
  joripspace checkpoint delete --project PROJECT --token TOKEN --checkpoint CHECKPOINT_ID --yes
  joripspace rollback --project PROJECT --token TOKEN --deployment DEPLOYMENT_ID
  joripspace secrets --project PROJECT
  joripspace secret list --project PROJECT
  joripspace secret generate --project PROJECT --name SESSION_SECRET
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
  Run "joripspace login", open the shown link in a logged-in browser, approve connection,
  then exchange the displayed 5-minute connection code with --code.
  Existing connection tokens can still be saved with --connect-token.
  If a token is missing, do not inspect cookies, browser storage, or profile pages to find it.
  Open https://joripspace.com/connect/ and ask the user to paste the displayed connection code.
  The token and matching API URL are stored only in PROJECT_FOLDER/.env.joripspace. The CLI searches
  parent folders for this file. It never reads a generic application .env file for authentication.

Security:
  CLI tokens are for project lookup, workspace linking, project DB/storage work, server deployment, usage, and logs.
  Project checkpoints can be saved, restored locally, and deployed independently with the checkpoint command.
  Deployment rollback, value-blind Secret generation/listing, crons, domains, and mail status/test are available.
  Manage custom domains with the domain command.
  Manage members, billing, API tokens, external Secret values, webhooks, and project deletion in the web UI.

Global flags:
  --api-url URL
  --cwd PATH
  --json
  --help
`);
}

function printDeployHelp() {
  console.log(`JoripSpace deploy

Usage:
  joripspace deploy --project PROJECT --token TOKEN --source worker.js --label "첫 배포"

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
  joripspace deploy-template --project PROJECT --token TOKEN --template basic-worker --label "메시지 변경" --var MESSAGE=Hello

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
