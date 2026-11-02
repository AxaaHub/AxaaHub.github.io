import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HISTORY_KEY } from '../../history.mjs';

function fixture() {
  const values = new Map([['unrelated-tool', 'keep']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, storage };
}
function input(n = 0) { return { url: 'https://fixture.test/?token=%2B&n=' + n, mode: 'browser', profile: 'desktop' }; }
const result = { startedAt: '2026-11-02T00:00:00Z', final: { url: 'https://final.test/' },
  termination: { reason: 'login_page' }, hops: [{}] };

test('history persists, deduplicates by full URL/mode/profile and keeps newest 20', () => {
  const { storage, values } = fixture();
  const history = createHistory(storage);
  for (let i = 0; i < 24; i++) history.add(input(i), result);
  assert.equal(history.items.length, 20);
  history.add(input(10), result);
  assert.equal(history.items.length, 20);
  assert.equal(history.items[0].originalUrl, input(10).url);
  history.add({ ...input(10), mode: 'quick' }, result);
  assert.equal(history.items[0].mode, 'quick');
  assert.equal(createHistory(storage).items[1].originalUrl, input(10).url);
  assert.equal(values.get('unrelated-tool'), 'keep');
  assert.ok(!values.get(HISTORY_KEY).includes('"hops"'));
});

test('disable, delete and clear only affect this tool history', () => {
  const { storage, values } = fixture();
  const history = createHistory(storage);
  history.add(input(), result);
  history.setEnabled(false);
  history.add(input(1), result);
  assert.equal(history.items.length, 1);
  assert.equal(createHistory(storage).enabled, false);
  history.remove(history.items[0]);
  assert.equal(history.items.length, 0);
  history.setEnabled(true); history.add(input(), result); history.clear();
  assert.equal(createHistory(storage).items.length, 0);
  assert.equal(values.get('unrelated-tool'), 'keep');
});

test('corruption, unavailable storage and quota degrade without breaking queries', () => {
  const { storage, values } = fixture();
  values.set(HISTORY_KEY, '{broken');
  const warnings = [];
  const recovered = createHistory(storage, message => warnings.push(message));
  recovered.add(input(), result);
  assert.equal(recovered.items.length, 1);
  assert.equal(warnings.length, 1);
  const denied = createHistory({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, message => warnings.push(message));
  assert.doesNotThrow(() => denied.add(input(), result));
  assert.equal(denied.items.length, 1);
  const limited = createHistory({ getItem: () => null, setItem(key, value) {
    if (value.length > 600) { const error = new Error(); error.name = 'QuotaExceededError'; throw error; }
  } });
  for (let i = 0; i < 5; i++) limited.add(input(i), result);
  assert.ok(limited.items.length < 5);
});
