import test from 'node:test';
import assert from 'node:assert/strict';
import { traceBrowser } from '../src/browser.mjs';
import { fixtureServer } from './fixtures.mjs';
import { TraceError } from '../src/security.mjs';

const input = path => ({ url: 'http://fixture.test' + path, mode: 'browser', profile: 'desktop' });

test('browser records HTTP, delayed JS and refresh; subresources never become hops', { timeout: 15000 }, async t => {
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  const result = await traceBrowser(input('/start'), { proxyFactory: fixture.proxyFactory, observationMs: 8000 });
  assert.equal(result.termination.reason, 'login_page', JSON.stringify(result));
  assert.deepEqual(result.hops.map(hop => new URL(hop.url).pathname), ['/start', '/script', '/refresh', '/login']);
  assert.deepEqual(result.hops.map(hop => hop.status), [302, 200, 200, 200]);
  assert.equal(result.hops[0].transition, 'http_redirect');
  assert.equal(result.hops[1].transition, 'javascript');
  assert.equal(result.hops[2].transition, 'refresh');
  assert.match(fixture.hits.find(hit => hit.path === '/script').headers.cookie, /test_cookie=yes/);
  assert.equal(result.declaredTargets[0].visited, false);
  assert.equal(result.declaredTargets[0].url, 'https://item.fixture.test/123?token=%2B');
  assert.ok(fixture.blocked.some(item => item.url.includes('127.0.0.1/private')));
  assert.ok(!fixture.hits.some(hit => hit.path === '/private'));
});

test('browser redirect to private target cannot reach fixture transport or become final', { timeout: 10000 }, async t => {
  const fixture = await fixtureServer(); t.after(() => fixture.close());
  const result = await traceBrowser(input('/private-redirect'), { proxyFactory: fixture.proxyFactory, observationMs: 4000 });
  assert.equal(result.termination.reason, 'blocked_target', JSON.stringify(result));
  assert.equal(result.final.url, input('/private-redirect').url);
  assert.ok(!fixture.hits.some(hit => hit.path === '/private'));
});

test('browser observation limit and cancellation release sessions with partial data', { timeout: 10000 }, async t => {
  const fixture = await fixtureServer(); t.after(() => fixture.close());
  const observed = await traceBrowser(input('/delayed'), { proxyFactory: fixture.proxyFactory, observationMs: 1800 });
  assert.equal(observed.termination.reason, 'observation_complete', JSON.stringify(observed));
  assert.equal(observed.hops.length, 1);
  const controller = new AbortController();
  const result = await traceBrowser(input('/delayed'), {
    signal: controller.signal, proxyFactory: fixture.proxyFactory, observationMs: 5000,
    emit: event => { if (event.result.final) controller.abort(new TraceError('cancelled', 'stop')); }
  });
  assert.equal(result.termination.reason, 'cancelled');
  assert.ok(result.hops.length > 0);
});

test('browser detects navigation loops, downloads and external protocols', { timeout: 15000 }, async t => {
  const fixture = await fixtureServer(); t.after(() => fixture.close());
  const loop = await traceBrowser(input('/loop'), { proxyFactory: fixture.proxyFactory, observationMs: 3000 });
  assert.equal(loop.termination.reason, 'loop', JSON.stringify(loop));
  const download = await traceBrowser(input('/download'), { proxyFactory: fixture.proxyFactory, observationMs: 3000 });
  assert.equal(download.termination.reason, 'download', JSON.stringify(download));
  const protocol = await traceBrowser(input('/protocol'), { proxyFactory: fixture.proxyFactory, observationMs: 3000 });
  assert.equal(protocol.termination.reason, 'unsupported_protocol', JSON.stringify(protocol));
});
