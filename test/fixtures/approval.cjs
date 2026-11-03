exports.approvalResponse = function (request, token) {
  if (request.url === '/v1/auth/approval-link/capabilities') return { approval_link: true, version: 1 };
  if (request.url === '/v1/auth/approval-link/requests') { const id = 'r'.repeat(48); return { status: 'pending', request_id: id, request_secret: 's'.repeat(48), approval_url: `https://joripspace.com/connect/device/?request=${id}`, expires_at: new Date(Date.now() + 300000).toISOString(), interval: 5 }; }
  if (request.url === '/v1/auth/approval-link/status') return { status: 'connected', connect_token: token };
  return null;
};
