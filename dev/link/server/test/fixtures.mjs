import http from 'node:http';
import { once } from 'node:events';
import { createSafeProxy } from '../src/outbound.mjs';

// All test traffic terminates at this owned fixture. No third-party site is contacted.
export async function fixtureServer() {
  const hits = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const url = new URL(request.url, 'http://fixture.test');
    hits.push({ path: url.pathname, headers: request.headers });
    if (url.pathname === '/start') {
      response.writeHead(302, { location: '/script?token=%2B', 'set-cookie': 'test_cookie=yes; Path=/; HttpOnly' });
      response.end(); return;
    }
    if (url.pathname === '/script') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<title>Script</title><img src="http://127.0.0.1/private"><script src="/asset.js"></script><script>setTimeout(()=>location.href="/refresh",200)</script>');
      return;
    }
    if (url.pathname === '/refresh') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<title>Refresh</title><meta http-equiv="refresh" content="1;url=/login?ReturnUrl=https%3A%2F%2Fitem.fixture.test%2F123%3Ftoken%3D%252B">');
      return;
    }
    if (url.pathname === '/login') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<title>登录</title><h1>登录</h1><input type="password">'); return;
    }
    if (url.pathname === '/private-redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1/private' }); response.end(); return;
    }
    if (url.pathname === '/loop') {
      response.writeHead(302, { location: '/loop' }); response.end(); return;
    }
    if (url.pathname === '/delayed') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<title>Waiting</title><script>setTimeout(()=>location.href="/login",5000)</script>'); return;
    }
    if (url.pathname === '/asset.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.end('/* fixture */'); return;
    }
    if (url.pathname === '/download') {
      response.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"' }); response.end('fixture'); return;
    }
    if (url.pathname === '/protocol') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<script>location.href="exampleapp://fixture"</script>'); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>Fixture</title><h1>Fixture page</h1>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const blocked = [];
  const proxyFactory = options => createSafeProxy({
    ...options,
    onBlocked: item => { blocked.push(item); options.onBlocked?.(item); },
    resolver: async hostname => {
      if (!hostname.endsWith('.test')) throw new Error('test fixture refuses external DNS');
      return [{ address: '93.184.216.34', family: 4 }];
    },
    requestHttp: options => {
      if (options.hostname !== '93.184.216.34') throw new Error('unexpected unvalidated address');
      return http.request({ ...options, hostname: '127.0.0.1', family: 4, port });
    },
    connectTcp: () => { throw new Error('fixture does not support external TLS'); }
  });
  return { proxyFactory, hits, blocked, close: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  }) };
}
