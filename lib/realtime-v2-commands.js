function createRealtimeV2Commands(deps) {
  return async function realtimeV2(rest, flags) {
    const command = rest[0] || 'status';
    if (command === 'docs') {
      deps.output(
        flags,
        {
          sdk_version: '2.0.1',
          manual: 'manual://realtime/v2',
          source: 'packages/realtime-sdk',
          example: 'examples/realtime-v2-orders',
          manifest_url: 'https://joripspace.com/sdk/realtime/2.0.1/manifest.json',
          example_url: 'https://joripspace.com/sdk/realtime/2.0.1/examples/orders/README.md',
        },
        (value) => console.log(JSON.stringify(value, null, 2))
      );
      return;
    }
    const project = deps.requireProjectId(flags);
    const actions = {
      status: ['GET', ''],
      activate: ['POST', '/activate'],
      rotate: ['POST', '/rotate'],
      disable: ['POST', '/disable'],
      keys: ['GET', '/keys'],
      deletion: ['GET', '/deletion'],
    };
    let action = actions[command];
    if (command === 'revoke-key') {
      const kid = deps.stringFlag(flags, 'kid');
      if (!/^[a-zA-Z0-9_-]+$/.test(kid || '')) throw new Error('revoke-key requires --kid');
      action = ['DELETE', '/keys/' + encodeURIComponent(kid)];
    }
    if (!action)
      throw new Error('realtime-v2: status, activate, rotate, disable, keys, revoke-key, deletion, docs');
    const cursor = deps.stringFlag(flags, 'cursor');
    const path = `/v1/projects/${encodeURIComponent(project)}/realtime-v2${action[1]}${command === 'keys' && cursor ? '?after=' + encodeURIComponent(cursor) : ''}`;
    const result = await deps.apiRequest(flags, path, { method: action[0], ...deps.projectAuth(flags) });
    deps.output(flags, result, (value) => console.log(JSON.stringify(value, null, 2)));
  };
}
module.exports = { createRealtimeV2Commands };
