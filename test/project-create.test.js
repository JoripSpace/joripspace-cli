const assert = require('node:assert/strict');
const test = require('node:test');
const { createProjectCommand, normalizeProjectName } = require('../lib/project-create');
const { PROJECT_CREATE_AGREEMENTS } = require('../lib/project-create-policy');

function fixture(response = { project_id: 'my-demo', project_slug: 'my-demo' }) {
  const calls = [],
    outputs = [];
  const command = createProjectCommand({
    stringFlag: (flags, name) => (typeof flags[name] === 'string' ? flags[name] : ''),
    requireApiToken: () => 'synthetic-create-token',
    apiRequest: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
    output: (_flags, result) => outputs.push(result),
  });
  return { command, calls, outputs };
}

const accepted = { 'agree-noncommercial': true, 'agree-billing': true, 'agree-retention': true };

test('project creation names follow web format and reject reserved, impersonation, and harmful names', () => {
  for (const value of ['ab', 'x'.repeat(51), '-demo', 'demo-', 'a/b', '한글', 'demo name']) {
    assert.throws(() => normalizeProjectName(value), { code: 'invalid_project_name' });
  }
  for (const value of ['admin', 'joripspace-demo', 'my-login', 'google-demo', 'my-phishing', 'demo-casino']) {
    assert.throws(() => normalizeProjectName(value), { code: 'reserved_project_name' });
  }
  assert.equal(normalizeProjectName(' MY-DEMO '), 'my-demo');
});

test('machine project creation requires each explicit agreement and returns English plus the web original', async () => {
  for (const flags of [
    {},
    { yes: true },
    { ...accepted, 'agree-billing': false },
    { ...accepted, 'agree-retention': 'false' },
    { ...accepted, 'agree-noncommercial': '1' },
  ]) {
    const f = fixture();
    await assert.rejects(f.command({ json: true, name: 'my-demo', ...flags }), (error) => {
      assert.equal(error.code, 'project_agreements_required');
      assert.equal(error.exitCode, 2);
      assert.equal(error.details.language, 'en');
      assert.match(error.details.agent_instruction, /user's language.*explicit consent/);
      assert.equal(error.details.agreements.length, 3);
      for (const item of error.details.agreements) {
        const original = PROJECT_CREATE_AGREEMENTS.find(({ id }) => id === item.id);
        assert.equal(item.text, original.text_en);
        assert.equal(item.original_text, original.text);
        assert.equal(item.required, true);
      }
      return true;
    });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.outputs, []);
  }
});

test('accepted creation sends only the web creation fields using existing authentication', async () => {
  const f = fixture();
  await f.command({
    json: true,
    name: ' MY-DEMO ',
    ...accepted,
    plan: 'free',
    account: 'ignored',
    yes: true,
  });
  assert.equal(f.calls.length, 1);
  const [, url, options] = f.calls[0];
  assert.equal(url, '/v1/projects');
  assert.equal(options.method, 'POST');
  assert.equal(options.apiToken, 'synthetic-create-token');
  assert.equal(options.timeoutMs, null);
  assert.deepEqual(options.body, {
    name: 'my-demo',
    free_project_noncommercial_agreement: true,
    billing_agreement: true,
    free_project_retention_agreement: true,
  });
  assert.equal(f.outputs[0].project_slug, 'my-demo');
});

test('creation refuses paid plans and invalid names before requesting any resource', async () => {
  const f = fixture();
  await assert.rejects(f.command({ name: 'my-demo', plan: 'pro', ...accepted }), {
    code: 'free_project_only',
  });
  await assert.rejects(f.command({ name: 'admin', ...accepted }), { code: 'reserved_project_name' });
  assert.deepEqual(f.calls, []);
});

test('creation preserves server rejection and never retries or silently changes a duplicate name', async () => {
  const error = Object.assign(new Error('Already used'), { code: 'project_name_taken', status: 409 });
  const f = fixture(error);
  await assert.rejects(f.command({ name: 'my-demo', ...accepted }), {
    code: 'project_name_taken',
    status: 409,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].body.name, 'my-demo');
  assert.deepEqual(f.outputs, []);
});

test('unknown creation state instructs the agent to list projects before retrying', async () => {
  const error = Object.assign(new Error('Disconnected'), { code: 'request_failed' });
  const f = fixture(error);
  await assert.rejects(f.command({ name: 'my-demo', ...accepted }), (caught) => {
    assert.match(caught.details.next_action, /list-projects.*before-retrying/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});
