import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'joripspace-test-home-'));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(JORIPSPACE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
}
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'),
  LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
});
for (const directory of ['roaming', 'local', 'config', 'data']) mkdirSync(join(home, directory));
try {
  const files = readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.js')).sort();
  const result = spawnSync(process.execPath, ['--test', ...files.map(name => join(root, 'test', name))], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(home) !== resolve(tmpdir()) || !home.startsWith(join(tmpdir(), 'joripspace-test-home-'))) {
    throw new Error('Unexpected test cleanup path');
  }
  rmSync(home, { recursive: true, force: true });
}
