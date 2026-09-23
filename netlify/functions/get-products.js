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

// 官网采用与 ERP 一致的最新一级分类。历史细分类仅用于兼容旧数据，
// 不再直接显示给顾客。
const CATEGORY_LABELS = {
  food    : 'Food · 食品',
  non_food: 'Non-food · 非食品',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };

  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/products?active=eq.true&showcase=eq.true` +
      `&select=sku,name_zh,name_en,spec,category,showcase_category,image_url,description,sort_order,` +
      `product_line,subscription_enabled,subscription_interval,subscription_interval_count,subscription_price,base_price` +
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
      headers: { ...CORS, 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      body: JSON.stringify({ products, categories: CATEGORY_LABELS }),
    };
  } catch (e) {
    console.error('get-products error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message, products: [] }) };
  }
};
