# Local npm release

JoripSpace CLI is a single Node.js package for Windows, macOS, and Linux. It does not build or publish operating-system-specific executables.

Run releases from a clean checkout on a trusted local machine:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run test:package
npm pack --dry-run
npm whoami
npm publish --access public
```

After publishing, verify the registry and a clean `npx` execution:

```sh
npm view @joripspace/cli@latest version
npx -y @joripspace/cli@latest --version
npx -y @joripspace/cli@latest templates --json
```

Commit and push source changes with Git separately. GitHub Actions are not used for package tests or publishing.
