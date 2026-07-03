// netlify/functions/get-products.js
// 官网 /products 展示页的数据源：读 products 表中「上架且勾选官网展示」的产品。
// 公开只读，无需认证。加产品 = 往 products 表加一行并把 showcase 设为 true。
//
// 环境变量（已有）：SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

// 分类中英文标题（可按需增删）
const CATEGORY_LABELS = {
  buns      : '包子系列 Steamed Buns',
  frozen    : '冷冻食品 Frozen',
  dumplings : '水饺 Dumplings',
  beverages : '饮品 Beverages',
  rice      : '优质大米 Premium Rice',
  grocery   : '百货 Grocery',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };

  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/products?active=eq.true&showcase=eq.true` +
      `&select=sku,name_zh,name_en,spec,category,showcase_category,image_url,description,sort_order` +
      `&order=sort_order.asc`,
      { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase products: ${t}`);
    }
    const products = await res.json();

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ products, categories: CATEGORY_LABELS }),
    };
  } catch (e) {
    console.error('get-products error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message, products: [] }) };
  }
};
