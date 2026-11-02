import { chromium } from 'playwright';
import { createSafeProxy } from './outbound.mjs';
import { parseTarget } from './security.mjs';
import { createResult, finishResult, errorReason, inspectHTML, AGENTS } from './model.mjs';

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

export async function traceBrowser(input, {
  signal, emit = () => {}, maxHops = 20, observationMs = 30000,
  proxyFactory = createSafeProxy, launch = options => chromium.launch(options)
} = {}) {
  const started = Date.now();
  const result = createResult(input);
  let browser, proxy, page, timer;
  let reason, targetUrl;
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const pending = new Map();
  const blockedHosts = new Map();
  let resources = 0;
  let frameID;
  let hint;
  let lastCommit = '';
  const seen = new Map();
  function mainRequest(request) {
    try { return request.isNavigationRequest() && request.frame() === page?.mainFrame(); }
    catch { return false; }
  }

  function stop(value, target) {
    if (reason) return;
    reason = value;
    targetUrl = target;
    done();
  }
  function progress() {
    result.durationMs = Date.now() - started;
    emit({ type: 'progress', result });
  }
  const abort = () => stop(errorReason(null, signal));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    signal?.throwIfAborted();
    proxy = await proxyFactory({
      signal, onBlocked: item => blockedHosts.set(hostOf(item.url), item.code || 'blocked_target')
    });
    signal?.throwIfAborted();
    browser = await launch({
      headless: true,
      timeout: Math.min(10000, observationMs),
      chromiumSandbox: true,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
      ]
    });
    signal?.throwIfAborted();
    if (reason) return finishResult(result, reason, started);
    const context = await browser.newContext({
      userAgent: AGENTS[input.profile],
      viewport: input.profile === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: input.profile === 'mobile',
      hasTouch: input.profile === 'mobile',
      locale: 'zh-CN',
      serviceWorkers: 'block',
      acceptDownloads: false
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const main = mainRequest(request);
      try {
        if (++resources > 250) { stop('resource_limit'); return await route.abort(); }
        parseTarget(request.url());
        if (!['GET', 'HEAD'].includes(request.method())) {
          if (main) stop('blocked_method', request.url());
          return await route.abort();
        }
        if (reason) return await route.abort();
        await route.continue();
      } catch (error) {
        if (main) stop(error.code || 'blocked_target', request.url());
        await route.abort().catch(() => {});
      }
    });
    context.on('page', popup => {
      if (page && popup !== page) {
        stop('popup', popup.url());
        void popup.close().catch(() => {});
      }
    });
    page = await context.newPage();
    page.on('dialog', dialog => {
      stop('dialog');
      void dialog.dismiss().catch(() => {});
    });
    page.on('download', download => {
      stop('download', download.url());
      void download.cancel().catch(() => {});
    });
    page.on('crash', () => stop('browser_error'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    frameID = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    cdp.on('Page.frameRequestedNavigation', event => {
      if (event.frameId !== frameID) return;
      hint = event;
      if (event.disposition !== 'currentTab') { stop('popup', event.url); return; }
      try { parseTarget(event.url); } catch (error) {
        stop(error.code || 'unsupported_protocol', event.url);
      }
    });
    cdp.on('Page.navigatedWithinDocument', event => {
      if (reason || event.frameId !== frameID || event.url === lastCommit) return;
      const previous = result.hops.at(-1);
      if (result.hops.length >= maxHops) { stop('hop_limit', event.url); return; }
      if (previous) { previous.transition = 'same_document'; previous.nextUrl = event.url; }
      result.hops.push({ index: result.hops.length + 1, url: event.url, status: null,
        transition: 'end', nextUrl: null, elapsedMs: 0, sameDocument: true });
      lastCommit = event.url;
      result.final = { url: event.url, status: null, title: result.final?.title || '' };
      progress();
    });
    page.on('request', request => {
      if (reason || !mainRequest(request)) return;
      if (result.hops.length >= maxHops) { stop('hop_limit', request.url()); return; }
      const previous = result.hops.at(-1);
      if (previous) {
        previous.nextUrl = request.url();
        previous.transition = request.redirectedFrom() ? 'http_redirect' :
          hint?.url === request.url() && hint?.reason === 'scriptInitiated' ? 'javascript' :
          hint?.url === request.url() && ['metaTagRefresh', 'httpHeaderRefresh'].includes(hint?.reason) ? 'refresh' : 'navigation';
      }
      hint = null;
      const count = (seen.get(request.url()) || 0) + 1;
      seen.set(request.url(), count);
      if (count > 2) { stop('loop', request.url()); return; }
      const hop = { index: result.hops.length + 1, url: request.url(),
        status: null, transition: 'pending', nextUrl: null, elapsedMs: 0 };
      pending.set(request, { hop, started: Date.now() });
      result.hops.push(hop);
      progress();
    });
    page.on('response', response => {
      const item = pending.get(response.request());
      if (!item || reason) return;
      const blocked = blockedHosts.get(hostOf(response.url()));
      if (blocked) { item.hop.transition = 'failed'; stop(blocked, response.url()); return; }
      item.hop.status = response.status();
      item.hop.elapsedMs = Date.now() - item.started;
      item.hop.transition = response.status() >= 300 && response.status() < 400 ? 'http_redirect' : 'end';
      result.final = { url: response.url(), status: response.status(), title: '' };
      if (response.status() === 401) stop('login_page');
      if (/attachment/i.test(response.headers()['content-disposition'] || '')) stop('download', response.url());
      progress();
    });
    page.on('requestfailed', request => {
      const item = pending.get(request);
      if (!item || reason) return;
      item.hop.elapsedMs = Date.now() - item.started;
      item.hop.transition = 'failed';
      const errorText = request.failure()?.errorText || '';
      // A page may replace an in-flight navigation. Its successor is recorded separately.
      if (/ERR_ABORTED/.test(errorText)) return;
      stop(blockedHosts.get(hostOf(request.url())) ||
        (/CERT_|SSL_/.test(errorText) ? 'tls_error' : 'network_error'), request.url());
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && /^https?:/.test(frame.url())) lastCommit = frame.url();
    });
    async function inspect() {
      if (reason || !page || page.isClosed() || !/^https?:/.test(page.url())) return;
      try {
        const info = inspectHTML(await page.content(), page.url());
        if (result.final?.url === page.url()) result.final.title = info.title;
        if (info.reason) stop(info.reason);
      } catch {}
    }
    page.on('domcontentloaded', () => { void inspect(); });
    const inspector = setInterval(() => { void inspect(); }, 600);
    timer = setTimeout(() => {
      const last = result.hops.at(-1);
      stop(last?.status === null && !last.sameDocument ? 'timeout' :
        last?.status >= 400 ? 'http_error' : 'observation_complete');
    }, Math.max(1, observationMs - (Date.now() - started)));
    void page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: observationMs }).catch(error => {
      if (!reason && !/ERR_ABORTED|interrupted by another navigation|Download is starting/i.test(error.message)) {
        stop(blockedHosts.get(hostOf(result.hops.at(-1)?.url)) ||
          (/Timeout/.test(error.name) ? 'timeout' : /CERT_|SSL_/.test(error.message) ? 'tls_error' : 'network_error'));
      }
    });
    await completed;
    clearInterval(inspector);
    await inspect();
  } catch (error) {
    if (!reason) reason = errorReason(error, signal);
    if (!browser && !signal?.aborted) reason = 'browser_unavailable';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
  }
  for (const hop of result.hops) {
    if (hop.transition === 'pending') hop.transition = 'failed';
  }
  return finishResult(result, reason || 'browser_error', started, targetUrl ? { targetUrl } : {});
}
