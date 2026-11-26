const { createCredentialStore, normalizeCredentialApiUrl } = require('./credential-store');
const { redactAuthError } = require('./auth-redaction');
const { message } = require('./locale');

const ADMIN_SERVICE = 'com.joripspace.cli.admin.v1';
const ADMIN_ACCOUNT = 'admin-automation';
const STATUSES = new Set(['open', 'resolved', 'dismissed']);
const CATEGORIES = new Set(['problem', 'bug', 'feedback']);

function createAdminReportCommands(deps) {
  const store = deps.store || createCredentialStore(undefined, process.platform, ADMIN_SERVICE);
  return async function admin(rest, flags) {
    if (flags.token !== undefined || flags['api-token'] !== undefined || flags['admin-token'] !== undefined) {
      throw new Error('Use admin login --token-stdin; do not put administrator credentials in command arguments.');
    }
    const action = rest[0];
    if (!['login', 'logout', 'reports'].includes(action)) throw new Error('admin requires login, logout, or reports');
    const apiBaseUrl = normalizeCredentialApiUrl(deps.stringFlag(flags, 'api-url') || deps.defaultApiUrl);
    if (action === 'logout') {
      if (rest.length !== 1) throw new Error('admin logout accepts no positional arguments');
      store.remove(apiBaseUrl, ADMIN_ACCOUNT);
      return deps.output(flags, { status: 'logged_out', api_base_url: apiBaseUrl }, () => console.log(message('Administrator signed out.', '관리자 연결을 해제했습니다.')));
    }
    const subcommand = rest[1] || 'list';
    let route = '/v1/internal/agent-reports';
    let body;
    if (action === 'login') {
      if (rest.length !== 1 || flags['token-stdin'] !== true) throw new Error('admin login requires --token-stdin');
      route += '?limit=1';
    } else if (subcommand === 'list') {
      if (rest.length > 2) throw new Error('admin reports list accepts no positional arguments');
      const query = new URLSearchParams();
      for (const [key, allowed] of [['status', STATUSES], ['category', CATEGORIES]]) {
        const value = deps.stringFlag(flags, key);
        if (value && !allowed.has(value)) throw new Error(`Invalid report ${key}`);
        if (value) query.set(key, value);
      }
      const limit = deps.stringFlag(flags, 'limit');
      if (limit && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new Error('--limit must be 1-100');
      if (limit) query.set('limit', limit);
      const cursor = deps.stringFlag(flags, 'cursor');
      if (cursor) query.set('cursor', cursor);
      route += query.size ? `?${query}` : '';
    } else if (subcommand === 'get' || subcommand === 'update') {
      const id = rest[2] || deps.stringFlag(flags, 'report-id');
      if (rest.length > 3 || !/^air_[a-f0-9]{32}$/.test(id)) throw new Error('Specify a valid report ID: air_ followed by 32 hexadecimal characters');
      route += `/${encodeURIComponent(id)}`;
      if (subcommand === 'update') {
        const status = deps.stringFlag(flags, 'status');
        if (!STATUSES.has(status)) throw new Error('--status must be open, resolved, or dismissed');
        body = { status };
      }
    } else throw new Error('admin reports requires list, get, or update');

    const token = flags['token-stdin'] === true
      ? await readAdminToken(deps.stdin || process.stdin)
      : store.load(apiBaseUrl, ADMIN_ACCOUNT)?.apiToken;
    if (!token) throw new Error(message('Run admin login --token-stdin first.', '먼저 admin login --token-stdin으로 관리자 인증을 연결하세요.'));
    let result;
    try {
      result = await deps.apiRequest(flags, route, { method: body ? 'PATCH' : 'GET', apiBaseUrl, adminToken: token, ...(body ? { body } : {}) });
    } catch (cause) {
      const error = new Error(message('Administrator request failed.', '관리자 요청에 실패했습니다.'));
      error.code = ['admin_auth_required', 'agent_report_not_found', 'request_timeout', 'request_failed'].includes(cause?.code) ? cause.code : 'admin_request_failed';
      if (Number.isInteger(cause?.status)) error.status = cause.status;
      throw error;
    }
    if ((action === 'login' || subcommand === 'list') ? !Array.isArray(result?.items)
      : subcommand === 'get' ? !result?.report?.report_id : result?.ok !== true) {
      throw new Error('Invalid administrator API response');
    }
    if (action === 'login') {
      store.save({ apiBaseUrl, apiToken: token, accountId: ADMIN_ACCOUNT });
      return deps.output(flags, { status: 'authenticated', api_base_url: apiBaseUrl, credential_storage: 'os-credential-store' },
        () => console.log(message('Administrator connected using the OS credential store.', '관리자 인증을 OS 보안 저장소에 보관했습니다.')));
    }
    result = redactAuthError(result, [token]);
    deps.output(flags, result, (value) => {
      if (subcommand === 'list') {
        for (const item of value.items || []) console.log([item.report_id, item.status, item.project_id, item.created_at, item.summary].map(cell).join('\t'));
        if (value.next_cursor) console.log(`Next cursor: ${cell(value.next_cursor)}`);
      } else if (subcommand === 'get') {
        const report = value.report;
        console.log(`${cell(report.report_id)}\t${cell(report.status)}\t${cell(report.project_id)}`);
        for (const key of ['summary', 'details', 'expected', 'actual', 'error_code']) if (report[key]) console.log(`${key}: ${String(report[key]).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')}`);
      } else console.log(`${cell(value.report_id)}: ${cell(value.status)}`);
    });
  };
}

function cell(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }

async function readAdminToken(input) {
  if (input.isTTY) throw new Error('Pipe the administrator credential to standard input; never paste it into chat.');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
      if (size > 5120) throw new Error('invalid input');
    }
    const token = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('invalid input');
    return token;
  } catch { throw new Error('Administrator input must contain one credential (1-5120 UTF-8 bytes).'); }
  finally { for (const bytes of chunks) bytes.fill(0); }
}

module.exports = { createAdminReportCommands };
