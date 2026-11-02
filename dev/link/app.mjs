import { createHistory } from './history.mjs';
import { initQRCode } from './qr.mjs';

const $ = id => document.getElementById(id);
const MODE = { browser: '浏览器检查', quick: '快速检查' };
const PROFILE = { desktop: '桌面', mobile: '手机' };
const REASONS = {
  running: '检查中', http_complete: 'HTTP 链路已结束', observation_complete: '观察窗口结束',
  login_page: '到达登录页', captcha: '遇到验证码', site_restricted: '站点限制访问', timeout: '检查超时',
  loop: '检测到循环', hop_limit: '达到跳转上限', resource_limit: '达到资源上限',
  network_error: '网络请求失败', dns_error: '域名解析失败', tls_error: 'TLS 连接失败',
  blocked_target: '目标地址被拦截', unsupported_protocol: '非 HTTP 协议',
  blocked_method: '非只读请求已停止', cancelled: '已停止', download: '遇到下载',
  popup: '遇到新窗口', dialog: '遇到交互提示', http_error: 'HTTP 错误',
  browser_unavailable: '浏览器服务不可用', browser_error: '浏览器会话中断',
  service_unavailable: '检测服务不可用', invalid_url: '跳转地址无效'
};
const TRANSITIONS = {
  http_redirect: 'HTTP 重定向', javascript: 'JavaScript 跳转', refresh: '刷新跳转',
  navigation: '页面导航', same_document: '页面内导航', end: '当前终点',
  pending: '请求中', failed: '请求未完成'
};
const NOTES = {
  http_complete: '仅完成 HTTP 重定向检查。当前页面可能通过 JavaScript 或刷新继续跳转，可切换浏览器检查。',
  observation_complete: '已记录本次 30 秒观察窗口内的导航；更晚发生的跳转未纳入结果。',
  login_page: '检查在未登录会话的登录页停止。回跳参数中的地址单独列出，不作为实际终点。',
  captcha: '检查在验证页面停止，未尝试通过验证码。',
  site_restricted: '目标站点显示访问限制或频控页面，检查在此停止；未尝试绕过限制。',
  timeout: '已保留超时前的记录，后续导航尚未确认。',
  cancelled: '已保留停止前的记录，后续导航尚未确认。',
  blocked_target: '已阻止对受限网络地址的连接。展示此前实际收到响应的位置。',
  browser_unavailable: '请确认检测服务已安装对应版本的 Chromium，且运行环境支持浏览器沙箱。',
  service_unavailable: '检查检测服务地址、服务运行状态及允许来源配置后重试。'
};
let running = false;
let result = null;
let controller;
let cancelled = false;
let apiBase = '';
let token = '';
let toastTimer;
let expanded = new Set();
const storage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value)
};
function showNotice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function storageWarning(message) { $('storage-warning').textContent = message; $('storage-warning').hidden = false; }
let history = createHistory(storage, storageWarning);

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, action, className = 'text-button') {
  const element = el('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { showNotice('浏览器未允许复制。可选中地址手动复制，或导出文本。'); }
}
function setError(message) {
  $('url-error').textContent = message;
  $('url-error').hidden = !message;
  $('url').setAttribute('aria-invalid', message ? 'true' : 'false');
}
function inputSnapshot() {
  const url = $('url').value.trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('请输入完整网址，包含 http:// 或 https://。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 和 HTTPS 链接。');
  if (parsed.username || parsed.password) throw new Error('网址中不能包含用户名或密码。');
  if (url.length > 16384 || parsed.href.length > 16384 || /[\u0000-\u0020\u007f]/.test(url)) throw new Error('网址编码后不能超过 16 KB，且不能包含空格或控制字符。');
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw new Error('仅支持标准 HTTP / HTTPS 端口（80、443）。');
  return { url, mode: $('mode').value, profile: $('profile').value };
}
function validateBase(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('检测服务请使用 HTTPS；本地服务可使用 localhost 或 127.0.0.1 的 HTTP 地址。');
  }
  return url.href.replace(/\/$/, '');
}
function configureBase() {
  let saved;
  try { saved = storage.getItem('axaahub.link.apiBase'); } catch {}
  const configured = window.LINK_CONFIG?.apiBase;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  try { apiBase = validateBase(configured || saved || (local ? location.origin : '')); }
  catch { apiBase = ''; }
  $('api-base').value = apiBase;
  $('connection-state').textContent = apiBase ? '已设置' : '待设置';
}
function updateHint() {
  $('mode-hint').textContent = $('mode').value === 'browser' ?
    '在独立、未登录的浏览器中运行页面，最多观察 30 秒。' :
    '逐跳检查 HTTP 重定向，保留本次会话 Cookie；不会执行页面脚本。';
}
function fillHistory(item) {
  if (running) return;
  $('url').value = item.originalUrl;
  $('mode').value = item.mode;
  $('profile').value = item.profile;
  updateHint(); setError('');
  toast('已回填，点击“开始检查”重新查询');
  $('url').focus();
}
function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  $('history-enabled').checked = history.enabled;
  $('history-count').textContent = String(history.items.length);
  $('history-empty').hidden = history.items.length > 0;
  $('clear-history').disabled = history.items.length === 0;
  for (const item of history.items) {
    const row = el('div', 'history-row');
    const fill = button('', () => fillHistory(item), 'history-item');
    fill.disabled = running;
    fill.setAttribute('aria-label', '回填 ' + item.originalUrl);
    fill.title = item.originalUrl + (item.finalUrl ? '\n上次终点：' + item.finalUrl : '');
    fill.append(el('span', 'history-url', item.originalUrl));
    fill.append(el('span', 'history-meta', new Date(item.checkedAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }) + ' · ' + MODE[item.mode] + ' · ' + PROFILE[item.profile] + ' · ' + (REASONS[item.reason] || '上次检查')));
    const actions = el('div', 'history-actions');
    const rerun = button('重查', () => { fillHistory(item); void run(); });
    rerun.disabled = running;
    const remove = button('删除', () => { history.remove(item); renderHistory(); }, 'text-button delete');
    remove.setAttribute('aria-label', '删除记录 ' + item.originalUrl);
    actions.append(rerun, remove);
    row.append(fill, actions);
    list.append(row);
  }
}
function validResult(value) {
  return value && Array.isArray(value.hops) && value.hops.length <= 20 &&
    value.hops.every(hop => typeof hop.url === 'string' && hop.url.length <= 16384) &&
    value.termination && typeof value.termination.reason === 'string';
}
function renderResult() {
  if (!result) return;
  $('empty-result').hidden = true;
  $('result').hidden = false;
  const reason = result.termination.reason;
  const partial = result.isPartial && reason !== 'running';
  $('result-context').textContent = MODE[result.mode] + ' · ' + PROFILE[result.profile] + ' · ' +
    new Date(result.startedAt).toLocaleString('zh-CN') + (partial ? ' · 部分结果' : '');
  $('termination').textContent = REASONS[reason] || '检查结束';
  $('termination').className = 'badge' + (['running', 'http_complete', 'observation_complete'].includes(reason) ? '' :
    ['service_unavailable', 'network_error', 'dns_error', 'tls_error', 'browser_unavailable', 'browser_error'].includes(reason) ? ' failure' : ' warning');
  $('final-label').textContent = reason === 'running' ? '当前已到达地址' : partial ? '最后收到响应的地址' : '实际最终地址';
  $('final-url').textContent = result.final?.url || '尚未收到目标页面响应';
  $('final-title').textContent = result.final?.title || '';
  $('copy-final').disabled = !result.final?.url;
  $('address-count').textContent = String(result.hops.length);
  $('redirect-count').textContent = String(Math.max(0, result.hops.length - 1));
  $('duration').textContent = ((result.durationMs || 0) / 1000).toFixed(1);
  $('chain-count').textContent = String(result.hops.length);
  $('result-note').textContent = reason === 'running' ? '正在记录真实发生的导航…' :
    NOTES[reason] || '已保留观察到的记录；未确认的后续地址不作为实际终点。';
  if (result.termination.targetUrl) $('result-note').textContent += '\n停止目标：' + result.termination.targetUrl;
  const targets = Array.isArray(result.declaredTargets) ? result.declaredTargets.slice(0, 40) : [];
  $('declared').hidden = !targets.length;
  $('declared-list').replaceChildren();
  for (const target of targets) {
    const item = el('div', 'declared-item');
    item.append(el('p', 'declared-meta', String(target.source) + ' · ' + (target.visited ? '本次链路中已收到响应' : '尚未访问')));
    item.append(el('p', 'declared-url', String(target.url)));
    item.append(button('复制目标', () => copy(String(target.url))));
    $('declared-list').append(item);
  }
  $('chain').replaceChildren();
  for (const hop of result.hops) {
    const row = el('li', 'hop');
    row.append(el('span', 'hop-index', String(hop.index)));
    const body = el('div', 'hop-body');
    const head = el('div', 'hop-head');
    const status = hop.status ?? (hop.sameDocument ? '—' : '未响应');
    head.append(el('span', 'status-code' + (hop.status >= 300 && hop.status < 400 ? ' redirect' : hop.status >= 400 ? ' bad' : ''), String(status)));
    head.append(el('span', 'transition', TRANSITIONS[hop.transition] || '页面导航'));
    head.append(el('span', 'hop-time', String(Math.round(hop.elapsedMs || 0)) + ' ms'));
    const address = el('p', 'hop-url', hop.url);
    const actions = el('div', 'hop-actions');
    if (hop.url.length > 115) {
      address.classList.toggle('collapsed', !expanded.has(hop.index));
      const expand = button(expanded.has(hop.index) ? '收起参数' : '展开完整地址', () => {
        if (expanded.has(hop.index)) expanded.delete(hop.index); else expanded.add(hop.index);
        address.classList.toggle('collapsed', !expanded.has(hop.index));
        expand.textContent = expanded.has(hop.index) ? '收起参数' : '展开完整地址';
        expand.setAttribute('aria-expanded', String(expanded.has(hop.index)));
      });
      expand.setAttribute('aria-expanded', String(expanded.has(hop.index)));
      actions.append(expand);
    }
    actions.append(button('复制地址', () => copy(hop.url)));
    body.append(head, address, actions);
    row.append(body);
    $('chain').append(row);
  }
}
function setRunning(value) {
  running = value;
  for (const id of ['url', 'mode', 'profile', 'example', 'submit', 'save-connection', 'api-base', 'api-token']) $(id).disabled = value;
  $('stop').hidden = !value;
  $('stop').disabled = false;
  $('submit').textContent = value ? '正在检查…' : '开始检查 →';
  $('live').hidden = !value;
  renderHistory();
}

