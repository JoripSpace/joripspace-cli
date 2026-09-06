# JoripSpace CLI

Local command-line client for the JoripSpace Control API.

Official bootstrap scripts are served from `https://joripspace.com/install.ps1` for Windows and
`https://joripspace.com/install.sh` for macOS, Linux, and WSL. They automatically detect the native OS and CPU
(including Apple Silicon under Rosetta), verify the immutable installer size and SHA-256 from the public manifest,
run it with `--quiet --json`, and verify the fixed-path CLI again. Node.js, Git, and jq are not required.

Manual installers remain at `https://joripspace.com/download`: Windows x64/ARM64 executables, native macOS Apple
Silicon/Intel executables, and Linux x64/ARM64 `.run` installers. Version 0.3.0 is unsigned; never disable or bypass
operating-system security controls to run it.

The CLI is an adapter over shared platform contracts. Plan limits, usage storage totals, billing evidence fields,
domain validation, and deletion preservation rules are owned by `@joripspace/core`; CLI commands should follow those
contracts and avoid separate copies of the same policy.

```sh
npm run cli -- --help
npm run cli -- login --code "CONNECTION_CODE" --cwd PROJECT_ROOT
npm run cli -- start my-app --cwd PROJECT_ROOT
npm run cli -- deploy --project "my-app" --token "$API_TOKEN" --source worker.js
npm run cli -- templates
npm run cli -- deploy-template --project "my-app" --token "$API_TOKEN" --template basic-worker
npm run cli -- db schema --project "my-app" --token "$API_TOKEN"
npm run cli -- db migrate --project "my-app" --token "$API_TOKEN" --file migrations/001_init.sql
npm run cli -- storage list --project "my-app" --token "$API_TOKEN" --prefix uploads/
npm run cli -- storage put --project "my-app" --token "$API_TOKEN" --key uploads/hello.txt --text "hello"
```

The `--project` value is the project slug stored in `projects.slug`.
It is the same value shown in project URLs and used by MCP as `project_id`.
The `--token` value should normally be an account-scoped API token created from the logged-in browser connection/profile
flow. It is not the browser login cookie and it is not tied to one project.

If a token is missing, do not try to recover it by browsing around the account, inspecting cookies, reading browser
storage, or scraping profile pages. Open `https://joripspace.com/connect/` in a logged-in browser, approve the
connection, copy the displayed 5-minute connection code, then let the agent exchange it or save it with:

```sh
npm run cli -- login --code "복사한_연결_코드"
```

Previously issued tokens remain compatible and can still be saved with `--connect-token`.

Login writes the token and its matching API URL to the selected project's ignored `.env.joripspace`. The CLI never
uses a project's ordinary `.env` as its authentication file. Use `--cwd PROJECT_ROOT` to select the destination.

The CLI defaults to the production Control API and can be pointed elsewhere with `--api-url` or `JORIPSPACE_API_URL`.

CLI tokens are project-agent credentials. They are intended for project lookup, workspace linking, project DB/storage
work, server deployment, deployment rollback, usage, logs, custom domain operations, and project cron operations.
Secret names can be listed and a value-blind secret can be generated with `secret list` and `secret generate` without
revealing a value. External secret set/delete, members, billing, API tokens, webhooks, routing blocks, project creation,
and project deletion are managed in the web UI.

`joripspace start PROJECT --cwd PROJECT_ROOT --json` is the idempotent onboarding and resume command. It looks up an
existing project by name or slug, never creates one, safely synchronizes an eligible source baseline, and maintains only
`.joripspace/project`, the JoripSpace block in `AGENTS.md`, and the first-line
`@AGENTS.md` reference in `CLAUDE.md`. The marker contains exactly one lowercase project slug. Legacy generated metadata
is removed only after its schema and project identity are verified; nonstandard files are preserved and reported.

