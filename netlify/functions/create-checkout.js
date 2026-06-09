// netlify/functions/create-checkout.js
// 环境变量: STRIPE_SECRET_KEY = sk_test_... 或 sk_live_...

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                 : 'application/json',
};

const BASE = 'https://sorghuman.com';   // 从 CDN 读商品库和门店配置

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── 解析请求 ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { storeId, cart, origin } = body;
  if (!storeId || !Array.isArray(cart) || cart.length === 0)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing storeId or cart' }) };

  // ── 从 CDN 读商品库 & 门店配置 ──────────────────────────────
  let catalog, store;
  try {
    const [cr, sr] = await Promise.all([
      fetch(BASE + '/products.json'),
      fetch(BASE + '/stores/' + storeId + '.json'),
    ]);
    if (!cr.ok) throw new Error('products.json not found');
    if (!sr.ok) throw new Error('Store not found: ' + storeId);
    [catalog, store] = await Promise.all([cr.json(), sr.json()]);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  // ── 服务器端重新算价(不信任前端价格) ──────────────────────────
  const map = {};
  catalog.products.forEach(p => { map[p.sku] = p; });

  const lineItems = [];
  for (const item of cart) {
    const p = map[item.sku];
    if (!p) continue;
    let price = p.base_price * (store.markup || 1);
    if (store.prices?.[item.sku] != null) price = Number(store.prices[item.sku]);
    lineItems.push({
      price_data: {
        currency    : (catalog.currency || 'usd').toLowerCase(),
        product_data: { name: p.name_zh + '  ' + p.name_en },
        unit_amount : Math.round(price * 100),
      },
      quantity: Math.max(1, Math.floor(Number(item.qty))),
    });
  }

  if (lineItems.length === 0)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No valid items in cart' }) };

  // ── 配送费 ───────────────────────────────────────────────────
  const subtotalCents  = lineItems.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
  const thresholdCents = Math.round((store.free_delivery_threshold ?? 30) * 100);
  const feeCents       = Math.round((store.delivery_fee ?? 5) * 100);
  if (subtotalCents < thresholdCents) {
    lineItems.push({
      price_data: {
        currency    : (catalog.currency || 'usd').toLowerCase(),
        product_data: { name: '配送费 Delivery Fee' },
        unit_amount : feeCents,
      },
      quantity: 1,
    });
  }

  // ── Stripe Checkout Session ──────────────────────────────────
  const base       = (origin || 'https://' + store.domain).replace(/\/$/, '');
  const successUrl = base + '/shop/?order=success';
  const cancelUrl  = base + '/shop/';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types        : ['card'],
      line_items                  : lineItems,
      mode                        : 'payment',
      success_url                 : successUrl,
      cancel_url                  : cancelUrl,
      metadata                    : { store_id: storeId },
      shipping_address_collection : { allowed_countries: ['US'] },
      phone_number_collection     : { enabled: true },
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };
  } catch (e) {
    console.error('Stripe error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
