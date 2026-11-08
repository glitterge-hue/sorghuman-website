// netlify/functions/store-orders.js
// 门店订单管理 API —— 每家店只能看/管自己的订单（token + 域名双重校验）
// 订单全部读自 Supabase orders 表（顾客信息已由 stripe-webhook 在付款时写入）。
//
// 环境变量（你项目里已有）：SUPABASE_URL, SUPABASE_SERVICE_KEY

const { q } = require('./_lib/safe');
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                : 'application/json',
};

// ── Supabase REST 辅助 ──────────────────────────────────────────────
async function sb(method, table, qs, body) {
  const url = `${SUPA_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    method : method || 'GET',
    headers: {
      'apikey'       : SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type' : 'application/json',
      'Prefer'       : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${table} ${method}: ${t}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ── token + 域名校验：返回 store 对象或 null ─────────────────────────
// 与 store-catalog.js 同一套逻辑：token 必须对应该 store_id，
// 且请求只能来自该店自家域名或 sorghuman.com（总店）。
const { verifyToken: checkToken } = require('./_lib/auth');

// token 校验（SHA-256 哈希比对 + 失败限速，见 _lib/auth.js）。
// origin 请求头可被脚本伪造，下面的域名检查只是浏览器场景的额外一层，不是认证。
async function verifyToken(storeId, token, origin, event) {
  const r = await checkToken({
    table: 'stores', idCol: 'store_id', id: storeId, token, event, scope: 'store-orders',
    select: 'store_id,name_zh,name_en,domain',
  });
  if (!r.ok) return r.locked ? { __locked: true } : null;
  const store = r.row;
  if (!origin) return null;
  let host;
  try { host = new URL(origin).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
  const own = String(store.domain || '').toLowerCase().replace(/^www\./, '');
  const isMaster = host === 'sorghuman.com' || host.endsWith('.sorghuman.com');
  const isOwn = own && (host === own || host.endsWith('.' + own));
  if (!isMaster && !isOwn) return null;
  return store;
}

// ── 主入口 ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const origin = event.headers.origin || event.headers.referer || '';

  try {
    const payload = JSON.parse(event.body || '{}');
    const { action, storeId, token } = payload;

    const store = await verifyToken(storeId, token, origin, event);
    if (store && store.__locked)
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '尝试次数过多，请稍后再试 / Too many attempts' }) };
    if (!store)
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '令牌无效或无权访问 / Invalid token' }) };

    // ── 列出本店订单（默认只看已付款及之后的，按时间倒序）────────────
    if (action === 'GET_ORDERS') {
      // select=* 兼容表里任意已有字段，避免列名不一致导致整条查询报错
      const orders = await sb(
        'GET', 'orders',
        `store_id=eq.${q(storeId)}` +
        `&status=neq.pending` +                 // 隐藏未付款的废弃单
        `&order=created_at.desc&limit=100&select=*`
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, orders }) };
    }

    // ── 更新订单状态 ──────────────────────────────────────────────
    if (action === 'UPDATE_ORDER_STATUS') {
      const { orderId, status } = payload;
      const allowed = ['paid', 'preparing', 'delivering', 'completed', 'cancelled'];
      if (!orderId || !allowed.includes(status))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '参数无效 / Bad request' }) };

      // 关键安全点：WHERE 同时锁 id 和 store_id —— 店主改不了别家店的单
      const updated = await sb(
        'PATCH', 'orders',
        `id=eq.${q(orderId)}&store_id=eq.${q(storeId)}`,
        { status }
      );
      if (!updated.length)
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '订单不存在 / Not found' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, order: updated[0] }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '未知操作 / Unknown action' }) };

  } catch (e) {
    console.error('store-orders error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