Agents continue with the absolute CLI executable returned by `start`; `start` does not inspect or change user MCP
configuration, and no project-local Node helper scripts are generated or required. For a new empty project, its response
embeds the first marketplace template page in `template_choice` so the agent presents the numbered template list before
asking service questions. Provider keys and tokens stay out of source,
agent configuration, and browser JavaScript. The token and matching API URL live only in ignored `.env.joripspace`.
Project mail connection is available through CLI `mail connect`, `mail status`, and `mail test`. Agents call
`mail connect` first. If it returns `smtp_setup_available`, ask the user to open the returned
JoripSpace mail tab URL and enter provider credentials in the web UI; do not ask for SMTP credentials in chat. If it
returns `browser_google_consent_required`, ask the user to open the returned connection URL, then use the corresponding
CLI status and test commands after approval. Do not put SMTP credentials in source code.
Treat that returned link as the JoripSpace mail connection start URL, and do not implement a separate mail integration.
It also reports `Project Plans And Limits`: server/API requests, storage, DB, realtime messages, and realtime concurrent
connections are limited by the saved project plan. `quota_blocked` means the project exceeded an included allowance and
is blocked without surprise overage billing. `plan_required` means the requested feature, such as a personal custom
domain on Free, needs a higher plan. Unlimited metered usage is OFF by default; when enabled on Starter or higher,
overages keep running and continue to be recorded in the billing ledger. Speed boost is a Starter-and-higher add-on:
12,900원 monthly base fee, 10GB included accelerated traffic, and extra traffic charged from `bytes_in + bytes_out`
at 350원/GB on Starter, 300원/GB on Pro, and 250원/GB on Business. Billing evidence uses `speed_boost_base` and
`speed_boost_traffic_overage`.
For custom domains, the web UI is the easiest path for non-technical users, while agents can use CLI domain commands.
After creating a domain, show the CNAME target, ask the user to set it at their DNS provider, then
verify the domain status. Default project domains are lifecycle-managed and cannot be deleted.

```bash
joripspace domains --project "$PROJECT_ID" --token "$JORIPSPACE_API_TOKEN"
joripspace domain create --project "$PROJECT_ID" --token "$JORIPSPACE_API_TOKEN" --hostname www.example.com
joripspace domain verify --project "$PROJECT_ID" --token "$JORIPSPACE_API_TOKEN" --hostname www.example.com
joripspace domain delete --project "$PROJECT_ID" --token "$JORIPSPACE_API_TOKEN" --hostname www.example.com
```

It also reports image and file placement guidance: fixed site design assets such as hero images, logos, screenshots,
icons, and examples stay in project files such as `public/images/...` and are part of the deployment source, while
user-uploaded files, gallery photos, attachments, generated documents, and other operational files use `env.STORAGE`
with metadata in `env.DB`.

`joripspace deployment pull --cwd PROJECT_ROOT` restores deployed source without overwriting conflicts. Add `--force`
only for an explicitly requested replacement; conflicting local work is copied first to the user-specific JoripSpace
data directory outside the project. The native CLI fallback does not require a project-local Node.js installation.

Agents choose the framework/build path from the project state. New services should default to a pure Worker app, use
plain HTML/CSS/JS for simple static pages, use a Vite SPA plus Worker API for larger UI, and only deploy Next.js after
local static export or an OpenNext/Cloudflare-compatible conversion.

After `start`, the current agent continues through the returned absolute CLI path. The agent should ask only for missing product context after the template choice, choose technical
defaults, create files, deploy when requested, and verify the public URL without requiring an app restart.
The copyable prompt should be neutral and task-focused; it should not ask users to label themselves as beginners.
Generated `AGENTS.md` tells coding agents to use "서버", "DB", "스토리지", and "실시간" in ordinary user-facing answers.
It still documents implementation paths such as `env.DB`, `env.STORAGE`, `run_db_migration`, storage tools, and
`/_joripspace/realtime?room=main` so agents can implement and debug without inventing one-off routes.

Generated `AGENTS.md` also includes Payment Provider Guidance. For payment features, agents should explain the type and
use only the guided partner signup links: 토스페이먼츠 - 일반결제 for domestic one-time payments
(`https://onboarding.tosspayments.com/registration/entry/funnelmoa?utm_source=funnelmoa&utm_medium=hosting`),
토스페이먼츠 - 빌링결제 for recurring billing/subscriptions
(`https://onboarding.tosspayments.com/registration/entry/funnelmoa_bill?utm_source=funnelmoa_bill&utm_medium=hosting`),
and 도도 페이먼츠 - 글로벌 SaaS 결제 for global SaaS or digital-product payments
(`https://app.dodopayments.com/partners/POhKqoePmZ/signup`). 결제 연동을 쓰려면 안내된 링크로 가입해 주세요.
해당 링크로 가입해야 JoripSpace 연동 개발과 서비스 이용을 진행할 수 있습니다.
토스페이먼츠 일반결제와 빌링결제(정기결제)는 조립스페이스 온보딩 링크로 가입해야 가입비가 면제되고
조립스페이스에서 이용할 수 있습니다. 토스페이먼츠 홈페이지에서 직접 가입하도록 안내하지 말고 필요한 결제 유형의
온보딩 링크를 제공해야 합니다.

If deployment fails with `project_resources_invalid`, `project_db_binding_invalid`, or Cloudflare wording such as
`binding DB` / `database_id`, treat it as a JoripSpace project resource issue instead of a user-code issue. Projects
should already have server, DB, and storage resources prepared at creation time; repair those resources first, then retry
the deploy.
