// netlify/functions/create-checkout.js
// 从 Supabase 验价 → 创建 Stripe 收银 → 写订单到数据库

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                 : 'application/json',
};

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

async function sbInsert(table, data) {
  await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method : 'POST',
    headers: {
      'apikey'       : SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type' : 'application/json',
      'Prefer'       : 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { cart, origin } = body;
  const storeId = body.storeId || 'default';   // 没传 storeId 时用 default（兼容 local.html）
  if (!Array.isArray(cart) || cart.length === 0)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing cart' }) };

  try {
    // ── 从 Supabase 读门店和商品（服务器端，不信任前端价格）──
    const skus = cart.map(i => i.sku).join(',');
    const [storeRows, products, prices] = await Promise.all([
      sb('stores',       `store_id=eq.${storeId}&select=*&limit=1`),
      sb('products',     `sku=in.(${skus})&active=eq.true&select=*`),
      sb('store_prices', `store_id=eq.${storeId}&sku=in.(${skus})&select=sku,price`),
    ]);

    if (!storeRows.length)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown store' }) };

    const store   = storeRows[0];
    const markup  = parseFloat(store.markup) || 1.0;
    const priceMap = {};
    prices.forEach(p => { priceMap[p.sku] = parseFloat(p.price); });
    const prodMap  = {};
    products.forEach(p => { prodMap[p.sku] = p; });

    // ── 服务器端算价 ──────────────────────────────────────────
    const lineItems = [];
    for (const item of cart) {
      const p = prodMap[item.sku];
      if (!p) continue;
      const price = priceMap[p.sku] != null
        ? priceMap[p.sku]
        : parseFloat((p.base_price * markup).toFixed(2));
      lineItems.push({
        price_data: {
          currency    : 'usd',
          product_data: { name: p.name_zh + '  ' + p.name_en },
          unit_amount : Math.round(price * 100),
        },
        quantity: Math.max(1, Math.floor(Number(item.qty))),
      });
    }

    if (lineItems.length === 0)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No valid items' }) };

    // ── 配送费 ────────────────────────────────────────────────
    const subtotalCents  = lineItems.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    const thresholdCents = Math.round((store.free_delivery_threshold ?? 30) * 100);
    const feeCents       = Math.round((store.delivery_fee ?? 5) * 100);
    const deliveryCents  = subtotalCents < thresholdCents ? feeCents : 0;

    if (deliveryCents > 0) {
      lineItems.push({
        price_data: {
          currency    : 'usd',
          product_data: { name: '配送费 Delivery Fee' },
          unit_amount : deliveryCents,
        },
        quantity: 1,
      });
    }

    // ── 创建 Stripe 收银会话 ───────────────────────────────────
    const base       = (origin || `https://${store.domain}`).replace(/\/$/, '');
    const successUrl = `${base}/shop/?order=success`;
    const cancelUrl  = `${base}/shop/`;

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

    // ── 写订单到 Supabase ─────────────────────────────────────
    await sbInsert('orders', {
      store_id         : storeId,
      stripe_session_id: session.id,
      items            : cart,
      subtotal         : subtotalCents  / 100,
      delivery_fee     : deliveryCents  / 100,
      total            : (subtotalCents + deliveryCents) / 100,
      status           : 'pending',
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: session.url }) };

  } catch (e) {
    console.error('checkout error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
