import { CookieJar } from 'tough-cookie';
import { pinnedRequest } from './outbound.mjs';
import { parseTarget } from './security.mjs';
import { createResult, inspectHTML, finishResult, errorReason, REDIRECTS, AGENTS } from './model.mjs';

export async function traceQuick(input, { signal, emit = () => {}, request = pinnedRequest, maxHops = 20 } = {}) {
  const started = Date.now();
  const result = createResult(input);
  const jar = new CookieJar();
  const seen = new Set();
  let target = parseTarget(input.url).href;
  let reason = 'http_complete';
  try {
    while (true) {
      signal?.throwIfAborted();
      const url = parseTarget(target).href;
      const cookie = await jar.getCookieString(url);
      // Fragments do not create different HTTP requests.
      const key = JSON.stringify([url.split('#')[0], cookie]);
      if (seen.has(key)) { reason = 'loop'; break; }
      if (result.hops.length >= maxHops) { reason = 'hop_limit'; break; }
      seen.add(key);
      const stepStarted = Date.now();
      const hop = { index: result.hops.length + 1, url, status: null,
        transition: 'pending', nextUrl: null, elapsedMs: 0 };
      result.hops.push(hop);
      emit({ type: 'progress', result });
      const response = await request(url, { signal,
        headers: { 'user-agent': AGENTS[input.profile], accept: 'text/html,*/*;q=0.8', ...(cookie ? { cookie } : {}) } });
      hop.status = response.status;
      hop.elapsedMs = Date.now() - stepStarted;
      for (const cookieValue of response.headers['set-cookie'] || []) {
        await jar.setCookie(cookieValue, url, { ignoreError: true });
      }
      const html = /text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] || '');
      const info = html ? inspectHTML(response.body, url) : { title: '', reason: null };
      result.final = { url, status: response.status, title: info.title };
      if (REDIRECTS.has(response.status) && response.headers.location) {
        target = new URL(response.headers.location, url).href;
        hop.transition = 'http_redirect';
        hop.nextUrl = target;
        emit({ type: 'progress', result });
        continue;
      }
      hop.transition = 'end';
      if (/attachment/i.test(response.headers['content-disposition'] || '')) reason = 'download';
      else if (info.reason) reason = info.reason;
      else if (response.status >= 400) reason = 'http_error';
      if (response.truncated) result.bodyTruncated = true;
      break;
    }
  } catch (error) {
    reason = errorReason(error, signal);
    const hop = result.hops.at(-1);
    if (hop?.status === null) hop.transition = 'failed';
  }
  return finishResult(result, reason, started);
}
