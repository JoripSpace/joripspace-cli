# JoripSpace CLI

**JoripSpace — Build and deploy web apps with AI agents. Powered by Cosmosfarm.**

The official command-line client for JoripSpace. Connect a project, deploy your app, and manage its database, files, Secrets, and realtime services from your terminal or coding agent.

The CLI runs on Windows, macOS, and Linux with **Node.js 18 or later and npm**. It runs directly in Node.js, so you do not need a TypeScript compiler or native build tools to install it.

[Website](https://joripspace.com) · [Documentation](https://joripspace.com/en/docs/) · [CLI reference](https://joripspace.com/en/docs/cli/) · [GitHub](https://github.com/JoripSpace/joripspace-cli) · [Support](mailto:support@cosmosfarm.com)

## Install and update

Install the CLI, then check the version your terminal runs:

```sh
npm install -g @joripspace/cli@latest
joripspace --version
```

To update an existing installation, run the same install command again. Global installations do not update automatically. You can check the latest published version with:

```sh
npm view @joripspace/cli@latest version
```

If the version stays the same after an update, your terminal may still be using an older installation. Check its location with `Get-Command joripspace -All` in PowerShell or `command -v joripspace` on macOS and Linux. For an npm installation, `npm root -g` shows the directory containing `@joripspace/cli/bin/joripspace.js`, which you can run with Node.

You can also run the CLI without a global installation:

```sh
npx -y @joripspace/cli@latest --help
npx -y @joripspace/cli@latest start PROJECT --json
```

This selects the latest published npm release. Replace `PROJECT` with your existing project name. Installing the package does not log you in or change your project settings.

## Connect a project

Open your project folder and run:

```sh
joripspace login
joripspace projects
joripspace start PROJECT --json
```

Follow the link to [JoripSpace Connect](https://joripspace.com/connect/), approve the connection in your browser, and enter the one-time code within five minutes. You can then connect a project and continue from its current source and deployment state.

`start` connects an existing project. It also prepares the project instructions for your agent and synchronizes source files when required by the connection. To create a project first, see [Create a project](#create-a-project) below.

To work in another folder, add `--cwd`. Quote paths that contain spaces:

```sh
joripspace start my-app --cwd "my project" --json
joripspace get --cwd "my project" --json
```

Without `--cwd`, the CLI uses the current folder and searches its parent folders for a project connection. The connected project name is recorded in `.joripspace/project`.

## Work with a coding agent

Use an agent that can run terminal commands, edit files, and access the network. You can send it this prompt after replacing `PROJECT` with your project name:

```text
Help me get started with JoripSpace project "PROJECT".
1. Install or update the official CLI with npm install -g @joripspace/cli@latest.
   Compare the version that actually runs with the latest version on npm.
   If an older executable is still selected, find and use the updated npm CLI.
2. Run joripspace start PROJECT --json and read its onboarding guide
   and the project instruction files to complete the connection.
3. Review the existing project and explain the next steps for my task.
```

If approval is needed, the response includes a connection link and commands to sign in and resume. After approving the connection, give your agent the five-minute code. It can pass the code without waiting for terminal input:

```sh
joripspace login --code "CONNECTION_CODE" --json
joripspace start PROJECT --json
```

The CLI connection works without a plugin or MCP setup. If you also use MCP, its client has a separate sign-in process. Reuse a saved CLI login or complete the CLI connection flow when switching between them. See the [MCP connection guide](https://joripspace.com/en/docs/mcp/) for client setup and tool details.

### Project instructions

`start` returns a guide and writes it into a marked JoripSpace section in `AGENTS.md`. New files place `User instructions` first, followed by `JoripSpace managed instructions`. Existing user content is preserved, and `CLAUDE.md` keeps a reference to `AGENTS.md`.

Your agent can use the returned guide immediately. If it does not load project files automatically, ask it to read the listed files in the current conversation. No agent restart is needed for this workflow.

The guide explains how to find relevant CLI help, MCP tools, and task guidance as needed. You do not have to copy every command option into your project instructions. The [task workflows](https://joripspace.com/en/docs/agent-workflows/) show how to use these tools for deployment, database changes, service connections, and reports.

## Find a command

Start with the CLI help, then open the help for the command you want to use:

```sh
joripspace --help
joripspace deploy --help
joripspace report --help
```

| Task | Commands |
| --- | --- |
| Connect and inspect a project | `login`, `start`, `projects`, `get` |
| Deploy and inspect history | `deploy`, `deployments`, `deployment get`, `deployment pull`, `rollback` |
| Find and install templates | `templates`, `template list`, `install-template`, `template pull` |
| Work with a database | `db schema`, `db query`, `db migrate` |
| Manage stored files | `storage list`, `storage get`, `storage put`, `storage delete` |
| Save and restore work | `checkpoint save`, `checkpoint list`, `checkpoint restore`, `checkpoint deploy` |
| Manage Secrets | `secret list`, `secret generate`, `secret set`, `secret update` |
| Manage realtime services | `realtime-v2 status`, `realtime-v2 activate`, `realtime-v2 keys` |
| Connect domains, schedules, and mail | `domain`, `cron`, `mail` |
| Inspect errors and usage | `events`, `usage-summary`, `usage-breakdown` |
| Prepare GitHub workflows or find guidance | `github prepare`, `knowledge search` |
| Report a problem or suggest an improvement | `report` |
| Identify or revoke a connection token | `tokens current`, `tokens revoke` |

The [CLI reference](https://joripspace.com/en/docs/cli/) covers the command groups and common options. GitHub source synchronization and template Git history features also require Git.

## Report a problem or suggest an improvement

Use `report` while connected to the relevant project. Choose `problem` for a general issue, `bug` for a defect, or `feedback` for an improvement idea:

```sh
joripspace report --project PROJECT --category bug --summary "Deployment status is incorrect" --details "Steps to reproduce the issue" --json
joripspace report --project PROJECT --category feedback --summary "Add deployment history filters" --expected "Search by label" --json
```

A summary is required. You can add context with `--details`, describe the desired and current behavior with `--expected` and `--actual`, or include an error code with `--error-code`. CLI, Node.js, and OS information is attached automatically.

Review the content before sending and leave out credentials, personal data, and private source code. If you are working with an agent, ask it to submit the report when you are ready. A successful response includes the report ID, `report_id`. If the response is interrupted, the report may already have been received, so avoid sending the same report repeatedly.

`feedback` is a category of `report`, not a separate command. The feedback category and dedicated `report --help` are available in CLI 0.6.1 and later.

## Revoke an exposed connection token

If a connection token has been exposed, you can disable it on the server. First check its ID, then revoke the current token:

```sh
joripspace tokens current
joripspace tokens revoke --current
```

`tokens current` shows the ID without revealing the token value. Revoking the token ends the current connection and any MCP sessions using the same token. Use a fresh connection code to connect again.

To revoke a token from an older connection, sign in with another valid token in the same account and specify the exact ID:

```sh
joripspace tokens revoke --token-id TOKEN_ID
```

Check the target ID before running the command. You can also disable tokens on the API token page in your web profile. These CLI commands are available in 0.6.1 and later. `logout` removes a saved local login; it does not revoke the server token.

## Saved logins

The CLI saves new logins in Windows Credential Manager, macOS Keychain, or Linux Secret Service when available. You can reuse that login across project folders under the same OS account. The project's Git-ignored `.env.joripspace` then contains only connection details such as the API URL, account ID, and connection source. An ordinary application `.env` file is not used for CLI authentication.

If an OS credential store is unavailable before saving, the CLI stores the token in the selected project's `.env.joripspace` instead. This fallback is used only for that project. Keep the file out of Git, deployments, and checkpoints. The login response identifies the storage method as `os-credential-store` or `project-env-fallback`.

If an OS credential write or verification fails, login stops without creating a file fallback. Once the store is available, running `login` can move an existing project-file token into it and remove the token from the file.

`logout` removes the saved token entries in the current project file and the matching OS credential when available. Because an OS login is shared, removing it also affects other folders that use it. Other legacy folders and credentials supplied through environment variables are separate. A later OS login can be reused across folders, including folders where you previously logged out.

For automation, supply `JORIPSPACE_API_TOKEN` and its matching `JORIPSPACE_API_URL` through the process environment. The default API address is `https://api.joripspace.com`; `--api-url` can select another endpoint. Existing project markers, `--project`, environment authentication, and legacy credential migration remain supported.

## Project Secrets

If your app needs a random value, such as a session signing key, generate one without displaying it:

```sh
joripspace secret generate --name SESSION_SECRET --json
joripspace secret list --json
```

An existing active value is preserved. For a key issued by an external provider, use `secret set --name API_KEY --value-stdin --json`, or its alias, `secret update`. Pass the exact value through standard input rather than command arguments, chat, logs, source, or temporary project files. Input must be 1–5120 UTF-8 bytes; whitespace and newlines are preserved. Secret values are never returned.

You can also enter a key on the selected project's Secret page. `start` and Secret command responses include its `secret_management_url`, which your agent can show as a clickable link. Choose **Register or replace** to save the value, then check the name, status, and change time with `secret list`. Test the service connection afterward. Secret deletion remains a web operation, and all changes require project access and valid, non-reserved key names.

## Create a project

To create a new Free project, run `joripspace create --name my-app --json` first. It returns all three required agreements
in English with the Korean web originals. Login is verified with the server before any agreements are shown;
missing or revoked credentials stop creation. Agents must present the agreements faithfully in the user's language
and obtain explicit consent before rerunning with `--agree-noncommercial --agree-billing --agree-retention --json`. Interactive
terminals ask each agreement separately. `--yes` cannot replace consent. Web/server name restrictions and uniqueness
checks apply. Creation does not link or change local project source; use `start` separately when requested.

## JSON output and agent integrations

Add `--json` for structured output without browser launch or interactive prompts. Successful results go to stdout, and errors go to stderr. Existing result fields and exit codes `0`, `1`, and `2` are preserved. The shared agent guide is English; CLI notices and prompts follow the OS locale, using Korean for `ko` and English otherwise. JSON field names and error codes remain unchanged. Agreement payloads retain the English text and Korean originals so agents can explain them in your conversation language.

The `onboarding` object provides `schema_version`, `instructions`, `read_files`, `invocation`, and `commands`. It also appears under `error.details.onboarding` when authentication is required, along with the login and resume steps.

For tools that accept a command and argument list, run `invocation.command`, append CLI arguments after `invocation.args`, and use `invocation.cwd` as the working folder. With an npm installation, this runs Node with the absolute JavaScript entrypoint. The `executable`, `login_command`, `resume_command`, and `install_command` fields remain available for existing integrations. In PowerShell, use `&` before a quoted executable path.

If an interactive connection cannot open a browser, open the printed URL yourself. Interactive `start` uses Windows `cmd.exe`, macOS `open`, or Linux `xdg-open` for that step.

## What's new in 0.6.1

- Submit improvement suggestions with `report --category feedback` and read the dedicated `report --help`.
- Identify the current connection token and revoke exposed tokens with `tokens current` and `tokens revoke`.
- Keep user instructions separate from the managed JoripSpace section in `AGENTS.md`, with existing user content preserved.
- The onboarding guide now asks your coding agent to check the running CLI version against npm, use the CLI when available, and keep CLI and MCP logins separate.
- Find current command options and task guidance as needed, with links to the public CLI, MCP, and workflow documentation.

## Development and package verification

This repository works independently of the platform repository and runs without a compilation step. To check the source and package:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

The package's `prepack` check validates metadata, JavaScript syntax, the Node shebang, and executable permissions. There are no installation lifecycle hooks.

`test:package` builds a tarball in `.artifacts/` and checks its contents, hashes, licenses, and permissions. It then verifies clean installation, npx, npm exec, arguments, output, exit codes, working folders, cancellation, and saved login reuse against a local mock API. Temporary test folders include paths with spaces and Korean characters. Production projects and real user credentials are not used.

Set `JORIPSPACE_BASELINE_CLI` to an original `bin/joripspace.js` to compare against that CLI. Otherwise, comparisons use this repository's source. To try the tarball before publishing:

```sh
npm exec --yes --package="/absolute/path/joripspace-cli-VERSION.tgz" -- joripspace --help
```

Replace `VERSION` with the tarball version. On Windows, use a path such as `C:/path/to/joripspace-cli-VERSION.tgz`. See the [release guide](https://github.com/JoripSpace/joripspace-cli/blob/main/docs/release.md) for the local publishing procedure. Package checks and npm publishing run locally; this repository does not use GitHub Actions for them.

## License

JoripSpace CLI is available under the [MIT License](LICENSE).

Copyright (c) 2026 Cosmosfarm Software

Use of the JoripSpace cloud service is subject to separate service terms and pricing plans. Platform server, administration, and infrastructure code are not included in this CLI distribution. Included Worker examples are public customer templates.

Third-party dependencies retain their original licenses and copyrights. See [Third-party notices](THIRD_PARTY_NOTICES.md) for the preserved license texts.

## Support

- Documentation: [CLI reference](https://joripspace.com/en/docs/cli/) · [MCP connection and tools](https://joripspace.com/en/docs/mcp/) · [Task workflows](https://joripspace.com/en/docs/agent-workflows/)
- Platform problems and suggestions: use `joripspace report` from a connected project.
- CLI repository issues: [GitHub Issues](https://github.com/JoripSpace/joripspace-cli/issues)
- Email: [support@cosmosfarm.com](mailto:support@cosmosfarm.com)
