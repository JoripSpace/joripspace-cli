function githubSourceSnapshotStep() {
  const script = `${GITHUB_SOURCE_SCRIPT}\n\nawait snapshotGithubSource();`
    .split('\n')
    .map((line) => `          ${line}`)
    .join('\n');
  return `      - name: Preserve original source
        shell: bash
        run: |
          node --input-type=module <<'JORIPSPACE_SOURCE'
${script}
          JORIPSPACE_SOURCE
`;
}

const GITHUB_SOURCE_STAGE_COMMAND = `          if [[ -e "$stage_dir/.joripspace-source" || -L "$stage_dir/.joripspace-source" ]]; then
            echo "::error::Artifact uses the reserved .joripspace-source path" >&2
            exit 1
          fi
          cp -R "$RUNNER_TEMP/joripspace-source-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" "$stage_dir/.joripspace-source"`;

const GITHUB_SOURCE_SCRIPT = [
  "async function snapshotGithubSource() {",
  "  const { execFileSync, spawnSync } = await import('node:child_process');",
  "  const { lstat, mkdir, copyFile } = await import('node:fs/promises');",
  "  const { join } = await import('node:path');",
  "  const root = process.env.GITHUB_WORKSPACE;",
  "  const target = join(",
  "    process.env.RUNNER_TEMP,",
  "    `joripspace-source-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`",
  "  );",
  "  const files = execFileSync('git', ['ls-files', '--cached', '-z'], {",
  "    cwd: root,",
  "    encoding: 'utf8',",
  "    maxBuffer: 16 * 1024 * 1024,",
  "  })",
  "    .split('\\0')",
  "    .filter(Boolean);",
  "  const excluded = new Set();",
  "  for (const rules of ['.ignore', '.joripspaceignore']) {",
  "    const result = spawnSync(",
  "      'git',",
  "      ['-c', `core.excludesFile=${join(root, rules)}`, 'check-ignore', '--no-index', '-z', '--stdin'],",
  "      {",
  "        cwd: root,",
  "        input: files.join('\\0') + '\\0',",
  "        encoding: 'utf8',",
  "        maxBuffer: 16 * 1024 * 1024,",
  "      }",
  "    );",
  "    if (result.error || ![0, 1].includes(result.status))",
  "      throw new Error('Original source ignore check failed.');",
  "    for (const file of result.stdout.split('\\0').filter(Boolean)) excluded.add(file);",
  "  }",
  "  await mkdir(target);",
  "  for (const file of files) {",
  "    const parts = file.toLowerCase().split('/');",
  "    const base = parts.at(-1);",
  "    if (",
  "      excluded.has(file) ||",
  "      parts.some((part) =>",
  "        [",
  "          '.git',",
  "          'node_modules',",
  "          '.wrangler',",
  "          '.cache',",
  "          'coverage',",
  "          'tmp',",
  "          'temp',",
  "          '.joripspace',",
  "          '.joripspace-artifact',",
  "          '.joripspace-source',",
  "          '.agents',",
  "          '.claude',",
  "          '.codex',",
  "          '.cursor',",
  "          '.gemini',",
  "          '.opencode',",
  "        ].includes(part)",
  "      ) ||",
  "      ['agents.md', 'claude.md', '.ds_store', 'thumbs.db', 'desktop.ini'].includes(base) ||",
  "      base.startsWith('.env') ||",
  "      base.startsWith('.dev.vars') ||",
  "      /\\.(?:log|tmp|temp|pem|key)$/i.test(base)",
  "    )",
  "      continue;",
  "    let source = root;",
  "    for (const part of file.split('/')) {",
  "      if (!part || part === '.' || part === '..') throw new Error('Unsafe original source path.');",
  "      source = join(source, part);",
  "      if ((await lstat(source)).isSymbolicLink())",
  "        throw new Error('Original source contains a symbolic link.');",
  "    }",
  "    if (!(await lstat(source)).isFile()) throw new Error('Original source must be a regular file.');",
  "    await mkdir(join(target, ...file.split('/').slice(0, -1)), { recursive: true });",
  "    await copyFile(source, join(target, file));",
  "  }",
  "}",
].join('\n');

module.exports = { githubSourceSnapshotStep, GITHUB_SOURCE_STAGE_COMMAND, GITHUB_SOURCE_SCRIPT };
