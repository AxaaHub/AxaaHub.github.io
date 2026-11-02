import ipaddr from 'ipaddr.js';
import { publicLookup } from './dns.mjs';

export class TraceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const MAX_URL_LENGTH = 16384;

export function parseTarget(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH ||
      /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw new TraceError('invalid_url', '请输入有效网址（最长 16 KB），网址中不能包含空格或控制字符。');
  }
  let url;
  try { url = new URL(value.trim()); } catch {
    throw new TraceError('invalid_url', '网址格式不正确，请包含 http:// 或 https://。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TraceError('unsupported_protocol', '仅支持 HTTP 和 HTTPS 网址。');
  }
  if (url.username || url.password) {
    throw new TraceError('invalid_url', '网址中不能包含用户名或密码。');
  }
  if (url.href.length > MAX_URL_LENGTH) {
    throw new TraceError('invalid_url', '网址编码后超出 16 KB 上限。');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new TraceError('blocked_target', '检测服务仅访问标准 HTTP / HTTPS 端口（80、443）。');
  }
  return url;
}

export function isPublicAddress(value) {
  try {
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv4') {
      return !ip.match(ipaddr.parse('192.0.0.0'), 24) &&
        !ip.match(ipaddr.parse('192.88.99.0'), 24);
    }
    // Only global IPv6 unicast, excluding special protocol assignment space.
    return ip.match(ipaddr.parse('2000::'), 3) &&
      !ip.match(ipaddr.parse('2001::'), 23);
  } catch { return false; }
}

export async function resolvePublic(url, { resolver = publicLookup, signal } = {}) {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let answers;
  try {
    if (ipaddr.isValid(hostname)) {
      answers = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
    } else {
      let timer, onAbort;
      try {
        answers = await Promise.race([
          resolver(hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TraceError('dns_error', '域名解析超时。')), 5000);
            onAbort = () => reject(signal.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          })
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  } catch {
    signal?.throwIfAborted();
    throw new TraceError('dns_error', '目标域名解析失败。');
  }
  signal?.throwIfAborted();
  if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
    throw new TraceError('blocked_target', '目标包含内网、回环、链路本地或其他受限地址，已拒绝连接。');
  }
  // Connect to this validated IP; never resolve the hostname a second time.
  return answers[0];
}

export function validateInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TraceError('invalid_url', '请求内容不正确。');
  }
  parseTarget(data.url);
  if (!['quick', 'browser'].includes(data.mode) || !['desktop', 'mobile'].includes(data.profile)) {
    throw new TraceError('invalid_options', '检测方式或设备选项不正确。');
  }
  return { url: data.url.trim(), mode: data.mode, profile: data.profile };
}
