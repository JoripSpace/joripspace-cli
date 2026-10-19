const { message } = require('./locale');
const { createHash } = require('node:crypto');

const SERVICE = 'com.joripspace.cli.v1';

function storeError(code = 'credential_store_unavailable') {
  const error = new Error(
    code === 'credential_store_invalid'
      ? message(
          'The JoripSpace connection in the OS credential store is invalid. Reconnect with login --code.',
          'OS 보안 저장소의 JoripSpace 연결 정보가 올바르지 않습니다. login --code로 다시 연결하세요.'
        )
      : message(
          'The OS credential store could not complete this operation. Check Windows Credential Manager, macOS Keychain, or Linux Secret Service. Login uses .env.joripspace only when the store is unavailable before writing; failed writes or verification are not bypassed.',
          'OS 보안 저장소에서 작업을 완료하지 못했습니다. Windows 자격 증명 관리자, macOS Keychain 또는 Linux Secret Service를 확인하세요. 로그인은 쓰기 전 저장소 사용 불가가 확인된 경우에만 .env.joripspace를 사용하며, 쓰기나 검증 실패를 우회하지 않습니다.'
        )
  );
  error.code = code;
  return error;
}

function normalizeCredentialApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw storeError('credential_store_invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw storeError('credential_store_invalid');
  }
  return url.href.replace(/\/+$/, '');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Injection is confined to this module's constructor for unit tests. The CLI always
// uses the native binding; there is no configurable plaintext backend or shell helper.
function createCredentialStore(loadBinding = () => require('@napi-rs/keyring'), platform = process.platform) {
  function entry(apiBaseUrl, accountId) {
    try {
      if (!['win32', 'darwin', 'linux'].includes(platform)) throw storeError();
      const { Entry } = loadBinding();
      const key = `${digest(apiBaseUrl)}:${accountId ? digest(accountId) : 'default'}`;
      // The library otherwise falls back to a nonpersistent kernel keyring on Linux.
      return new Entry(SERVICE, key, { linux: { store: 'secret-service' } });
    } catch {
      throw storeError();
    }
  }

  function read(entry) {
    let value;
    try {
      value = entry.getPassword();
    } catch {
      throw storeError();
    }
    if (value === null || value === undefined) return null;
    try {
      const record = JSON.parse(value);
      if (!record || record.version !== 1 || typeof record.account_id !== 'string' || !record.account_id) {
        throw storeError();
      }
      return record;
    } catch {
      throw storeError('credential_store_invalid');
    }
  }

  function load(apiUrl, requestedAccountId = '') {
    const apiBaseUrl = normalizeCredentialApiUrl(apiUrl);
    const accountId = requestedAccountId || read(entry(apiBaseUrl))?.account_id;
    if (!accountId) return null;
    const record = read(entry(apiBaseUrl, accountId));
    if (!record) return null;
    if (
      record.api_base_url !== apiBaseUrl ||
      record.account_id !== accountId ||
      typeof record.api_token !== 'string' ||
      !record.api_token.trim() ||
      /[\r\n]/.test(record.api_token)
    ) {
      throw storeError('credential_store_invalid');
    }
    return { apiBaseUrl, apiToken: record.api_token, accountId, source: 'os-credential-store' };
  }

  function save({ apiBaseUrl: apiUrl, apiToken, accountId }) {
    const apiBaseUrl = normalizeCredentialApiUrl(apiUrl);
    if (
      typeof accountId !== 'string' ||
      !accountId ||
      typeof apiToken !== 'string' ||
      !apiToken.trim() ||
      /[\r\n]/.test(apiToken)
    ) {
      throw storeError('credential_store_invalid');
    }
    const account = entry(apiBaseUrl, accountId);
    const record = { version: 1, api_base_url: apiBaseUrl, account_id: accountId, api_token: apiToken };
    try {
      account.setPassword(JSON.stringify(record));
      if (account.getPassword() !== JSON.stringify(record)) throw storeError();
      const selected = entry(apiBaseUrl);
      const pointer = JSON.stringify({ version: 1, account_id: accountId });
      selected.setPassword(pointer);
      if (selected.getPassword() !== pointer) throw storeError();
    } catch {
      // Native errors can contain secret values. Never propagate them to CLI output.
      throw storeError();
    }
    return { apiBaseUrl, apiToken, accountId, source: 'os-credential-store' };
  }

  function remove(apiUrl, requestedAccountId = '') {
    const apiBaseUrl = normalizeCredentialApiUrl(apiUrl);
    const selected = entry(apiBaseUrl);
    const selectedAccountId = read(selected)?.account_id;
    const accountId = requestedAccountId || selectedAccountId;
    if (!accountId) return false;
    const account = entry(apiBaseUrl, accountId);
    try {
      account.deleteCredential();
      if (account.getPassword() !== null) throw storeError();
      if (selectedAccountId === accountId) {
        selected.deleteCredential();
        if (selected.getPassword() !== null) throw storeError();
      }
    } catch {
      throw storeError();
    }
    return true;
  }

  return { load, save, remove };
}

module.exports = { createCredentialStore, normalizeCredentialApiUrl };
