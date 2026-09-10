// netlify/functions/product-share.js
// 「可转发链接」落地页 —— 为单个商品输出预览卡所需的 <head> 元数据
// (og:title / og:image / og:description)，供微信 / 短信 / 社交平台抓取，
// 真人访问则自动跳转到 /shop/?p=SKU 打开商品详情抽屉。
//
// 访问方式（配合 _redirects）：  https://门店域名/p/SKU
// 或直接：                       /.netlify/functions/product-share?p=SKU[&store=xxx]

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

// HTML 转义，防止商品名/描述里的引号或尖括号破坏页面
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 把相对图片路径补成绝对 https（微信要求 og:image 必须是绝对地址）
function absUrl(u, origin) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return origin.replace(/\/$/, '') + '/' + String(u).replace(/^\//, '');
}

exports.handler = async (event) => {
  const params  = event.queryStringParameters || {};
  const sku     = (params.p || params.sku || '').trim();
  const host    = (event.headers.host || 'sorghuman.com').replace(/^www\./, '');
  const proto   = (event.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const origin  = `${proto}://${host}`;
  // 门店内商品页在 /shop/ 下；如你的门店结构不同，改这一行即可
  const shopUrl = `${origin}/shop/?p=${encodeURIComponent(sku)}`;

  // 兜底页面：数据没取到时，直接把真人送进商店，不至于白屏
  const fallback = (extraHead = '') => ({
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    body:
`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${esc(shopUrl)}">${extraHead}
</head><body><script>location.replace(${JSON.stringify(shopUrl)});</script>
<a href="${esc(shopUrl)}">前往商品页 Go to product</a></body></html>`,
  });

  if (!sku || !SUPA_URL || !SUPA_KEY) return fallback();

  try {
    // 定位门店（按域名，与 get-catalog 一致），用于取本店价格
    let storeId = params.store;
    if (!storeId) {
      const rows = await sb('stores', `domain=eq.${host}&select=store_id,name_zh,name_en&limit=1`);
      if (rows.length) storeId = rows[0].store_id;
    }
    if (!storeId) storeId = 'default';

    const storeRows = await sb('stores', `store_id=eq.${storeId}&select=name_zh,name_en,markup&limit=1`);
    const store  = storeRows[0] || {};
    const markup = parseFloat(store.markup) || 1.0;

    // 取该店该商品（含详情字段）
    const rows = await sb(
      'store_products',
      `store_id=eq.${storeId}&sku=eq.${encodeURIComponent(sku)}&active=eq.true` +
      `&select=price,products(name_zh,name_en,spec,base_price,image_url,description_zh,description_en,gallery)` +
      `&limit=1`
    );
    const row = rows[0];
    const p   = row && row.products;
    if (!p) return fallback();

    const price = row.price != null
      ? parseFloat(row.price)
      : parseFloat((p.base_price * markup).toFixed(2));

    const title = [p.name_zh, p.name_en].filter(Boolean).join(' · ');
    const desc  = (p.description_zh || p.description_en || p.spec || '')
      .replace(/\s+/g, ' ').slice(0, 110)
      + (price ? `　¥/$ ${price.toFixed(2)}` : '');
    const img   = absUrl(p.image_url || (Array.isArray(p.gallery) && p.gallery[0]) || '', origin);
    const shop  = `${store.name_zh || ''} ${store.name_en || ''}`.trim();
    const fullTitle = title + (shop ? `｜${shop}` : '');

    const html =
`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(shopUrl)}">

<!-- Open Graph：微信 / Facebook / 多数社交平台读取 -->
<meta property="og:type"        content="product">
<meta property="og:title"       content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url"         content="${esc(origin)}/p/${esc(sku)}">
${img ? `<meta property="og:image" content="${esc(img)}">` : ''}
${img ? `<meta property="og:image:width" content="800"><meta property="og:image:height" content="800">` : ''}
<meta property="og:site_name"   content="${esc(shop || host)}">

<!-- Twitter / X 卡片 -->
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${img ? `<meta name="twitter:image" content="${esc(img)}">` : ''}

<!-- 真人访问：立刻跳转到商店抽屉；抓取爬虫不执行跳转，只读上面的标签 -->
<meta http-equiv="refresh" content="0; url=${esc(shopUrl)}">
<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;margin:0;padding:40px 20px;text-align:center;color:#333}
img{max-width:280px;border-radius:12px}h1{font-size:18px;margin:16px 0 4px}a{color:#2A6B3A}</style>
</head>
<body>
${img ? `<img src="${esc(img)}" alt="${esc(title)}">` : ''}
<h1>${esc(title)}</h1>
<p>正在前往商品页… <a href="${esc(shopUrl)}">立即打开 Open</a></p>
<script>location.replace(${JSON.stringify(shopUrl)});</script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // 允许爬虫重复抓取拿到最新卡片，又不至于每次都打 DB
        'Cache-Control': 'public, max-age=600',
      },
      body: html,
    };
  } catch (e) {
    console.error('product-share error:', e.message);
    return fallback();
  }
};
