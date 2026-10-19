const path = require('node:path');
const { normalizeCredentialApiUrl } = require('./credential-store');
const { ensureProjectEnvIgnored, updateDotEnvFile } = require('./project-env');

function persistProjectConnection(store, workspaceDir, connection) {
  ensureProjectEnvIgnored(workspaceDir);
  const apiBaseUrl = normalizeCredentialApiUrl(connection.apiBaseUrl);
  if (!connection.accountId || typeof connection.accountId !== 'string' ||
      typeof connection.apiToken !== 'string' || !connection.apiToken.trim() || /[\r\n]/.test(connection.apiToken)) {
    const error = new Error('Invalid connection credentials. Reconnect with login --code.');
    error.code = 'credential_store_invalid';
    throw error;
  }
  let storage = 'os-credential-store';
  try {
    store.load(apiBaseUrl, connection.accountId);
  } catch (error) {
    if (error.code === 'credential_store_unavailable') storage = 'project-env-fallback';
    // A newly verified login may repair an invalid OS record, but must not
    // downgrade it to plaintext. Save/readback failures below also stay fatal.
    else if (error.code !== 'credential_store_invalid') throw error;
  }
  if (storage === 'os-credential-store' && connection.source !== 'os-credential-store') {
    store.save({ ...connection, apiBaseUrl });
  }
  updateDotEnvFile(path.join(workspaceDir, '.env.joripspace'), {
    JORIPSPACE_API_BASE_URL: apiBaseUrl,
    JORIPSPACE_API_TOKEN: storage === 'project-env-fallback' ? connection.apiToken : null,
    JORIPSPACE_CONNECT_TOKEN: null,
    JORIPSPACE_ACCOUNT_ID: connection.accountId,
    JORIPSPACE_CONNECTION_SOURCE: storage,
  });
  return storage;
}

module.exports = { persistProjectConnection };
