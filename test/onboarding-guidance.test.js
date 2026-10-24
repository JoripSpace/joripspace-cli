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

test('actual agent documents and CLI/public instructions deliver current development guidance', () => {
  const surfaces = {
    agents: core.projectAgentsFile({ project_slug: 'demo' }),
    public: core.JORIPSPACE_NPM_ONBOARDING_DOCUMENT,
    start: createStartOnboarding(__filename, __dirname, 'demo', true).instructions,
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
  assert.match(text, /Never request the token itself or pass the code as connect_token/);
  assert.doesNotMatch(
    text,
    /제가 직접 확인하고 진행할까요|one-time Secret-work consent|how to paste it back|Ask the user for the MCP\/CLI connection token|prefer MCP automatically/
  );
});
