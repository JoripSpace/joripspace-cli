// Test-only native binding replacement. Only synthetic test credentials go here.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
const file = process.env.JORIPSPACE_TEST_KEYRING_FILE;
if (!file) throw new Error('Test keyring file is required');
function values() {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
class Entry {
  constructor(service, user, options) {
    if (options?.linux?.store !== 'secret-service') throw new Error('Secret Service must be explicit');
    this.key = `${service}:${user}`;
  }
  getPassword() {
    if (process.env.JORIPSPACE_TEST_KEYRING_FAILURE === 'read')
      throw new Error('native-secret-must-not-leak');
    if (process.env.JORIPSPACE_TEST_KEYRING_FAILURE === 'readback') return null;
    return values()[this.key] ?? null;
  }
  setPassword(value) {
    if (process.env.JORIPSPACE_TEST_KEYRING_FAILURE === 'write') throw new Error(value);
    const next = values();
    next[this.key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
  }
  deleteCredential() {
    if (process.env.JORIPSPACE_TEST_KEYRING_FAILURE === 'delete')
      throw new Error('native-secret-must-not-leak');
    const next = values();
    const existed = this.key in next;
    delete next[this.key];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
    return existed;
  }
}
Module._load = function (name, parent, isMain) {
  return name === '@napi-rs/keyring' ? { Entry } : originalLoad.call(this, name, parent, isMain);
};