async function run() {
  if (running) return;
  setError(''); showNotice('');
  let input;
  try { input = inputSnapshot(); } catch (error) { setError(error.message); $('url').focus(); return; }
  if (!apiBase) {
    $('connection').open = true;
    showNotice('请先在连接设置中填写检测服务地址。');
    $('api-base').focus();
    return;
  }
  const started = Date.now();
  result = { originalUrl: input.url, mode: input.mode, profile: input.profile,
    startedAt: new Date().toISOString(), hops: [], final: null, declaredTargets: [],
    termination: { reason: 'running' }, durationMs: 0, isPartial: true };
  expanded = new Set();
  cancelled = false;
  controller = new AbortController();
  setRunning(true); renderResult();
  const ticker = setInterval(() => {
    if (!running) return;
    $('live-text').textContent = '正在检查 · ' + result.hops.length + ' 个地址 · ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒';
  }, 200);
  const timeout = setTimeout(() => controller.abort('client_timeout'), 38000);
  let finished = false;
  try {
    const response = await fetch(apiBase + '/api/trace', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      credentials: 'omit', referrerPolicy: 'no-referrer',
      body: JSON.stringify(input), signal: controller.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '检测接口返回 ' + response.status + '。');
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('检测接口响应格式不正确。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    function event(line) {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.type === 'error') throw new Error(message.error || '检测服务意外中断。');
      if (['progress', 'result'].includes(message.type)) {
        if (!validResult(message.result)) throw new Error('检测结果格式不正确。');
        result = message.result;
        renderResult();
        if (message.type === 'result') finished = true;
      }
    }
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 1024 * 1024) throw new Error('检测结果超出允许大小。');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        event(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!finished) throw new Error('检测连接已中断，已保留收到的部分记录。');
  } catch (error) {
    controller.abort();
    result.termination = { reason: cancelled ? 'cancelled' :
      Date.now() - started >= 38000 ? 'timeout' : 'service_unavailable' };
    result.isPartial = true;
    result.durationMs = Date.now() - started;
    if (!cancelled) showNotice(error.message || '无法连接检测服务。');
  } finally {
    clearInterval(ticker); clearTimeout(timeout);
    result.durationMs = Math.max(result.durationMs || 0, Date.now() - started);
    if (result.termination.reason === 'running') result.termination = { reason: 'network_error' };
    for (const hop of result.hops) if (hop.transition === 'pending') hop.transition = 'failed';
    history.add(input, result);
    setRunning(false); renderResult();
  }
}

