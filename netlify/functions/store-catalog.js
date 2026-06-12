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
async function verifyToken(storeId, token) {
  if (!storeId || !token) return null;
  const rows = await sb('GET', 'stores',
    `store_id=eq.${storeId}&admin_token=eq.${token}&select=store_id,name_zh,name_en,domain,markup`);
  return rows[0] || null;
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
  const store = await verifyToken(storeId, token);
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

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (e) {
    console.error('store-catalog error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
