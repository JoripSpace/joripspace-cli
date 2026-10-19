const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { createCredentialStore } = require('../lib/credential-store');

test(
  'native OS store writes, reads in a fresh instance, rotates and deletes synthetic credentials',
  {
    skip: process.platform !== 'win32' && process.env.JORIPSPACE_TEST_NATIVE_KEYRING !== '1',
  },
  () => {
    const { Entry: NativeEntry } = require('@napi-rs/keyring');
    const service = `com.joripspace.cli.test.${randomUUID()}`;
    const entries = new Map();
    class Entry {
      constructor(_service, key, options) {
        const entry = new NativeEntry(service, key, options);
        entries.set(key, entry);
        return entry;
      }
    }
    const binding = () => ({ Entry });
    const connection = {
      apiBaseUrl: 'https://keyring-test.invalid',
      accountId: 'synthetic-account',
      apiToken: 'synthetic-token',
    };
    try {
      const store = createCredentialStore(binding);
      assert.equal(store.load(connection.apiBaseUrl), null);
      store.save(connection);
      assert.equal(createCredentialStore(binding).load(connection.apiBaseUrl).apiToken, connection.apiToken);
      store.save({ ...connection, apiToken: 'rotated-synthetic-token' });
      assert.equal(
        createCredentialStore(binding).load(connection.apiBaseUrl).apiToken,
        'rotated-synthetic-token'
      );
      assert.equal(store.remove(connection.apiBaseUrl), true);
      assert.equal(createCredentialStore(binding).load(connection.apiBaseUrl), null);
    } finally {
      for (const entry of entries.values()) entry.deleteCredential();
      for (const entry of entries.values()) assert.equal(entry.getPassword(), null);
    }
  }
);
