// Manual UI QA only: a separate localhost port, with every outbound request stubbed.
// Never imported by the production entry point.
import { createApp } from '../src/server.mjs';
import { traceBrowser } from '../src/browser.mjs';
import { traceQuick } from '../src/quick.mjs';
import { fixtureServer } from './fixtures.mjs';

const fixture = await fixtureServer();
const server = createApp({
  rateLimit: 100,
  browser: (input, options) => traceBrowser(input, {
    ...options, proxyFactory: fixture.proxyFactory, observationMs: 8000
  }),
  quick: (input, options) => traceQuick(input, { ...options, request: async (url, requestOptions) => {
    requestOptions.signal?.throwIfAborted();
    const path = new URL(url).pathname;
    return path === '/start'
      ? { status: 302, headers: { location: '/login?ReturnUrl=https%3A%2F%2Fitem.fixture.test%2F123%3Ftoken%3D%252B', 'content-type': 'text/html' }, body: '' }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>登录</title>' };
  } })
});
server.listen(8788, '127.0.0.1', () => console.log('Isolated UI fixture: http://127.0.0.1:8788'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.shutdown(); await fixture.close(); process.exit(0);
});
