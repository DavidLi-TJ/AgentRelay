'use strict';
// 大会话解析缓存：>1500 条的会话解析结果驻留（LRU 2 个），避免"显示更多"重复解析 700MB+ 文件
const cache = new Map(); // key → { msx, at }
const MAX = 2;

const TTL = 5 * 60 * 1000;
function get(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL) { cache.delete(key); return null; }
  hit.at = Date.now();
  return hit.msx;
}

function put(key, msx) {
  if (!msx || !Array.isArray(msx.entries) || msx.entries.length < 1500) return;
  cache.set(key, { msx, at: Date.now() });
  while (cache.size > MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    cache.delete(oldest[0]);
  }
}

module.exports = { get, put };
