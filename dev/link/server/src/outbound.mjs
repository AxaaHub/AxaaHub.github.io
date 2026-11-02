import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { parseTarget, resolvePublic, TraceError } from './security.mjs';

const MAX_BODY = 512 * 1024;
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export function decodeBody(body, contentType = '') {
  const prefix = body.subarray(0, 2048).toString('ascii');
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ||
    /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(body); }
  catch { return body.toString('utf8'); }
}

export function cleanHeaders(headers) {
  const forbidden = new Set([...HOP_HEADERS,
    ...String(headers.connection || '').toLowerCase().split(',').map(x => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !forbidden.has(key.toLowerCase())));
}

export async function pinnedRequest(target, { signal, headers = {}, resolver } = {}) {
  const url = parseTarget(target);
  const address = await resolvePublic(url, { signal, resolver });
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request({
      hostname: address.address,
      family: address.family,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { ...headers, host: url.host, 'accept-encoding': 'identity', connection: 'close' },
      signal,
      agent: false,
      timeout: 12000
    }, response => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on('data', chunk => {
        const room = MAX_BODY - size;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size += chunk.length;
        if (size > MAX_BODY) {
          truncated = true;
          response.destroy();
          finish();
        }
      });
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        let body = Buffer.concat(chunks);
        try {
          const options = { maxOutputLength: MAX_BODY };
          if (response.headers['content-encoding'] === 'gzip') body = gunzipSync(body, options);
          if (response.headers['content-encoding'] === 'deflate') body = inflateSync(body, options);
          if (response.headers['content-encoding'] === 'br') body = brotliDecompressSync(body, options);
        } catch { body = Buffer.alloc(0); truncated = true; }
        resolve({ status: response.statusCode, headers: response.headers,
          body: decodeBody(body, response.headers['content-type']), truncated });
      }
      response.on('end', finish);
      response.on('error', error => { if (!done) reject(error); });
    });
    request.on('timeout', () => request.destroy(new TraceError('network_error', '目标响应超时。')));
    request.on('error', reject);
    request.end();
  });
}

// Every browser connection, including subresources and redirected HTTPS tunnels,
// resolves and pins its destination here. This proxy only listens on loopback.
export async function createSafeProxy({ signal, resolver, onBlocked = () => {},
  requestHttp = options => http.request(options),
  connectTcp = options => net.connect(options)
} = {}) {
  const sockets = new Set();
  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    return socket;
  }
  const server = http.createServer(async (request, response) => {
    let upstream;
    try {
      if (!['GET', 'HEAD'].includes(request.method)) throw new TraceError('blocked_method', '已阻止非只读请求。');
      const url = parseTarget(request.url);
      if (url.protocol !== 'http:') throw new TraceError('blocked_target', '代理请求格式错误。');
      const address = await resolvePublic(url, { signal, resolver });
      signal?.throwIfAborted();
      upstream = requestHttp({
        hostname: address.address, family: address.family, port: url.port || 80,
        method: request.method, path: url.pathname + url.search, agent: false, signal,
        headers: { ...cleanHeaders(request.headers), host: url.host, connection: 'close' },
        timeout: 12000
      });
      upstream.on('response', remote => {
        response.writeHead(remote.statusCode, cleanHeaders(remote.headers));
        let bytes = 0;
        remote.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) { remote.destroy(); response.destroy(); }
        });
        remote.on('error', () => response.destroy());
        remote.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.on('timeout', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      upstream.end();
    } catch (error) {
      onBlocked({ url: request.url, code: error.code });
      response.writeHead(403);
      response.end();
    }
  });
  server.on('connection', track);
  server.on('connect', async (request, client, head) => {
    try {
      const url = parseTarget('https://' + request.url);
      if (url.pathname !== '/' || url.search || url.hash) throw new TraceError('blocked_target', '隧道目标不正确。');
      const address = await resolvePublic(url, { signal, resolver });
      signal?.throwIfAborted();
      const remote = track(connectTcp({
        host: address.address, family: address.family, port: Number(url.port) || 443
      }));
      client.once('close', () => remote.destroy());
      await once(remote, 'connect', { signal });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      let bytes = 0;
      remote.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) { remote.destroy(); client.destroy(); }
      });
      client.pipe(remote);
      remote.pipe(client);
    } catch (error) {
      onBlocked({ url: 'https://' + request.url, code: error.code });
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('clientError', (_, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: async () => { signal?.removeEventListener('abort', abort); await close(); }
  };
}
