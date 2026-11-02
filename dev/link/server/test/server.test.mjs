import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { createResult, finishResult } from '../src/model.mjs';

const input = { url: 'https://fixture.test/', mode: 'quick', profile: 'desktop' };
async function app(t, options = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  return 'http://127.0.0.1:' + server.address().port;
}
function post(base, data = input, headers = {}) {
  return fetch(base + '/api/trace', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
}
const quick = async data => finishResult(createResult(data), 'http_complete', Date.now());

test('API streams real result shape and rejects invalid input, origin and Host', async t => {
  const base = await app(t, { quick, rateLimit: 20 });
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/server/package.json')).status, 404);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await post(base, { ...input, url: 'file:///a' })).status, 400);
  assert.equal((await post(base, input, { Origin: 'https://attacker.test' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/health', { headers: { host: 'attacker.test' } },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHost, 403);
  const response = await post(base);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'started');
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).result.originalUrl, input.url);
});

test('IP rate limit cannot be bypassed by spoofed forwarding header; auth and CORS work', async t => {
  const base = await app(t, { quick, rateLimit: 1 });
  assert.equal((await post(base)).status, 200);
  const limited = await post(base, input, { 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const auth = await app(t, { quick, token: 'fixture-secret', origins: ['https://allowed.test'] });
  assert.equal((await post(auth)).status, 401);
  const response = await post(auth, input, { Authorization: 'Bearer fixture-secret', Origin: 'https://allowed.test' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.test');
  await response.text();
});

test('concurrent requests are limited and disconnect cancels the running job', async t => {
  let signal;
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const base = await app(t, { maxConcurrent: 1, quick: async (data, options) => {
    signal = options.signal; notify();
    await new Promise(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
    });
    return finishResult(createResult(data), 'cancelled', Date.now());
  } });
  const controller = new AbortController();
  const response = await fetch(base + '/api/trace', { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  await started;
  assert.equal((await post(base)).status, 429);
  const aborted = once(signal, 'abort');
  controller.abort();
  await aborted;
  assert.equal(signal.aborted, true);
  await response.body.cancel().catch(() => {});
});
