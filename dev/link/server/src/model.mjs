import { parseHTML } from 'linkedom';
import { parseTarget } from './security.mjs';

export const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const AGENTS = {
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36'
};

export function createResult(input) {
  return { originalUrl: input.url, mode: input.mode, profile: input.profile,
    startedAt: new Date().toISOString(), hops: [], final: null, declaredTargets: [],
    termination: { reason: 'running' }, durationMs: 0, isPartial: true };
}

export function inspectHTML(html, url) {
  const { document } = parseHTML(html || '');
  const title = (document.querySelector('title')?.textContent || '').trim().slice(0, 300);
  for (const node of document.querySelectorAll('script,style,noscript')) node.remove();
  const text = document.querySelector('body')?.textContent?.slice(0, 40000) || '';
  const challengeWords = /验证码|人机验证|安全验证|验证身份|captcha|verify you are human|security (?:check|verification)/i;
  const challengeForm = !!document.querySelector('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],input[name*="captcha"],input[id*="captcha"]');
  const captcha = challengeWords.test(title) || challengeForm ||
    /captcha|verify|challenge/i.test(new URL(url).host + new URL(url).pathname) && challengeWords.test(text);
  const restricted = /频控|访问(?:受限|频繁)|操作频繁|请求过于频繁|access denied|too many requests|temporarily blocked/i.test(title);
  const loginURL = /(?:^|[/_.-])(login|signin|sign-in|passport)(?:[/_.-]|$)/i.test(new URL(url).pathname) ||
    /^(passport|login|signin)\./i.test(new URL(url).hostname);
  const loginForm = !!document.querySelector('input[type="password"]') &&
    /登录|登入|sign in|log in/i.test(title + ' ' + text);
  return { title, reason: captcha ? 'captcha' : restricted ? 'site_restricted' :
    loginURL || loginForm ? 'login_page' : null };
}

export function declaredTargets(urls, hops) {
  const result = [];
  const visited = new Set(hops.filter(hop => hop.status !== null || hop.sameDocument).map(hop => hop.url));
  for (const sourceURL of urls) {
    let parsed;
    try { parsed = new URL(sourceURL); } catch { continue; }
    for (const [key, value] of parsed.searchParams) {
      if (!/^(returnurl|redirect_uri|redirect_url|redirect|next|continue|target|url)$/i.test(key)) continue;
      try {
        // URLSearchParams already decodes once. Do not recursively decode/rewrite tokens.
        const target = new URL(value, parsed);
        parseTarget(target.href);
        if (result.some(item => item.url === target.href)) continue;
        result.push({ source: 'query.' + key, sourceUrl: sourceURL,
          url: target.href, visited: visited.has(target.href) });
      } catch {}
    }
  }
  return result;
}

export function finishResult(result, reason, started, extra = {}) {
  result.durationMs = Date.now() - started;
  result.termination = { reason, ...extra };
  result.isPartial = !['http_complete', 'observation_complete', 'login_page'].includes(reason);
  result.declaredTargets = declaredTargets([
    ...result.hops.map(hop => hop.url), result.final?.url
  ].filter(Boolean), result.hops);
  return result;
}

export function errorReason(error, signal) {
  if (signal?.aborted) return signal.reason?.code === 'timeout' ? 'timeout' : 'cancelled';
  if (['blocked_target', 'dns_error', 'unsupported_protocol'].includes(error?.code)) return error.code;
  if (/CERT_|SSL_|TLS_/i.test(error?.code || '')) return 'tls_error';
  return 'network_error';
}
