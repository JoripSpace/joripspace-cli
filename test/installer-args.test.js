const assert = require('node:assert/strict');
const test = require('node:test');
const { installerFlags, normalizeWindowsPathEntry } = require('../lib/installer-args');

test('installer accepts the documented quiet flag and compatibility alias', () => {
  assert.equal(installerFlags(['--quiet']).wantsQuiet, true);
  assert.equal(installerFlags(['-quiet']).wantsQuiet, true);
  assert.equal(installerFlags([]).wantsQuiet, false);
});

test('installer flags preserve JSON, help, and version handling', () => {
  assert.deepEqual(installerFlags(['-quiet', '--json', '-h', '-v']), {
    wantsHelp: true,
    wantsJson: true,
    wantsQuiet: true,
    wantsVersion: true,
  });
});

test('Windows PATH comparison expands variables and ignores casing and trailing separators', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' };
  assert.equal(
    normalizeWindowsPathEntry('%localappdata%\\Programs\\JoripSpace\\bin\\', env),
    normalizeWindowsPathEntry('c:\\users\\example\\appdata\\local\\programs\\joripspace\\BIN', env)
  );
});
