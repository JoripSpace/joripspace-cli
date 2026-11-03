const assert = require('node:assert/strict');
const test = require('node:test');
const { createApprovalLogin } = require('../lib/approval-login');

function fixture({
  states = ['pending', 'connected'],
  capability = { approval_link: true, version: 1 },
  failure,
} = {}) {
  const calls = [],
    pending = [],
    saved = [],
    opened = [],
    sleeps = [];
  const request = {
    request_id: 'r'.repeat(48),
    request_secret: 's'.repeat(48),
    approval_url: `https://joripspace.com/connect/device/?request=${'r'.repeat(48)}`,
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  const login = createApprovalLogin({
    async apiRequest(_flags, path, options) {
      calls.push({ path, options });
      if (failure) throw failure;
      if (path.endsWith('/capabilities')) return capability;
      if (path.endsWith('/requests')) return request;
      return { status: states.shift(), interval: 5, connect_token: 'test-credential' };
    },
    openExternalUrl: (url) => opened.push(url),
    saveToken: (...args) => saved.push(args),
    writePending: (value) => pending.push(value),
    sleep: async (ms) => sleeps.push(ms),
  });
  return { login, calls, pending, saved, opened, sleeps, request };
}
test('approval login emits public next-action, polls with private proof and saves only after approval', async () => {
  const f = fixture();
  assert.equal(await f.login.login({}, 'https://api.joripspace.com'), true);
  assert.equal(f.pending[0].next_action, 'ask_user_to_approve_then_wait');
  assert(!JSON.stringify(f.pending).includes(f.request.request_secret));
  assert.equal(
    f.calls.find((c) => c.path.endsWith('/status')).options.body.request_secret,
    f.request.request_secret
  );
  assert.deepEqual(f.sleeps, [5000]);
  assert.equal(f.saved[0][1], 'test-credential');
  assert.equal(f.opened[0], f.request.approval_url);
});
test('no-open keeps the approval URL available without launching a browser', async () => {
  const f = fixture({ states: ['connected'] });
  await f.login.login({ 'no-open': true }, 'https://api.joripspace.com');
  assert.equal(f.opened.length, 0);
  assert.equal(f.pending.length, 1);
});
for (const state of ['denied', 'expired', 'consumed'])
  test(`${state} is terminal and never falls back`, async () => {
    const f = fixture({ states: [state] });
    await assert.rejects(
      f.login.login({}, 'https://api.joripspace.com'),
      (e) => e.code === `approval_${state}`
    );
    assert.equal(f.saved.length, 0);
    assert.equal(f.calls.length, 3);
  });
test('only missing endpoint or explicit lack of capability falls back', async () => {
  assert.equal(
    await fixture({ failure: Object.assign(new Error('not found'), { status: 404 }) }).login.login(
      {},
      'https://api.joripspace.com'
    ),
    false
  );
  assert.equal(
    await fixture({ capability: { approval_link: false } }).login.login({}, 'https://api.joripspace.com'),
    false
  );
  for (const status of [401, 429, 500])
    await assert.rejects(
      fixture({ failure: Object.assign(new Error('failure'), { status }) }).login.login(
        {},
        'https://api.joripspace.com'
      )
    );
  await assert.rejects(
    fixture({ failure: Object.assign(new Error('network'), { code: 'request_failed' }) }).login.login(
      {},
      'https://api.joripspace.com'
    )
  );
});
