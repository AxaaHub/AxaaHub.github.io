import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHTML } from '../src/model.mjs';

test('page inspection distinguishes access restrictions, CAPTCHA and login', () => {
  assert.equal(inspectHTML('<title>PC频控页 -京东商城</title>', 'https://frequent.fixture.test/').reason, 'site_restricted');
  assert.equal(inspectHTML('<title>安全验证</title>', 'https://fixture.test/').reason, 'captcha');
  assert.equal(inspectHTML('<title>Account</title><iframe src="https://captcha.fixture.test/widget"></iframe>', 'https://fixture.test/').reason, 'captcha');
  assert.equal(inspectHTML('<title>登录</title><body><input type="password"></body>', 'https://fixture.test/account').reason, 'login_page');
  assert.equal(inspectHTML('', 'https://fixture.test/').reason, null);
});

test('normal pages containing challenge strings inside scripts are not false positives', () => {
  const html = '<html><head><title>商品</title></head><body><h1>商品详情</h1><script>const message="captcha 安全验证 登录";</script></body></html>';
  assert.equal(inspectHTML(html, 'https://fixture.test/').reason, null);
});
