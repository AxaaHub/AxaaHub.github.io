import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

// Resolve real destination records instead of OS getaddrinfo results, which may
// be synthetic Fake-IP addresses in local proxy environments.
const resolver = new Resolver({ timeout: 1500, tries: 2 });
const servers = (process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8').split(',').map(x => x.trim());
if (!servers.length || servers.some(value => !isIP(value))) {
  throw new Error('DNS_SERVERS 必须为逗号分隔的 DNS 服务器 IP 地址。');
}
resolver.setServers(servers);

export async function publicLookup(hostname) {
  const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const answers = results.flatMap((result, index) => result.status === 'fulfilled'
    ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : []);
  if (!answers.length) throw new Error('DNS resolution failed');
  return answers;
}
