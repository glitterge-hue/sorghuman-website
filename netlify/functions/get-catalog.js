// netlify/functions/get-catalog.js
// 按门店返回商品目录 + 门店配置（价格已合并）
// 前端调用: /.netlify/functions/get-catalog?store=fareast

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                 : 'application/json',
};

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      'apikey'       : SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    }
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };

  // 确定门店 ID：优先用 ?store= 参数，其次按域名查表
  let storeId = (event.queryStringParameters || {}).store;

  try {
    if (!storeId) {
      const host = (event.headers.host || '').replace(/^www\./, '');
      const rows = await sb('stores', `domain=eq.${host}&select=store_id&limit=1`);
      if (rows.length) storeId = rows[0].store_id;
    }
    if (!storeId) storeId = 'default';

    // 并行查询四张表
    const [products, storeRows, prices, drops] = await Promise.all([
      sb('products',     'active=eq.true&select=*&order=sort_order.asc'),
      sb('stores',       `store_id=eq.${storeId}&select=*&limit=1`),
      sb('store_prices', `store_id=eq.${storeId}&select=sku,price`),
      sb('store_drops',  `store_id=eq.${storeId}&select=sku`),
    ]);

    if (!storeRows.length)
      return { statusCode: 404, headers: CORS,
               body: JSON.stringify({ error: `Store not found: ${storeId}` }) };

    const store   = storeRows[0];
    const markup  = parseFloat(store.markup) || 1.0;
    const priceMap = {};
    prices.forEach(p => { priceMap[p.sku] = parseFloat(p.price); });
    const dropSet  = new Set(drops.map(d => d.sku));

    // 合并门店价格
    const storeProducts = products
      .filter(p => !dropSet.has(p.sku))
      .map(p => ({
        sku       : p.sku,
        name_zh   : p.name_zh,
        name_en   : p.name_en,
        spec      : p.spec,
        category  : p.category,
        base_price: priceMap[p.sku] != null
                      ? priceMap[p.sku]
                      : parseFloat((p.base_price * markup).toFixed(2)),
        common    : p.common,
        image_url : p.image_url,
      }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
      body: JSON.stringify({
        store   : store,
        products: storeProducts,
        categories: {
          condiments: '米面粮油和调味品 Pantry & Condiments',
          snacks    : '零食和饮料 Snacks & Beverages',
          frozen    : '冷冻食品 Frozen Foods',
          fresh     : '生鲜 Fresh Produce',
          grocery   : '百货 Grocery',
        }
      })
    };

  } catch (e) {
    console.error('get-catalog error:', e.message);
    return { statusCode: 500, headers: CORS,
             body: JSON.stringify({ error: e.message }) };
  }
};
