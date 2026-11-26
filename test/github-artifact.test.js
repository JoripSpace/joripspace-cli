const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GITHUB_ARTIFACT_SCRIPT } = require('../vendor/core/github-artifact.cjs');
const { deploymentCompatibilityFlags } = require('../lib/deployment-config');

test('GitHub artifact selects the built bundle and carries explicit Node compatibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jorip-artifact-'));
  try {
    const stage = path.join(root, '.joripspace-artifact');
    fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'worker.js'), "import {zipSync} from 'fflate'; export default {};");
    fs.writeFileSync(path.join(stage, 'dist/worker.js'), 'export default {fetch(){return new Response("ok")}}');
    fs.writeFileSync(path.join(root, 'wrangler.jsonc'), '{\n// compatibility_flags: ["bad"]\n"compatibility_flags":["nodejs_compat"],\n}');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${GITHUB_ARTIFACT_SCRIPT}; await prepareGithubArtifact();`], {
      env: { ...process.env, GITHUB_WORKSPACE: root, JORIPSPACE_STAGE_DIR: stage, JORIPSPACE_ARTIFACT_PATH: '.joripspace-artifact', JORIPSPACE_ENTRYPOINT: 'dist/worker.js' },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, '.joripspace-deploy.json'), 'utf8')), {
      entrypoint: 'dist/worker.js', compatibility_flags: ['nodejs_compat'],
    });
    assert.equal(fs.existsSync(path.join(stage, 'worker.js')), false);
    assert.deepEqual(deploymentCompatibilityFlags({ cwd: root }), ['nodejs_compat']);
    assert.throws(() => deploymentCompatibilityFlags({ cwd: root, 'compatibility-flag': 'no_nodejs_compat' }), /Supported/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
