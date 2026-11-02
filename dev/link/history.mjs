export const HISTORY_KEY = 'axaahub.link.recent.v1';
const LIMIT = 20;
const MAX_BYTES = 128 * 1024;

function validItem(item) {
  return item && typeof item.originalUrl === 'string' && item.originalUrl.length <= 16384 &&
    /^https?:\/\//i.test(item.originalUrl) &&
    ['quick', 'browser'].includes(item.mode) && ['desktop', 'mobile'].includes(item.profile) &&
    typeof item.checkedAt === 'string' && Number.isFinite(Date.parse(item.checkedAt)) &&
    (!item.finalUrl || typeof item.finalUrl === 'string' && item.finalUrl.length <= 16384) &&
    typeof item.reason === 'string' && item.reason.length <= 60 &&
    Number.isInteger(item.hopCount) && item.hopCount >= 0 && item.hopCount <= 20;
}
function identity(item) { return JSON.stringify([item.originalUrl, item.mode, item.profile]); }

export function createHistory(storage, warn = () => {}) {
  let state = { version: 1, enabled: true, items: [] };
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean' ||
          !Array.isArray(parsed.items) || !parsed.items.every(validItem)) throw new Error('bad history');
      const keys = new Set();
      state = { version: 1, enabled: parsed.enabled,
        items: parsed.items.filter(item => {
          const key = identity(item);
          if (keys.has(key)) return false;
          keys.add(key); return true;
        }).slice(0, LIMIT) };
    }
  } catch {
    warn('无法读取最近查询，已使用本次会话记录。链接检查仍可正常使用。');
  }
  function persist() {
    let raw = JSON.stringify(state);
    while (new TextEncoder().encode(raw).length > MAX_BYTES && state.items.length) {
      state.items.pop();
      raw = JSON.stringify(state);
    }
    try { storage.setItem(HISTORY_KEY, raw); } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        while (state.items.length) {
          state.items.pop();
          try {
            storage.setItem(HISTORY_KEY, JSON.stringify(state));
            warn('浏览器存储空间不足，已移除部分较早记录。'); return;
          } catch {}
        }
      }
      warn('浏览器无法保存最近查询，当前页面仍可检查链接；关闭页面后本次记录可能丢失。');
    }
  }
  return {
    get enabled() { return state.enabled; },
    get items() { return state.items.map(item => ({ ...item })); },
    setEnabled(value) { state.enabled = !!value; persist(); },
    add(input, result) {
      if (!state.enabled) return;
      const item = {
        originalUrl: input.url, mode: input.mode, profile: input.profile,
        checkedAt: result.startedAt || new Date().toISOString(),
        finalUrl: result.final?.url || '',
        reason: result.termination?.reason || 'network_error',
        hopCount: Math.min(20, result.hops?.length || 0)
      };
      if (!validItem(item)) return;
      state.items = [item, ...state.items.filter(old => identity(old) !== identity(item))].slice(0, LIMIT);
      persist();
    },
    remove(item) { state.items = state.items.filter(old => identity(old) !== identity(item)); persist(); },
    clear() {
      state.items = [];
      // Keep this tool's recording preference; never clear unrelated origin storage.
      persist();
    }
  };
}
