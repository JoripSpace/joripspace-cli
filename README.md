# JoripSpace CLI

**JoripSpace — Build and deploy web apps with AI agents. Powered by Cosmosfarm.**

The official Node.js command-line client for JoripSpace. Connect your projects and manage deployments, databases, storage, and realtime services from your terminal.

[Website](https://joripspace.com) · [Support](mailto:support@cosmosfarm.com) · [GitHub](https://github.com/JoripSpace/joripspace-cli)

## Quick start

Run with npx. No global installation is required:

```sh
npx -y @joripspace/cli@latest --help
npx -y @joripspace/cli@latest templates --json
npx -y @joripspace/cli@latest realtime-v2 docs --json
```

Requires **Node.js 18 or later and npm** on Windows, macOS, or Linux. No TypeScript compiler or native build tools are needed. The CLI runs directly in Node.js; it does not download an OS-specific executable. Installation does not build source code, log you in, open a browser, or change project settings.

## Connect a project

Run commands from your project directory. Quote paths containing spaces or non-ASCII characters.

```sh
npx -y @joripspace/cli@latest login
npx -y @joripspace/cli@latest login --code "YOUR_CONNECTION_CODE" --cwd "my project"
npx -y @joripspace/cli@latest start my-app --cwd "my project" --json
npx -y @joripspace/cli@latest get --cwd "my project" --json
```

Follow the link from `login` to [JoripSpace Connect](https://joripspace.com/connect/), approve the connection, and copy the one-time code, which expires after five minutes. Replace `my-app` with your existing project slug.

`login --code` stores the connection token and API URL in the project's Git-ignored `.env.joripspace` file. A regular `.env` file is not used for authentication. Subsequent npx runs reuse the same project credentials, so you do not need to log in each time. Credentials and project state are not stored inside the npm package or cache.

Without `--cwd`, the CLI uses your current working directory and searches parent directories for the project connection. Existing `.joripspace/project` markers, the `--project` alias, environment variables, and legacy credential validation and migration remain supported. The default API is `https://api.joripspace.com`; use the existing `--api-url` option or `JORIPSPACE_API_URL` environment variable to override it.

`start` connects to or resumes an existing project; it does not create a new project. It maintains project guidance files and synchronizes the required source files using the existing CLI behavior. This npm package preserves the original commands and compatibility modules without adding agent detection, MCP registration, plugins, skills, or hooks.

## Optional global installation

```sh
npm install -g @joripspace/cli
joripspace --help
```

You can continue using npx instead. Global installation and permanent PATH changes are not required.

## Commands and compatibility

Use `--help`, `deploy --help`, `deploy-template --help`, or `install-template --help` for the supported commands and options. Existing functionality includes authentication, project inspection, deployment, templates, checkpoints, databases, storage, realtime v2, secrets, cron jobs, domains, mail, usage, and events. Operations restricted to the web interface remain restricted.

The CLI preserves existing output formats and exit codes `0`, `1`, and `2`. With `--json`, successful results go to stdout and errors go to stderr. CLI messages retain their existing language; this release updates the package documentation and description.

Installation and ordinary API commands require only Node.js and npm. Existing GitHub source connection and Git history synchronization features also require Git. Interactive `start` opens the browser using Windows `cmd.exe`, macOS `open`, or Linux `xdg-open`. If opening a browser fails, you can open the printed URL yourself.

The `executable` field in a `start` response is the absolute path to the JavaScript entrypoint. Use `node "path/to/entrypoint" ...` or npx to run it. The `login_command`, `resume_command`, and `install_command` fields include the Node.js executable. In PowerShell, prefix a quoted executable path with the call operator `&`. JSON keys and structure remain unchanged.

## Development and package verification

This repository works independently of the platform repository. It reuses the existing JavaScript implementation and requires no compilation. `prepack` checks package metadata, JavaScript syntax, the Node shebang, and executable permissions. There are no installation lifecycle hooks.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

`test:package` creates a real tarball in `.artifacts/` and checks its files, hashes, licenses, and permissions. It verifies installation, npx, npm exec, arguments, output, exit codes, working directories, cancellation, and credential reuse through a local mock API. Tests run in temporary directories outside the repository, including paths with spaces and Korean characters. They do not modify production projects or actual user credentials.

Set `JORIPSPACE_BASELINE_CLI` to the original `bin/joripspace.js` path to compare against the original CLI; otherwise, comparisons use this repository's source. GitHub CI covers Windows, macOS, and Linux with Node.js 18, 20, 22, and 24. It does not upload artifacts, cache dependencies, or publish to GitHub Packages.

To try a tarball before publishing, use its absolute path:

```sh
npm exec --yes --package="/absolute/path/joripspace-cli-0.4.2.tgz" -- joripspace --help
```

On Windows, use a path such as `C:/path/to/joripspace-cli-0.4.2.tgz`. Detailed engineering records are available in [verification](docs/verification.md) and [packaging](docs/packaging.md) (Korean).

## License

JoripSpace CLI is available under the [MIT License](LICENSE).

Copyright (c) 2026 Cosmosfarm Software

Use of the JoripSpace cloud service is subject to separate service terms and pricing plans. Platform server, administration, and infrastructure code are not included in this CLI distribution. Included Worker examples are public customer templates.

Third-party dependencies retain their original licenses and copyrights. See [Third-party notices](THIRD_PARTY_NOTICES.md) for the preserved license texts.

## Support

- Website: [joripspace.com](https://joripspace.com)
- Email: [support@cosmosfarm.com](mailto:support@cosmosfarm.com)
- Bug reports: [GitHub Issues](https://github.com/JoripSpace/joripspace-cli/issues)
