import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@joripspace/cli');
assert.equal(pkg.license, 'MIT');
assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Cosmosfarm Software/);
assert.ok(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('BSD-3-Clause'));
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replace(/\r\n/g, '\n');
for (const [name, licenseFile] of [['fflate', 'LICENSE'], ['jsonc-parser', 'LICENSE.md'], ['smol-toml', 'LICENSE']]) {
  const dependency = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  const license = readFileSync(join(root, 'node_modules', name, licenseFile), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(notices.includes(`${name} ${dependency.version}`), `Update the notices for ${name}`);
  assert.ok(notices.includes(license), `Preserve the complete license for ${name}`);
}
assert.deepEqual(pkg.bin, { joripspace: 'bin/joripspace.js' });
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.private, undefined);
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.engines.node, '>=18');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.equal(pkg.scripts[hook], undefined, `${hook} must not run during installation`);
}
for (const spec of Object.values(pkg.dependencies)) assert.doesNotMatch(spec, /file:|link:|workspace:|\.\.\//);
assert.ok(readFileSync(join(root, pkg.bin.joripspace), 'utf8').startsWith('#!/usr/bin/env node\n'));
chmodSync(join(root, pkg.bin.joripspace), 0o755);
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const files = [join(root, pkg.bin.joripspace), ...walk(join(root, 'lib')), ...walk(join(root, 'vendor/core')), join(root, 'vendor/templates/index.js')];
for (const file of files.filter(file => /\.(cjs|js)$/.test(file))) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
}
console.error(`Package metadata, Node entrypoint and ${files.length} JavaScript files checked.`);
