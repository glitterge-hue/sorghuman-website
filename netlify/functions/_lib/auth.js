// netlify/functions/_lib/auth.js
// 门店 / 供货商 token 校验：哈希比对 + 失败限速。
//
// 对比旧写法（`...&admin_token=eq.${token}` 直接让数据库比对明文）：
//   1. token 不再拼进查询串（同时消除注入面）；
//   2. 优先比对 admin_token_hash（SHA-256），没有哈希列/值时回退明文，保证迁移前后都能用；
//   3. 比对用 timingSafeEqual；
//   4. 同一 IP 15 分钟内失败 10 次后返回 locked（需要先跑 SQL 建 admin_auth_failures 表，
//      表不存在时只记日志、不限速——宁可放行也不要因为基础设施问题把店主锁在门外）。
//
// 注意：origin / referer 请求头可以被脚本随意伪造，不是认证手段。真正的认证只有 token；
//       各函数里保留的域名检查只是浏览器场景下的额外一层。

const crypto = require('crypto');
const { q } = require('./safe');

const SUPA_URL = () => process.env.SUPABASE_URL;
const SUPA_KEY = () => process.env.SUPABASE_SERVICE_KEY;

const MAX_FAILS  = 10;
const WINDOW_MIN = 15;

function headers(extra) {
  return Object.assign({
    apikey: SUPA_KEY(), Authorization: `Bearer ${SUPA_KEY()}`, 'Content-Type': 'application/json',
  }, extra || {});
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip']
    || String(h['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function tooManyFailures(scope, ip) {
  try {
    const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();
    const res = await fetch(
      `${SUPA_URL()}/rest/v1/admin_auth_failures?scope=eq.${q(scope)}&ip=eq.${q(ip)}` +
      `&created_at=gte.${q(since)}&select=id&limit=${MAX_FAILS}`,
      { headers: headers() });
    if (!res.ok) return false;                 // 表还没建 → 不限速
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= MAX_FAILS;
  } catch (e) {
    console.error('auth rate-limit check failed:', e.message);
    return false;
  }
}

async function recordFailure(scope, ip, key) {
  try {
    await fetch(`${SUPA_URL()}/rest/v1/admin_auth_failures`, {
      method: 'POST', headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ scope, ip, key: String(key || '').slice(0, 80) }),
    });
    // 顺手清理一天前的记录（约 5% 的失败请求触发一次）
    if (Math.random() < 0.05) {
      const old = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      await fetch(`${SUPA_URL()}/rest/v1/admin_auth_failures?created_at=lt.${q(old)}`,
        { method: 'DELETE', headers: headers() });
    }
  } catch (e) {
    console.error('auth failure log failed:', e.message);
  }
}

// 读取一行并带上 token 字段。先尝试带 admin_token_hash；列不存在（迁移前）则回退。
async function fetchRow(table, idCol, id, select, extraFilter) {
  const base = `${SUPA_URL()}/rest/v1/${table}?${idCol}=eq.${q(id)}${extraFilter || ''}&limit=1&select=`;
  const sel  = select || '*';
  let res = await fetch(base + encodeURIComponent(sel + ',admin_token,admin_token_hash'), { headers: headers() });
  if (!res.ok) {
    res = await fetch(base + encodeURIComponent(sel + ',admin_token'), { headers: headers() });
    if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * @returns {Promise<{ok:true,row:object}|{ok:false,locked:boolean}>}
 * opts: { table, idCol, id, token, select, event, scope, extraFilter }
 *   extraFilter 形如 "&status=eq.approved&active=eq.true"（调用方自己用 q() 编码）
 */
async function verifyToken(opts) {
  const { table, idCol, id, token, select, event, scope, extraFilter } = opts;
  if (!id || !token || typeof token !== 'string' || token.length > 200)
    return { ok: false, locked: false };

  const ip = clientIp(event);
  if (await tooManyFailures(scope, ip)) return { ok: false, locked: true };

  const row = await fetchRow(table, idCol, id, select, extraFilter);
  let good = false;
  if (row) {
    if (row.admin_token_hash) good = safeEqual(row.admin_token_hash, sha256hex(token));
    else if (row.admin_token)  good = safeEqual(row.admin_token, token);
  }
  if (!good) {
    await recordFailure(scope, ip, id);
    return { ok: false, locked: false };
  }
  const { admin_token, admin_token_hash, ...safe } = row;   // 绝不把 token 带回调用方
  return { ok: true, row: safe };
}

module.exports = { verifyToken, sha256hex, clientIp };
