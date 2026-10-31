const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectFileTarget } = require('./project-paths');
const { buildDeployPayload } = require('./deploy-files');

// Preparation validates the actual build output, but never uploads or deploys it.
function prepareDeployment(workspace, flags, writeTextAtomically) {
  const dir = String(flags.dir || '');
  const entrypoint = String(flags.entrypoint || '');
  for (const value of [dir, entrypoint]) {
    if (!value || !/^[a-zA-Z0-9_./ -]+$/.test(value) || value.startsWith('-')) {
      throw new Error(
        'deploy --prepare requires project-relative --dir and --entrypoint (letters, digits, spaces, _, -, ., /)'
      );
    }
  }
  const outputLocation = resolveProjectFileTarget(workspace, `${dir}/${entrypoint}`);
  if (outputLocation.blockers.length || !fs.existsSync(outputLocation.target)) {
    throw new Error('Build the project first: the configured Worker entrypoint does not exist');
  }
  try {
    buildDeployPayload({ ...flags, cwd: workspace, dir: path.resolve(workspace, dir), entrypoint });
  } catch (error) {
    if (error.code !== 'archive_required') throw error;
  }
  const location = resolveProjectFileTarget(workspace, 'package.json');
  if (location.blockers.length) throw new Error('package.json path is blocked');
  const pkg = JSON.parse(fs.readFileSync(location.target, 'utf8'));
  if (pkg.scripts != null && (typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) {
    throw new Error('package.json scripts must be an object');
  }
  const scripts = pkg.scripts || {};
  const command = `${typeof scripts.build === 'string' ? 'npm run build && ' : ''}npx --yes @joripspace/cli@latest deploy --cwd . --dir "${dir}" --entrypoint "${entrypoint}"`;
  if (scripts['joripspace:deploy'] && scripts['joripspace:deploy'] !== command) {
    throw new Error('Existing joripspace:deploy script was preserved; review it before preparing deployment');
  }
  pkg.scripts = { ...scripts, 'joripspace:deploy': command };
  writeTextAtomically(location.target, `${JSON.stringify(pkg, null, 2)}\n`);
  return {
    status: 'prepared',
    script: 'joripspace:deploy',
    command,
    next_action: 'npm run joripspace:deploy -- --label "배포 변경 내용"',
    deployed: false,
  };
}

module.exports = { prepareDeployment };