function textResult() {
  if (!result) return '';
  const lines = ['链接跳转检查', '查询时间：' + result.startedAt,
    '输入：' + result.originalUrl, '配置：' + MODE[result.mode] + ' / ' + PROFILE[result.profile],
    '状态：' + (REASONS[result.termination.reason] || result.termination.reason),
    '实际终点：' + (result.final?.url || '尚未收到响应'), '', '链路：'];
  for (const hop of result.hops) lines.push(hop.index + '. [' + (hop.status ?? '无 HTTP 状态') + '] ' + hop.url,
    '   ' + (TRANSITIONS[hop.transition] || hop.transition) + ' · ' + hop.elapsedMs + ' ms');
  if (result.declaredTargets?.length) {
    lines.push('', '参数中声明的目标：');
    for (const target of result.declaredTargets) lines.push(target.source + ' · ' + (target.visited ? '已收到响应' : '尚未访问') + ' · ' + target.url);
  }
  return lines.join('\n');
}
function download(type) {
  if (!result) return;
  const blob = new Blob([type === 'json' ? JSON.stringify(result, null, 2) : textResult()], {
    type: type === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = 'link-trace-' + new Date(result.startedAt).toISOString().replace(/[:.]/g, '-') + '.' + type;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('trace-form').addEventListener('submit', event => { event.preventDefault(); void run(); });
$('stop').addEventListener('click', () => { cancelled = true; $('stop').disabled = true; controller?.abort(); });
$('mode').addEventListener('change', updateHint);
$('url').addEventListener('input', () => setError(''));
$('example').addEventListener('click', () => {
  $('url').value = 'https://vip.qust.me/go/o/0f111b2695fa'; setError(''); $('url').focus();
});
$('history-enabled').addEventListener('change', () => { history.setEnabled($('history-enabled').checked); renderHistory(); });
$('clear-history').addEventListener('click', () => $('clear-dialog').showModal());
$('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
$('confirm-clear').addEventListener('click', () => { history.clear(); renderHistory(); $('clear-dialog').close(); toast('已清空最近查询'); });
$('save-connection').addEventListener('click', () => {
  try {
    apiBase = validateBase($('api-base').value.trim());
    token = $('api-token').value.trim();
    try { storage.setItem('axaahub.link.apiBase', apiBase); } catch {}
    $('api-base').value = apiBase;
    $('connection-state').textContent = '已设置';
    showNotice(''); toast('已应用连接设置');
  } catch (error) { showNotice(error.message || '服务地址格式不正确。'); }
});
$('copy-final').addEventListener('click', () => { if (result?.final?.url) void copy(result.final.url); });
$('copy-all').addEventListener('click', () => copy(textResult()));
$('export-json').addEventListener('click', () => download('json'));
$('export-txt').addEventListener('click', () => download('txt'));

let theme = null;
try { const saved = storage.getItem('axaahub.link.theme'); if (['light', 'dark'].includes(saved)) theme = saved; } catch {}
function applyTheme() {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('theme').textContent = theme === 'light' ? '☀ 浅色' : theme === 'dark' ? '☾ 深色' : '◐ 自动';
  $('theme').setAttribute('aria-label', '当前主题：' + (theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统') + '，点击切换');
}
$('theme').addEventListener('click', () => {
  const order = [null, 'light', 'dark'];
  theme = order[(order.indexOf(theme) + 1) % order.length];
  applyTheme();
  try {
    if (theme) storage.setItem('axaahub.link.theme', theme);
    else window.localStorage.removeItem('axaahub.link.theme');
  } catch {}
});
window.addEventListener('storage', event => {
  if (event.key === 'axaahub.link.recent.v1') { history = createHistory(storage, storageWarning); renderHistory(); }
});
configureBase(); applyTheme(); updateHint(); renderHistory();
initQRCode();
