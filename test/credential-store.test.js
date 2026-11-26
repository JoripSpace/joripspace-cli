const assert = require('node:assert/strict');
const test = require('node:test');
const { createCredentialStore, normalizeCredentialApiUrl } = require('../lib/credential-store');

function fixture(platform = process.platform) {
  const records = new Map();
  const calls = [];
  class Entry {
    constructor(service, key, options) {
      calls.push({ service, key, options });
      this.key = `${service}:${key}`;
    }
    getPassword() {
      return records.get(this.key) ?? null;
    }
    setPassword(value) {
      records.set(this.key, value);
    }
    deleteCredential() {
      return records.delete(this.key);
    }
  }
  return { records, calls, store: createCredentialStore(() => ({ Entry }), platform) };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: account and API scoped persistence survives a new store instance`, () => {
    const { records, calls, store } = fixture(platform);
    const one = { apiBaseUrl: 'https://api.example/', accountId: 'account-one', apiToken: 'secret-one' };
    assert.equal(store.load(one.apiBaseUrl), null);
    store.save(one);
    store.save({ ...one, accountId: 'account-two', apiToken: 'secret-two' });
    assert.equal(store.load('https://api.example').apiToken, 'secret-two');
    assert.equal(store.load('https://api.example', 'account-one').apiToken, 'secret-one');
    assert.equal(store.load('https://other.example', 'account-one'), null);
    assert.equal(store.load('https://api.example/other', 'account-one'), null);
    assert.equal(store.load('https://api.example', 'missing-account'), null);
    for (const call of calls) {
      assert.equal(call.service, 'com.joripspace.cli.v1');
      assert.deepEqual(call.options, { linux: { store: 'secret-service' } });
      assert.doesNotMatch(call.key, /secret-|account-one|account-two/);
    }
    assert.equal(records.size, 3); // two credentials and one token-free default pointer
    const pointer = [...records.entries()].find(([key]) => key.endsWith(':default'))[1];
    assert.doesNotMatch(pointer, /secret/);
    assert.equal(store.remove(one.apiBaseUrl, 'account-one'), true);
    assert.equal(store.load(one.apiBaseUrl, 'account-one'), null);
    assert.equal(store.load(one.apiBaseUrl).apiToken, 'secret-two');
    assert.equal(store.remove(one.apiBaseUrl), true);
    assert.equal(store.load(one.apiBaseUrl), null);
    assert.equal(records.size, 0);
    assert.equal(store.remove(one.apiBaseUrl), false);
  });
}

test('unavailable or locked stores and missing native binaries fail without exposing native errors', () => {
  for (const operation of ['constructor', 'getPassword', 'setPassword']) {
    class Entry {
      constructor() {
        if (operation === 'constructor') throw new Error('secret-value');
      }
      getPassword() {
        if (operation === 'getPassword') throw new Error('secret-value');
        return null;
      }
      setPassword() {
        throw new Error('secret-value');
      }
    }
    const store = createCredentialStore(() => ({ Entry }), 'linux');
    assert.throws(
      () => store.save({ apiBaseUrl: 'https://api.example', accountId: 'one', apiToken: 'secret-value' }),
      (error) => error.code === 'credential_store_unavailable' && !error.message.includes('secret-value')
    );
  }
  const missing = createCredentialStore(() => {
    throw new Error('private-native-path');
  });
  assert.throws(() => missing.load('https://api.example'), { code: 'credential_store_unavailable' });
  assert.throws(() => createCredentialStore(() => ({}), 'freebsd').load('https://api.example'), {
    code: 'credential_store_unavailable',
  });
});

test('failed readback, malformed records, and mismatched identities cannot authenticate', () => {
  const { records, store } = fixture();
  const connection = { apiBaseUrl: 'https://api.example', accountId: 'one', apiToken: 'secret-value' };
  store.save(connection);
  const credentialKey = [...records.keys()].find((key) => !key.endsWith(':default'));
  for (const value of [
    'bad secret-value JSON',
    'null',
    '{"version":2}',
    JSON.stringify({
      version: 1,
      account_id: 'other',
      api_base_url: connection.apiBaseUrl,
      api_token: 'secret-value',
    }),
    JSON.stringify({
      version: 1,
      account_id: 'one',
      api_base_url: 'https://other.example',
      api_token: 'secret-value',
    }),
  ]) {
    records.set(credentialKey, value);
    assert.throws(
      () => store.load(connection.apiBaseUrl, 'one'),
      (error) => error.code === 'credential_store_invalid' && !error.message.includes('secret-value')
    );
  }
  class Entry {
    setPassword() {}
    getPassword() {
      return null;
    }
  }
  assert.throws(() => createCredentialStore(() => ({ Entry })).save(connection), {
    code: 'credential_store_unavailable',
  });
});

test('credential URLs require HTTPS except loopback and cannot contain credentials, queries or fragments', () => {
  for (const value of [
    'http://external.example',
    'file:///tmp/secret',
    'https://user:secret@example.com',
    'https://example.com?token=secret',
    'https://example.com/#secret',
    'invalid-secret',
  ]) {
    assert.throws(
      () => normalizeCredentialApiUrl(value),
      (error) => error.code === 'credential_store_invalid' && !error.message.includes('secret')
    );
  }
  assert.equal(normalizeCredentialApiUrl('HTTPS://API.EXAMPLE:443/'), 'https://api.example');
  for (const value of ['http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234'])
    assert.equal(normalizeCredentialApiUrl(value), value);
});
