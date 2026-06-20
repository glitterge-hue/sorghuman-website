// netlify/functions/store-catalog.js
// 店主端商品管理 API（token 验证，不需要 Supabase 账号）

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                 : 'application/json',
};

async function sb(method, table, qs, body) {
  const url = `${SUPA_URL}/rest/v1/${table}${qs ? '?'+qs : ''}`;
  const res = await fetch(url, {
    method: method||'GET',
    headers: {
      'apikey'        : SUPA_KEY,
      'Authorization' : `Bearer ${SUPA_KEY}`,
      'Content-Type'  : 'application/json',
      'Prefer'        : 'return=representation',
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

// token 验证：返回 store 对象或 null
// origin = 请求来源域名（用于校验只能从自家或 sorghuman.com 访问）
async function verifyToken(storeId, token, origin) {
  if (!storeId || !token) return null;
  const rows = await sb('GET', 'stores',
    `store_id=eq.${storeId}&admin_token=eq.${token}` +
    `&select=store_id,name_zh,name_en,domain,markup,delivery_zips,drivers,promo,free_delivery_threshold,delivery_fee`);
  const store = rows[0];
  if (!store) return null;
  // 域名校验：只允许自家域名或 sorghuman.com 访问
  if (origin) {
    const isMaster = origin.includes('sorghuman.com');
    const isOwn    = origin.includes(store.domain);
    if (!isMaster && !isOwn) return null;
  }
  return store;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, storeId, token } = body;

  // ── 验证 token ──────────────────────────────────────────────
  const origin = event.headers.origin || event.headers.referer || '';
  const store = await verifyToken(storeId, token, origin);
  if (!store)
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '无效的访问令牌' }) };

  try {
    // ── 获取该店商品（含商品详情）──────────────────────────────
    if (action === 'GET_STORE_PRODUCTS') {
      const rows = await sb('GET', 'store_products',
        `store_id=eq.${storeId}&active=eq.true` +
        `&select=sku,price,sort_order,products(name_zh,name_en,spec,category,base_price,image_url)` +
        `&order=sort_order.asc`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ store, products: rows }) };
    }

    // ── 获取全部商品库（用于选品）──────────────────────────────
    if (action === 'GET_ALL_PRODUCTS') {
      const rows = await sb('GET', 'products',
        `active=eq.true&select=sku,name_zh,name_en,spec,category,base_price,image_url&order=sort_order.asc`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ products: rows }) };
    }

    // ── 批量保存门店商品选择 ───────────────────────────────────
    if (action === 'SAVE_STORE_PRODUCTS') {
      const { toUpsert, toRemove } = body;
      if (toUpsert?.length) {
        await sb('POST', 'store_products', null,
          toUpsert.map(r => ({ store_id: storeId, sku: r.sku, price: r.price||null, active: true })));
      }
      if (toRemove?.length) {
        await fetch(
          `${SUPA_URL}/rest/v1/store_products?store_id=eq.${storeId}&sku=in.(${toRemove.join(',')})`,
          { method:'DELETE', headers:{ 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}` } }
        );
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 新增商品到总商品库（同时加入本店）─────────────────────
    if (action === 'ADD_NEW_PRODUCT') {
      const { sku, name_zh, name_en, spec, category, base_price, image_url, store_price } = body;
      if (!sku || !name_zh || !base_price)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '缺少必填字段' }) };

      // 写入全局商品库
      await sb('POST', 'products', null, [{
        sku, name_zh, name_en: name_en||'', spec: spec||null,
        category: category||'grocery',
        base_price: parseFloat(base_price),
        image_url: image_url || null,
        common: false, active: true,
      }]);

      // 同时加入本店
      await sb('POST', 'store_products', null, [{
        store_id: storeId, sku,
        price: store_price ? parseFloat(store_price) : null,
        active: true,
      }]);

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 更新单个商品门店价格 ───────────────────────────────────
    if (action === 'UPDATE_PRICE') {
      const { sku, price } = body;
      await fetch(
        `${SUPA_URL}/rest/v1/store_products?store_id=eq.${storeId}&sku=eq.${sku}`,
        {
          method: 'PATCH',
          headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
          body: JSON.stringify({ price: price||null }),
        }
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 保存司机名单 ──────────────────────────────────────────────
    if (action === 'SAVE_DRIVERS') {
      const { drivers } = body;
      if (!Array.isArray(drivers))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '格式错误' }) };
      const valid = drivers.filter(d=>d.phone).slice(0,5); // 最多5个
      await fetch(`${SUPA_URL}/rest/v1/stores?store_id=eq.${storeId}`, {
        method : 'PATCH',
        headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
        body   : JSON.stringify({ drivers: valid }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 保存配送邮编 ──────────────────────────────────────────────
    if (action === 'SAVE_ZIPS') {
      const { zips } = body;
      if (!Array.isArray(zips))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '格式错误' }) };
      await fetch(`${SUPA_URL}/rest/v1/stores?store_id=eq.${storeId}`, {
        method : 'PATCH',
        headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
        body   : JSON.stringify({ delivery_zips: zips }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 保存配送设置（免运费门槛 + 运费）──────────────────────────
    if (action === 'SAVE_DELIVERY') {
      const { free_delivery_threshold, delivery_fee } = body;
      const patch = {};
      if (free_delivery_threshold !== undefined) {
        const v = (free_delivery_threshold === null || free_delivery_threshold === '')
                ? null : Number(free_delivery_threshold);
        if (v !== null && (isNaN(v) || v < 0))
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '免运费门槛无效' }) };
        patch.free_delivery_threshold = v;
      }
      if (delivery_fee !== undefined) {
        const v = (delivery_fee === null || delivery_fee === '')
                ? null : Number(delivery_fee);
        if (v !== null && (isNaN(v) || v < 0))
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '运费无效' }) };
        patch.delivery_fee = v;
      }
      if (!Object.keys(patch).length)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '无可保存字段' }) };
      await fetch(`${SUPA_URL}/rest/v1/stores?store_id=eq.${storeId}`, {
        method : 'PATCH',
        headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
        body   : JSON.stringify(patch),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 按域名查门店 ID（无需认证，公开接口）──────────────────────
    if (action === 'LOOKUP_DOMAIN') {
      const { domain } = body;
      if (!domain) return { statusCode: 400, headers: CORS, body: JSON.stringify({ store_id: null }) };
      const rows = await sb('GET', 'stores', `domain=eq.${domain}&select=store_id&limit=1`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ store_id: rows[0]?.store_id || null }) };
    }

    // ── 保存门店活动配置 ──────────────────────────────────────────
    if (action === 'SAVE_PROMO') {
      const { promo } = body;
      await fetch(`${SUPA_URL}/rest/v1/stores?store_id=eq.${storeId}`, {
        method : 'PATCH',
        headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
        body   : JSON.stringify({ promo }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 切换爆品状态 ──────────────────────────────────────────────
    if (action === 'TOGGLE_FEATURED') {
      const { sku, featured } = body;
      await fetch(
        `${SUPA_URL}/rest/v1/store_products?store_id=eq.${storeId}&sku=eq.${sku}`,
        {
          method : 'PATCH',
          headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json' },
          body   : JSON.stringify({ featured: !!featured }),
        }
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (e) {
    console.error('store-catalog error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
