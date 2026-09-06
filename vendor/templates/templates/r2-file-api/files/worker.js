async function cacheTagForKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `r2-${hex}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/files\/(.+)$/);
    if (!match) {
      return Response.json({ ok: true, routes: ['/files/{key}'] });
    }

    const key = decodeURIComponent(match[1]);
    if (request.method === 'GET') {
      const object = await env.STORAGE.get(key);
      if (!object) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
          'Cache-Tag': await cacheTagForKey(key),
        },
      });
    }

    if (request.method === 'PUT') {
      await env.STORAGE.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        },
      });
      await ctx.cache.purge({ tags: [await cacheTagForKey(key)] });
      return Response.json({ ok: true, key }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};
