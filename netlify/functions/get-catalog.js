// netlify/functions/get-catalog.js
// 从 store_products 表读取每家店的商品（新架构）

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                 : 'application/json',
};

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };

  let storeId = (event.queryStringParameters || {}).store;

  try {
    // 按域名查门店
    if (!storeId) {
      const host = (event.headers.host || '').replace(/^www\./, '');
      const rows = await sb('stores', `domain=eq.${host}&select=store_id&limit=1`);
      if (rows.length) storeId = rows[0].store_id;
    }
    if (!storeId) storeId = 'default';

    // 并行读门店配置 + 该店商品（含商品详情）
    const [storeRows, spRows] = await Promise.all([
      sb('stores', `store_id=eq.${storeId}&select=*&limit=1`),
      sb('store_products',
        `store_id=eq.${storeId}&active=eq.true` +
        `&select=sku,price,sort_order,products(name_zh,name_en,spec,category,base_price,image_url,sort_order)` +
        `&order=sort_order.asc`),
    ]);

    if (!storeRows.length)
      return { statusCode: 404, headers: CORS,
               body: JSON.stringify({ error: `Store not found: ${storeId}` }) };

    const store  = storeRows[0];
    const markup = parseFloat(store.markup) || 1.0;

    // 合并商品信息和门店价格
    const storeProducts = spRows
      .filter(sp => sp.products)
      .map(sp => ({
        sku       : sp.sku,
        name_zh   : sp.products.name_zh,
        name_en   : sp.products.name_en,
        spec      : sp.products.spec,
        category  : sp.products.category,
        base_price: sp.price != null
          ? parseFloat(sp.price)
          : parseFloat((sp.products.base_price * markup).toFixed(2)),
        common    : true,
        image_url : sp.products.image_url,
      }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({
        store,
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
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
