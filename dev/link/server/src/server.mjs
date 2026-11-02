import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { validateInput, TraceError } from './security.mjs';
import { traceQuick } from './quick.mjs';
import { traceBrowser } from './browser.mjs';

const ASSETS = new Map([
  ['/', ['../../index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../../index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['../../style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['../../app.mjs', 'text/javascript; charset=utf-8']],
  ['/history.mjs', ['../../history.mjs', 'text/javascript; charset=utf-8']],
  ['/qr.mjs', ['../../qr.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/qrcodegen.mjs', ['../../vendor/qrcodegen.mjs', 'text/javascript; charset=utf-8']],
  ['/config.js', ['../../config.js', 'text/javascript; charset=utf-8']],
  ['/design.html', ['../../design.html', 'text/html; charset=utf-8']],
  ['/setup.html', ['../../setup.html', 'text/html; charset=utf-8']]
]);

function equalSecret(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({
  origins = [], maxConcurrent = 2, rateLimit = 6, maxClients = 1000,
  timeoutMs = 30000, token = '', quick = traceQuick, browser = traceBrowser,
  now = Date.now, allowedHosts = ['localhost', '127.0.0.1', '[::1]']
} = {}) {
  const clients = new Map();
  const controllers = new Set();
  const jobs = new Set();
  let active = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const path = request.url?.split('?')[0];
    const host = request.headers.host;
    const origin = request.headers.origin;
    let hostname;
    try { hostname = new URL('http://' + host).hostname; } catch {}
    const sameOrigins = ['http://' + host, 'https://' + host];
    const allowed = !origin || [...sameOrigins, ...origins].includes(origin);
    if (origin && allowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    if (!allowedHosts.includes(hostname)) return json(403, { error: '请求的服务主机名不在允许列表中。' });
    if (!allowed) return json(403, { error: '来源不在检测接口的允许列表中。' });
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.writeHead(204); response.end(); return;
    }
    if (request.method === 'GET' && path === '/api/health') {
      return json(200, { ok: true, version: 1, modes: ['quick', 'browser'], maxConcurrent, timeoutMs });
    }
    if (request.method === 'GET' && ASSETS.has(path)) {
      const [asset, type] = ASSETS.get(path);
      try {
        const body = await readFile(fileURLToPath(new URL(asset, import.meta.url)));
        response.writeHead(200, { 'Content-Type': type,
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        response.end(body);
      } catch { json(404, { error: '页面文件不存在。' }); }
      return;
    }
    if (request.method !== 'POST' || path !== '/api/trace') {
      return json(404, { error: '接口不存在。' });
    }
    if (token && !equalSecret(request.headers.authorization || '', 'Bearer ' + token)) {
      return json(401, { error: '访问口令不正确。' });
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      return json(415, { error: '请使用 JSON 请求。' });
    }
    // Use the socket address. Never trust a client-provided X-Forwarded-For header.
    const client = request.socket.remoteAddress;
    const current = now();
    for (const [key, entry] of clients) if (current >= entry.until && !entry.active) clients.delete(key);
    let entry = clients.get(client);
    if (!entry) {
      if (clients.size >= maxClients) return json(503, { error: '服务繁忙，请稍后再试。' });
      entry = { until: current + 60000, count: 0, active: false };
      clients.set(client, entry);
    }
    if (current >= entry.until) { entry.count = 0; entry.until = current + 60000; }
    if (entry.count >= rateLimit || entry.active) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - current) / 1000))));
      return json(429, { error: entry.active ? '当前地址已有一项检查正在进行。' : '查询过于频繁，请稍后再试。' });
    }
    if (active >= maxConcurrent) return json(503, { error: '检测并发已满，请稍后再试。' });
    entry.count++;
    entry.active = true;
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort(new TraceError('cancelled', '请求已停止。'));
    response.on('close', abort);
    let timer = setTimeout(() => controller.abort(new TraceError('timeout', '检查超时。')), timeoutMs + 1000);
    let job;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 20000) throw new TraceError('invalid_url', '请求内容过大。');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const input = validateInput(JSON.parse(raw));
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new TraceError('timeout', '检查超时。')),
        timeoutMs + (input.mode === 'browser' ? 1000 : 0));
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      const emit = event => {
        if (!response.destroyed) response.write(JSON.stringify(event) + '\n');
      };
      emit({ type: 'started', originalUrl: input.url, mode: input.mode, profile: input.profile,
        startedAt: new Date().toISOString() });
      job = (input.mode === 'quick' ? quick : browser)(input, {
        signal: controller.signal, emit, observationMs: timeoutMs
      });
      jobs.add(job);
      const result = await job;
      emit({ type: 'result', result });
      response.end();
    } catch (error) {
      if (!response.headersSent) json(400, { error: error instanceof TraceError ? error.message : '请求内容不正确。' });
      else if (!response.destroyed) response.end(JSON.stringify({ type: 'error', error: '检测服务意外中断，请重试。' }) + '\n');
    } finally {
      clearTimeout(timer);
      response.off('close', abort);
      controllers.delete(controller);
      jobs.delete(job);
      entry.active = false;
      active--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 100;
  server.on('close', () => { for (const controller of controllers) controller.abort(); });
  server.shutdown = async () => {
    for (const controller of controllers) controller.abort(new TraceError('cancelled', '服务关闭。'));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await Promise.allSettled([...jobs]);
  };
  return server;
}
