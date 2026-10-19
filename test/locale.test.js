const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { detectLanguage } = require('../lib/locale');

test('OS locale selects Korean or English, with English for unsupported or unavailable locales', (t) => {
  for (const locale of ['ko', 'ko-KR', 'ko_KR', 'KO-kr']) assert.equal(detectLanguage(locale), 'ko');
  for (const locale of ['en', 'en-GB', 'ja-JP', 'de-DE', 'fr-FR', '', null]) {
    assert.equal(detectLanguage(locale), 'en');
  }
  t.mock.method(Intl, 'DateTimeFormat', () => {
    throw new Error('Locale unavailable');
  });
  assert.equal(detectLanguage(), 'en');
});

test('localized text and project name errors use the detected locale without changing metadata', () => {
  for (const [locale, expected] of [
    ['ko-KR', 'ko'],
    ['en-US', 'en'],
    ['ja-JP', 'en'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      Intl.DateTimeFormat = () => ({ resolvedOptions: () => ({ locale: process.argv[1] }) });
      const { language, message } = require(process.argv[2]);
      const { normalizeProjectName } = require(process.argv[3]);
      let error;
      try { normalizeProjectName('admin'); } catch (value) { error = { code: value.code, message: value.message }; }
      console.log(JSON.stringify({ language, text: message('Login required', '로그인이 필요합니다'), error }));
    `,
        locale,
        path.resolve(__dirname, '../lib/locale.js'),
        path.resolve(__dirname, '../lib/project-create.js'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.language, expected);
    assert.equal(output.text, expected === 'ko' ? '로그인이 필요합니다' : 'Login required');
    assert.equal(output.error.code, 'reserved_project_name');
    assert.equal(/[가-힣]/.test(output.error.message), expected === 'ko');
  }
});
