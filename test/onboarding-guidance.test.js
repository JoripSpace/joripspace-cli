const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../vendor/core/onboarding.cjs');
const { createStartOnboarding } = require('../lib/start');

test('agent documents separate English user guidance from the replaceable managed section', () => {
  const document = core.projectAgentsFile();
  const start = document.indexOf('<!-- joripspace:start -->');
  assert.match(document.slice(0, start), /^# User instructions\n/);
  assert.match(document.slice(0, start), /Add the instructions you want the AI to follow below/);
  assert.match(document.slice(start), /JoripSpace managed instructions/);
  assert.match(document.slice(start), /updates only this marked section/);
  assert.doesNotMatch(document, /[가-힣]/u);
  assert.equal(core.upsertProjectAgentsContent(document).trimEnd(), document);
});

test('refresh migrates old managed sections below user content without duplicating or discarding user rules', () => {
  for (const [start, end] of [
    ['<!-- joripspace:start -->', '<!-- joripspace:end -->'],
    ['<!-- joripspace:managed:start -->', '<!-- joripspace:managed:end -->'],
  ]) {
    const before = '# Team conventions\n\nKeep all existing URLs.\n';
    const after = '\n\n## Personal preferences\n\n한국어로 답변해 주세요.\n';
    const source = `${before}\n${start}\nOutdated managed guidance\n${end}${after}`;
    const result = core.upsertProjectAgentsContent(source);
    const managedStart = result.indexOf('<!-- joripspace:start -->');
    assert.ok(result.slice(0, managedStart).includes(before));
    assert.ok(result.slice(0, managedStart).includes(after.trimEnd()));
    assert.ok(!result.includes('Outdated managed guidance'));
    assert.equal(result.match(/^# User instructions$/gm).length, 1);
    assert.equal(result.match(/<!-- joripspace:start -->/g).length, 1);
    assert.equal(core.upsertProjectAgentsContent(result), result);
  }
});

test('an existing user section remains intact and malformed managed markers are rejected', () => {
  const source = '# User instructions\n\n- Preserve my custom instructions and examples.\n';
  const result = core.upsertProjectAgentsContent(source);
  assert.ok(result.startsWith(source));
  assert.equal(result.match(/^# User instructions$/gm).length, 1);
  assert.equal(core.upsertProjectAgentsContent(result), result);
  for (const malformed of [
    '<!-- joripspace:start -->\nunfinished',
    '<!-- joripspace:end -->\n<!-- joripspace:start -->',
  ])
    assert.throws(() => core.upsertProjectAgentsContent(malformed), /AGENTS\.md/);
});

test('repeated server guide updates preserve user instructions on both sides of the managed block', () => {
  const before = '# User instructions\n\n- 한국어로 답변해 주세요.\n\n<!-- My private project notes -->\n';
  const after = '\n\n## Team examples\n\n```js\nconst keep = "user example";\n```\n\n- Keep our existing URLs.\n';
  let document = `${before}\n<!-- joripspace:start -->\nOld policy\n<!-- joripspace:end -->${after}`;
  for (const version of [1, 2, 3]) {
    const block = `<!-- joripspace:start -->\nServer policy ${version}\n<!-- joripspace:end -->`;
    document = core.upsertProjectAgentsContent(document, {}, block);
    const userContent = document.slice(0, document.indexOf('<!-- joripspace:start -->'));
    assert.ok(userContent.includes(before));
    assert.ok(userContent.includes(after.trimEnd()));
    assert.ok(document.includes(block));
    assert.equal(document.match(/<!-- joripspace:start -->/g).length, 1);
    assert.equal(core.upsertProjectAgentsContent(document, {}, block), document);
  }
});

test('all server guidance surfaces require frequent safe refresh and preservation of user instructions', () => {
  for (const text of [core.projectAgentsFile(), core.projectAgentGuidance().instructions, core.AFTER_CONNECTION_RULE_LINES.join('\n')]) {
    for (const marker of [
      'start of every new distinct JoripSpace task',
      'when resuming a session or compacted context',
      'at major phase transitions during long-running work',
      'immediately before deployment',
      'Never replace the entire file with the server default',
      'verify that the user content remains intact',
      'explicitly reread AGENTS.md',
      'never claim a successful check without a server response',
    ]) assert.ok(text.includes(marker), `Missing guide refresh rule: ${marker}`);
  }
});

test('actual agent documents and CLI/public instructions deliver current development guidance', () => {
  const surfaces = {
    agents: core.projectAgentsFile({ project_slug: 'demo' }),
    public: core.JORIPSPACE_NPM_ONBOARDING_DOCUMENT,
    start: createStartOnboarding(__filename, __dirname, 'demo', true, '', core.projectAgentGuidance().instructions).instructions,
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const rule of core.JORIPSPACE_TOOL_SELECTION_LINES) {
      assert.ok(text.includes(rule), `${name} must deliver shared CLI priority and MCP fallback`);
    }
    for (const marker of [
      'Use Hono as the default server framework for every new project',
      'Preserve the current framework of an existing project',
      'Installation copies files and does not initialize the project DB',
      'db schema',
      'db migrate --file PATH',
      'db query',
      'env.DB',
      'env.STORAGE',
      'realtime-v2 docs',
      '/_joripspace/realtime?room=main',
      'mail connect',
      'mail status',
      'mail test',
      'knowledge search',
      'context.deployment',
      'get --project PROJECT --json',
      'secret generate --name NAME --json',
      'secret set --name NAME --value-stdin --json',
      'do not ask for duplicate consent or browser registration',
      'preserves an existing active secret',
      'No secret value is returned',
      'deleting a secret remains a web operation',
    ])
      assert.ok(text.includes(marker), `${name} is missing ${marker}`);
    assert.doesNotMatch(text, /Use MCP tools first|prefer MCP automatically|ask exactly once/);
  }
});

test('detailed Secret and recovery rules cannot reintroduce duplicate approval or raw-token collection', () => {
  const text = [...core.SECRET_RULE_LINES, ...core.AFTER_CONNECTION_RULE_LINES].join('\n');
  assert.match(text, /Internal generation does not need duplicate consent or browser registration/);
  assert.match(text, /prefer CLI secret generate/);
  assert.match(text, /Prefer CLI secret set/);
  assert.match(text, /Never request or expose a token; do not browse around or inspect browser storage/);
  assert.doesNotMatch(
    text,
    /제가 직접 확인하고 진행할까요|one-time Secret-work consent|how to paste it back|Ask the user for the MCP\/CLI connection token|prefer MCP automatically/
  );
});


test('generated and refreshed project guidance requires relevant search before asynchronous questions', () => {
  const userRules = '# Team rules\n\nPreserve our existing application and choices.\n';
  const refreshed = core.upsertProjectAgentsContent(userRules + '\n<!-- joripspace:start -->\nOld guide\n<!-- joripspace:end -->');
  assert.ok(refreshed.slice(0, refreshed.indexOf('<!-- joripspace:start -->')).includes(userRules.trimEnd()));
  const surfaces = {
    generated: core.projectAgentsFile(),
    refreshed,
    start: createStartOnboarding(__filename, __dirname, 'demo', true, '', core.projectAgentGuidance().instructions).instructions,
    public: core.JORIPSPACE_NPM_ONBOARDING_DOCUMENT,
    mcp: core.AFTER_CONNECTION_RULE_LINES.join('\n'),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const marker of [
      'before answering, planning, asking questions, or starting work',
      'Choose search terms from the user',
      'Do not add a provider, model, framework, or route',
      'match_type=fallback is not a direct match',
      'at most two focused follow-up searches',
      "inspect the requested project's existing configuration",
      'including asynchronous questions',
      'Do not claim to have searched without a completed tool result',
    ]) assert.ok(text.includes(marker), `${name} missing search rule: ${marker}`);
  }
  for (const [name, text] of Object.entries(surfaces).filter(([name]) => name !== 'mcp')) {
    assert.ok(text.indexOf('## Search before answering or asking questions') < text.indexOf('## Workspace and connection'), `${name} must place search instructions near the start`);
  }
});
