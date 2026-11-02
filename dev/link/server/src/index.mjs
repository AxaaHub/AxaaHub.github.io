import { createApp } from './server.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const maxConcurrent = Number(process.env.MAX_CONCURRENT || 2);
const rateLimit = Number(process.env.RATE_LIMIT || 6);
const allowedHosts = (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map(x => x.trim()).filter(Boolean);
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8 ||
    !Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 120) {
  throw new Error('PORT、MAX_CONCURRENT 或 RATE_LIMIT 配置不正确。');
}
const server = createApp({ origins, allowedHosts, maxConcurrent, rateLimit, token: process.env.API_TOKEN || '' });
server.listen(port, host, () => console.log('链接检查工具：http://' + host + ':' + port));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await server.shutdown(); process.exit(0); });
}
