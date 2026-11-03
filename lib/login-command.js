function createLoginCommand({ ensureProjectEnvIgnored, projectWorkspaceDir, stringFlag, normalizeCredentialApiUrl, unauthenticatedApiBaseUrl, normalizeConnectToken, saveBrowserConnectToken, resolveConnection, approvalLogin }) {
  return async function login(flags) {
    if (flags['connect-token'] !== undefined || flags.code !== undefined || flags['legacy-code'] !== undefined) {
      throw Object.assign(new Error('Run login without code options to approve the connection in your browser.'), { code: 'unsupported_login_option' });
    }
    let existing;
    try { existing = resolveConnection(flags); }
    catch (error) { if (error.code !== 'credential_store_unavailable') throw error; }
    if (existing?.apiToken) {
      try {
        await saveBrowserConnectToken(flags, normalizeConnectToken(existing.apiToken), existing.source, existing.apiBaseUrl);
        return;
      } catch (error) { if (error.status !== 401) throw error; }
    }
    ensureProjectEnvIgnored(projectWorkspaceDir(flags, { discover: false }));
    await approvalLogin.login({ ...flags, 'no-open': flags['no-open'] || !!flags.json }, normalizeCredentialApiUrl(unauthenticatedApiBaseUrl(flags)));
  };
}
module.exports = { createLoginCommand };
