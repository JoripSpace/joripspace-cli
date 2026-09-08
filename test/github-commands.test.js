const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inferWorkflowConfig } = require('../lib/github-commands');
const { buildGithubWorkflow } = require('../vendor/core/onboarding.cjs');

test('GitHub prepare detects the worker and emits a connection-bound workflow', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'joripspace-github-prepare-'));
  try {
    fs.writeFileSync(path.join(workspace, 'worker.js'), 'export default { fetch() { return new Response("ok"); } };\n');
    const config = inferWorkflowConfig(workspace, {}, () => '');
    assert.equal(config.entrypoint, 'worker.js');
    assert.equal(config.artifactPath, '.joripspace-artifact');
    const workflow = buildGithubWorkflow({
      projectId: 'demo',
      branch: 'main',
      connectionId: 'connection_demo',
      ...config,
    });
    assert.match(workflow, /JORIPSPACE_CONNECTION_ID: "connection_demo"/u);
    assert.match(workflow, /\.joripspace-artifact/u);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
