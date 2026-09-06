export default {
  async fetch(request, env) {
    return new Response('{{MESSAGE}}', {
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  },
};
