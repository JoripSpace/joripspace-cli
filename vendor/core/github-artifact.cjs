function githubArtifactCommand() {
  const script = `${GITHUB_ARTIFACT_SCRIPT}\n\nawait prepareGithubArtifact();`
    .split('\n').map((line) => `            ${line}`).join('\n');
  return `          JORIPSPACE_STAGE_DIR="$stage_dir" node --input-type=module <<'JORIPSPACE_ARTIFACT'
${script}
          JORIPSPACE_ARTIFACT`;
}

const GITHUB_ARTIFACT_SCRIPT = [
  "async function prepareGithubArtifact() {",
  "  const { readFile, writeFile, stat, rm } = await import('node:fs/promises');",
  "  const { join } = await import('node:path');",
  "  const stage = process.env.JORIPSPACE_STAGE_DIR;",
  "  const workspace = process.env.GITHUB_WORKSPACE;",
  "  let entrypoint = process.env.JORIPSPACE_ENTRYPOINT;",
  "  async function read(name) {",
  "    try { return await readFile(join(workspace, name), 'utf8'); }",
  "    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }",
  "  }",
  "  const explicit = await read('.joripspace-deploy.json');",
  "  const config = explicit ? JSON.parse(explicit) : {};",
  "  if (process.env.JORIPSPACE_ARTIFACT_PATH === '.joripspace-artifact') {",
  "    if (config.entrypoint) entrypoint = config.entrypoint;",
  "    else {",
  "      const candidates = [];",
  "      for (const name of ['dist/worker.js', 'dist/index.js', 'worker.bundle.js', '.open-next/worker.js']) {",
  "        try { if ((await stat(join(stage, name))).isFile()) candidates.push(name); }",
  "        catch (error) { if (error.code !== 'ENOENT') throw error; }",
  "      }",
  "      if (candidates.length > 1) throw new Error('Multiple build entrypoints found. Set entrypoint in .joripspace-deploy.json.');",
  "      if (candidates.length) entrypoint = candidates[0];",
  "    }",
  "  }",
  "  if (typeof entrypoint !== 'string' || !entrypoint || entrypoint.startsWith('/') || entrypoint.includes('\\\\') || entrypoint.split('/').some((part) => !part || part === '.' || part === '..')) {",
  "    throw new Error('Invalid deployment entrypoint');",
  "  }",
  "  if (!(await stat(join(stage, entrypoint))).isFile()) throw new Error('Build entrypoint does not exist');",
  "  if (process.env.JORIPSPACE_ARTIFACT_PATH === '.joripspace-artifact' && entrypoint !== 'worker.js') {",
  "    const original = 'worker.js';",
  "    if (!original.startsWith('/') && !original.includes('\\\\') && original.split('/').every((part) => part && part !== '.' && part !== '..')) {",
  "      await rm(join(stage, original), { force: true });",
  "    }",
  "  }",
  "  let flags = config.compatibility_flags;",
  "  if (flags === undefined) {",
  "    const wrangler = (await read('wrangler.jsonc') || await read('wrangler.json') || await read('wrangler.toml'))",
  "      .replace(/\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*/g,",
  "        (part) => /^(\\/\\/|\\/\\*|#)/.test(part) ? '' : part);",
  "    const list = /[\"']?compatibility_flags[\"']?\\s*[:=]\\s*\\[([^\\]]*)\\]/m.exec(wrangler);",
  "    flags = list ? [...list[1].matchAll(/[\"']([^\"']+)[\"']/g)].map((match) => match[1]) : [];",
  "  }",
  "  if (!Array.isArray(flags) || flags.some((flag) => flag !== 'nodejs_compat')) throw new Error('Supported compatibility_flags: nodejs_compat');",
  "  await writeFile(join(stage, '.joripspace-deploy.json'), JSON.stringify({ entrypoint,",
  "    ...(flags.length ? { compatibility_flags: [...new Set(flags)] } : {}) }) + '\\n');",
  "}",
].join('\n');

module.exports = { githubArtifactCommand, GITHUB_ARTIFACT_SCRIPT };
