const { message } = require('./locale');

function createApprovalLogin({
  apiRequest,
  openExternalUrl,
  saveToken,
  writePending = (value) => console.error(JSON.stringify(value)),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  async function supported(flags, apiBaseUrl) {
    try {
      const result = await apiRequest(flags, '/v1/auth/approval-link/capabilities', {
        method: 'GET',
        apiBaseUrl,
      });
      return result.approval_link === true && result.version === 1;
    } catch (error) {
      if ([404, 405].includes(error.status)) return false;
      throw error;
    }
  }
  async function login(flags, apiBaseUrl, { output = true } = {}) {
    if (!(await supported(flags, apiBaseUrl))) throw Object.assign(new Error('This server does not support approval-link login. Update the server before reconnecting.'), { code: 'approval_link_unsupported' });
    const request = await apiRequest(flags, '/v1/auth/approval-link/requests', {
      method: 'POST',
      apiBaseUrl,
      body: { client: 'cli' },
    });
    const url = new URL(request.approval_url);
    if (
      url.href !== `https://joripspace.com/connect/device/?request=${request.request_id}` ||
      url.searchParams.get('request') !== request.request_id ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(request.request_id || '') ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(request.request_secret || '') ||
      !Number.isFinite(Date.parse(request.expires_at)) ||
      Date.parse(request.expires_at) > Date.now() + 310000
    ) {
      throw new Error('Invalid approval-link response.');
    }
    // Only the public URL leaves this process. The polling secret stays in memory.
    writePending({
      status: 'approval_pending',
      approval_url: url.href,
      expires_at: request.expires_at,
      next_action: 'ask_user_to_approve_then_wait',
      interval: 5,
      message: message(
        'Open the link and approve the connection. No code entry is needed.',
        '링크를 열어 연결을 승인하세요. 코드 입력은 필요하지 않습니다.'
      ),
    });
    if (!flags['no-open']) openExternalUrl(url.href);
    while (Date.now() < Date.parse(request.expires_at)) {
      const result = await apiRequest(flags, '/v1/auth/approval-link/status', {
        method: 'POST',
        apiBaseUrl,
        body: { request_id: request.request_id, request_secret: request.request_secret },
      });
      if (result.status === 'connected') {
        await saveToken(flags, result.connect_token, apiBaseUrl, { output });
        return true;
      }
      if (result.status !== 'pending') {
        const error = new Error(
          message(
            `Connection approval ${result.status}. Run login to try again.`,
            `연결 승인 상태: ${result.status}. 다시 시도하려면 login을 실행하세요.`
          )
        );
        error.code = `approval_${result.status}`;
        error.details = { status: result.status, next_action: 'stop_and_report_approval_result' };
        throw error;
      }
      await sleep(Math.max(5, Math.min(30, Number(result.interval) || 5)) * 1000);
    }
    const error = new Error(
      message(
        'The connection approval link expired. Run login again.',
        '연결 승인 링크가 만료되었습니다. login을 다시 실행하세요.'
      )
    );
    error.code = 'approval_expired';
    error.details = { status: 'expired', next_action: 'ask_user_before_starting_new_approval' };
    throw error;
  }
  return { supported, login };
}
module.exports = { createApprovalLogin };
