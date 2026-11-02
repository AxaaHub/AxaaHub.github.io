import test from 'node:test';
import assert from 'node:assert/strict';
import { traceQuick } from '../src/quick.mjs';
import { TraceError } from '../src/security.mjs';
import { declaredTargets } from '../src/model.mjs';

const input = { url: 'http://fixture.test/start?a=%2B&b=1', mode: 'quick', profile: 'desktop' };
function response(status, headers = {}, body = '') {
  return { status, headers: { 'content-type': 'text/html', ...headers }, body };
}

test('HTTP chain resolves relative Location, keeps encoded query and cookies', async () => {
  const calls = [];
  const result = await traceQuick(input, { request: async (url, options) => {
    calls.push(url);
    if (calls.length === 1) return response(302, { location: '/next?token=%2B%2F', 'set-cookie': ['session=abc; Path=/; HttpOnly'] });
    assert.match(options.headers.cookie, /session=abc/);
    return response(200, {}, '<title>finished</title>');
  } });
  assert.deepEqual(calls, [input.url, 'http://fixture.test/next?token=%2B%2F']);
  assert.equal(result.hops[0].transition, 'http_redirect');
  assert.equal(result.final.title, 'finished');
  assert.equal(result.termination.reason, 'http_complete');
  assert.equal(result.isPartial, false);
});

test('login endpoint stays final, ReturnUrl is only a declared target', async () => {
  const login = 'https://passport.fixture.test/login?ReturnUrl=https%3A%2F%2Fitem.fixture.test%2F123%3Fa%3D%252B';
  const result = await traceQuick(input, { request: async url =>
    url === input.url ? response(302, { location: login }) : response(200, {}, '<title>登录</title>') });
  assert.equal(result.termination.reason, 'login_page');
  assert.equal(result.final.url, login);
  assert.deepEqual(result.declaredTargets.map(x => [x.url, x.visited]),
    [['https://item.fixture.test/123?a=%2B', false]]);
});

test('loop, hop limit and restricted redirect preserve partial responses', async () => {
  const loop = await traceQuick(input, { request: async () => response(302, { location: '/start?a=%2B&b=1' }) });
  assert.equal(loop.termination.reason, 'loop');
  const limited = await traceQuick(input, { maxHops: 2,
    request: async url => response(302, { location: url + 'a' }) });
  assert.equal(limited.termination.reason, 'hop_limit');
  assert.equal(limited.hops.length, 2);
  const blocked = await traceQuick(input, { request: async url => {
    if (url === input.url) return response(302, { location: 'http://127.0.0.1/' });
    throw new TraceError('blocked_target', 'blocked');
  } });
  assert.equal(blocked.final.url, input.url);
  assert.equal(blocked.hops[1].status, null);
  assert.equal(blocked.termination.reason, 'blocked_target');
});

test('200 script page is not followed or called a browser endpoint', async () => {
  let calls = 0;
  const result = await traceQuick(input, { request: async () => {
    calls++; return response(200, {}, '<script>location.href="/later"</script>');
  } });
  assert.equal(calls, 1);
  assert.equal(result.termination.reason, 'http_complete');
});

test('same URL after a cookie update is allowed rather than mistaken for a loop', async () => {
  let calls = 0;
  const result = await traceQuick(input, { request: async (_, options) => {
    if (++calls === 1) return response(302, { location: input.url, 'set-cookie': ['visited=yes; Path=/'] });
    assert.match(options.headers.cookie, /visited=yes/);
    return response(200, {}, '<title>complete</title>');
  } });
  assert.equal(calls, 2);
  assert.equal(result.termination.reason, 'http_complete');
});

test('cancellation keeps completed hops; target extraction does not double decode', async () => {
  const controller = new AbortController();
  const result = await traceQuick(input, { signal: controller.signal, request: async () => {
    controller.abort(new TraceError('cancelled', 'stop'));
    return response(302, { location: '/next' });
  } });
  assert.equal(result.termination.reason, 'cancelled');
  assert.equal(result.hops[0].status, 302);
  assert.deepEqual(declaredTargets(['https://a.test/?next=javascript%3Aalert(1)'], []), []);
});
