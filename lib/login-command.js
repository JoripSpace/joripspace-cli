function createLoginCommand({
  stringFlag,
  ensureProjectEnvIgnored,
  projectWorkspaceDir,
  normalizeCredentialApiUrl,
  unauthenticatedApiBaseUrl,
  apiRequest,
  normalizeConnectToken,
  normalizeConnectionCode,
  saveBrowserConnectToken,
  resolveConnection,
  approvalLogin,
  promptConnectionCode,
  output,
  browserConnectInstructions,
  printBrowserConnectInstructions,
}) {
  return async function login(flags) {
    const connectionCode = stringFlag(flags, 'code');
    if (connectionCode) {
      ensureProjectEnvIgnored(projectWorkspaceDir(flags, { discover: false }));
      const exchangeApiBaseUrl = normalizeCredentialApiUrl(unauthenticatedApiBaseUrl(flags));
      const exchange = await apiRequest(flags, '/v1/auth/connection-code/exchange', {
        method: 'POST',
        body: { code: normalizeConnectionCode(connectionCode) },
        apiBaseUrl: exchangeApiBaseUrl,
      });
      const exchangedToken = normalizeConnectToken(exchange.connect_token);
      await saveBrowserConnectToken(flags, exchangedToken, 'connection-code', exchangeApiBaseUrl);
      return;
    }
    const connectToken =
      stringFlag(flags, 'connect-token') || stringFlag(flags, 'api-token') || stringFlag(flags, 'token');
    if (connectToken) {
      ensureProjectEnvIgnored(projectWorkspaceDir(flags, { discover: false }));
      await saveBrowserConnectToken(flags, normalizeConnectToken(connectToken));
      return;
    }
    let existing;
    try {
      existing = resolveConnection(flags);
    } catch (error) {
      if (error.code !== 'credential_store_unavailable') throw error;
      // Reauthentication can obtain a new token even when an older OS login is inaccessible.
    }
    if (existing?.apiToken) {
      try {
        await saveBrowserConnectToken(
          flags,
          normalizeConnectToken(existing.apiToken),
          existing.source,
          existing.apiBaseUrl
        );
        return;
      } catch (error) {
        if (error.status !== 401) throw error;
      }
    }
    const approvalApiBaseUrl = normalizeCredentialApiUrl(unauthenticatedApiBaseUrl(flags));
    if (
      !flags['legacy-code'] &&
      (flags.browser || (!flags.json && process.stdin.isTTY && process.stdout.isTTY)) &&
      (await approvalLogin.login(flags, approvalApiBaseUrl))
    )
      return;
    const enteredCode = await promptConnectionCode(flags);
    if (enteredCode !== null) {
      await login({ ...flags, code: normalizeConnectionCode(enteredCode) });
      return;
    }
    if (flags.browser || flags['legacy-code']) {
      return output(
        flags,
        {
          ...browserConnectInstructions(),
          approval_login_command: undefined,
          next_action: 'request_five_minute_code',
          connection_method: 'connection_code',
          approval_link_supported: false,
        },
        printBrowserConnectInstructions
      );
    }
    output(flags, browserConnectInstructions(), printBrowserConnectInstructions);
  };
}
module.exports = { createLoginCommand };
