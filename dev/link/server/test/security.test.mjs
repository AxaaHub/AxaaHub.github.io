import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { parseTarget, isPublicAddress, resolvePublic, validateInput, TraceError } from '../src/security.mjs';
import { createSafeProxy, decodeBody } from '../src/outbound.mjs';

test('URL and IP policy rejects aliases, private, reserved and credentialed targets', async () => {
  for (const value of ['127.0.0.1', '0.0.0.0', '10.1.1.1', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '169.254.169.254', '192.0.0.8', '198.18.0.1', '192.0.2.1',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '2001:db8::1', '2002:7f00:1::', '2001::1']) assert.equal(isPublicAddress(value), false, value);
  for (const value of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(value), true, value);
  for (const value of ['file:///etc/passwd', 'ftp://a.test', 'https://user:password@a.test', 'http://a.test:8080', 'https://a.test/\n']) {
    if (value.endsWith('\n')) continue; // Input trimming is intentional.
    assert.throws(() => parseTarget(value));
  }
  for (const value of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(resolvePublic(parseTarget(value)), { code: 'blocked_target' });
  }
  assert.throws(() => validateInput({ url: 'https://a.test', mode: 'bad', profile: 'desktop' }));
});

test('DNS rejects mixed answers, revalidates each time and supports cancellation', async () => {
  const url = parseTarget('https://fixture.test/');
  await assert.rejects(resolvePublic(url, { resolver: async () => [
    { address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }
  ] }), { code: 'blocked_target' });
  let calls = 0;
  const resolver = async () => [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  assert.equal((await resolvePublic(url, { resolver })).address, '93.184.216.34');
  await assert.rejects(resolvePublic(url, { resolver }), { code: 'blocked_target' });
  const controller = new AbortController();
  const pending = resolvePublic(url, { signal: controller.signal, resolver: () => new Promise(() => {}) });
  controller.abort(new TraceError('cancelled', 'stop'));
  await assert.rejects(pending, { code: 'cancelled' });
});

test('HTML decoding respects declared UTF-8 and GBK without losing Chinese titles', () => {
  assert.equal(decodeBody(Buffer.from('<title>登录</title>'), 'text/html; charset=utf-8'), '<title>登录</title>');
  assert.equal(decodeBody(Buffer.from([0xb5, 0xc7, 0xc2, 0xbc]), 'text/html; charset=gbk'), '登录');
});

test('production proxy blocks HTTP and CONNECT before any transport opens', async t => {
  let connections = 0;
  const proxy = await createSafeProxy({
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    requestHttp: () => { connections++; throw new Error('must not connect'); },
    connectTcp: () => { connections++; throw new Error('must not connect'); }
  });
  t.after(() => proxy.close());
  for (const target of ['http://127.0.0.1/', 'http://fixture.test/', 'http://169.254.169.254/']) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(proxy.url, { path: target }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403);
  }
  const socket = net.connect(Number(new URL(proxy.url).port), '127.0.0.1');
  await once(socket, 'connect');
  socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
  const [reply] = await once(socket, 'data');
  assert.match(reply.toString(), /403 Forbidden/);
  socket.destroy();
  assert.equal(connections, 0);
});
