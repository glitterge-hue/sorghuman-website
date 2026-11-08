// netlify/functions/create-checkout.js
// 从 Supabase 验价 → 创建 Stripe 收银 → 写订单到数据库
//
// 加固点（相对旧版）：
//  1. 订单落库失败时，立即让刚建的 Stripe 会话过期，顾客付不了款——杜绝"钱收了、订单没有"。
//     购物车同时写进会话 metadata，webhook 在订单行缺失时能据此补建。
//  2. 所有进入 PostgREST 查询串的值统一经 q()/inList() 编码，请求体先做类型/长度校验。
//  3. 可选的 Stripe Tax：环境变量 STRIPE_TAX_ENABLED=true 才启用（见文件末尾说明）。

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { q, inList } = require('./_lib/safe');
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                 : 'application/json',
};

// ── 税务（Stripe Tax）──────────────────────────────────────────
// 默认关闭：没在 Stripe 后台开通 Stripe Tax 就打开开关，结账会直接报错。
const TAX_ENABLED = process.env.STRIPE_TAX_ENABLED === 'true';
// 配送费的 Stripe 税码（运费）
const SHIPPING_TAX_CODE = process.env.STRIPE_TAX_CODE_SHIPPING || 'txcd_92010001';
// 非食品（product_line='non_food'，如餐盒、包装膜、胶带）默认按"一般有形商品"征税
const NONFOOD_TAX_CODE  = process.env.STRIPE_TAX_CODE_NONFOOD  || 'txcd_99999999';
// 食品：不设默认。留空 = 不传 tax_code，Stripe 使用你在后台 Tax 设置里的"默认商品税码"
//（建议在后台把默认税码设成适合食品杂货的类别；也可用环境变量或 products.tax_code 逐品覆盖）
const FOOD_TAX_CODE     = process.env.STRIPE_TAX_CODE_FOOD || '';

function taxCodeFor(p) {
  if (p.tax_code) return String(p.tax_code);                 // 可选列：逐品覆盖
  if (p.product_line === 'non_food') return NONFOOD_TAX_CODE;
  return FOOD_TAX_CODE || undefined;
}

// ── 输入限制 ───────────────────────────────────────────────────
const MAX_CART_LINES = 100;
const MAX_QTY        = 999;

function bad(status, msg) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ error: msg }) };
}

// 清洗购物车：只保留 {sku, qty, mode}，类型/长度不合法的行直接丢弃
function cleanCart(cart) {
  const out = [];
  for (const it of cart.slice(0, MAX_CART_LINES)) {
    if (!it || typeof it !== 'object') continue;
    const sku = typeof it.sku === 'string' ? it.sku.trim() : '';
    if (!sku || sku.length > 64) continue;
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) continue;
    out.push({ sku, qty: Math.min(qty, MAX_QTY), mode: it.mode === 'case' ? 'case' : 'unit' });
  }
  return out;
}

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

// 返回 true/false，不再静默吞掉失败
async function sbInsert(table, data) {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method : 'POST',
      headers: {
        'apikey'       : SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type' : 'application/json',
        'Prefer'       : 'return=minimal',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) console.error(`order insert failed ${res.status}:`, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) {
    console.error('order insert error:', e.message);
    return false;
  }
}

// 把购物车压成 metadata（每个值 ≤500 字符，最多 10 段），webhook 补建订单时读取
function cartToMetadata(cart) {
  const json = JSON.stringify(cart.map(i => [i.sku, i.qty, i.mode === 'case' ? 'c' : 'u']));
  const meta = {};
  const CHUNK = 480;
  if (json.length > CHUNK * 10) { meta.cart_truncated = '1'; return meta; }
  for (let i = 0, n = 0; i < json.length; i += CHUNK, n++) meta['cart_' + n] = json.slice(i, i + CHUNK);
  return meta;
}

// 启用 Stripe Tax 时给价格加 tax_behavior（标价为税前）和 tax_code
function withTax(priceData, product) {
  if (!TAX_ENABLED) return priceData;
  priceData.tax_behavior = 'exclusive';
  const code = taxCodeFor(product);
  if (code) priceData.product_data.tax_code = code;
  return priceData;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return bad(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object') return bad(400, 'Invalid JSON');

  const { origin } = body;
  if (body.storeId !== undefined && body.storeId !== null &&
      (typeof body.storeId !== 'string' || body.storeId.length > 64))
    return bad(400, 'Invalid store');
  const storeId = body.storeId || 'default';
  const cart = Array.isArray(body.cart) ? cleanCart(body.cart) : [];
  // 'one_time'（默认，现金/单次付款）或 'subscription'（按月自动续订）
  const purchaseType = body.purchaseType === 'subscription' ? 'subscription' : 'one_time';

  if (cart.length === 0)
    return bad(400, 'Missing cart');

  try {
    // ── 从 Supabase 读门店和商品（服务器端，不信任前端价格）──
    const skus = [...new Set(cart.map(i => i.sku))];
    const [storeRows, products, prices] = await Promise.all([
      sb('stores',       `store_id=eq.${q(storeId)}&select=*&limit=1`),
      sb('products',     `sku=in.${inList(skus)}&active=eq.true&select=*`),
      sb('store_prices', `store_id=eq.${q(storeId)}&sku=in.${inList(skus)}&select=sku,price`),
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
    // 订阅模式：只接受开启了 subscription_enabled 的商品，单价用
    // subscription_price（若未设置，按一次性价打 92 折作为订阅优惠价）。
    //
    // 单件 / 整箱（mode: 'unit' 默认 | 'case'）：只有 units_per_case > 1 的商品
    // 才能选整箱；整箱单价 = 单件单价 × units_per_case × 0.95（统一95折，
    // 对所有门店一视同仁，不受门店 markup/单独定价影响折扣比例本身——
    // 门店的 markup/store_prices 只影响"单件单价"这个基数，95折统一叠加在其上）。
    const lineItems = [];
    const charged   = [];   // 实际计费的购物车行（排除被跳过的）
    const skippedNonSubscribable = [];
    const skippedNoCase = [];
    for (const item of cart) {
      const p = prodMap[item.sku];
      if (!p) continue;
      const mode = item.mode === 'case' ? 'case' : 'unit';
      const unitsPerCase = parseInt(p.units_per_case, 10) || 0;
      if (mode === 'case' && unitsPerCase <= 1) { skippedNoCase.push(p.sku); continue; }

      const onceOffUnitPrice = priceMap[p.sku] != null
        ? priceMap[p.sku]
        : parseFloat((p.base_price * markup).toFixed(2));
      const onceOffPrice = mode === 'case'
        ? parseFloat((onceOffUnitPrice * unitsPerCase * 0.95).toFixed(2))
        : onceOffUnitPrice;
      const caseSuffix = mode === 'case' ? `（整箱 Case of ${unitsPerCase}）` : '';

      if (purchaseType === 'subscription') {
        if (!p.subscription_enabled) { skippedNonSubscribable.push(p.sku); continue; }
        const subUnitPrice = p.subscription_price != null
          ? parseFloat(p.subscription_price)
          : parseFloat((onceOffUnitPrice * 0.92).toFixed(2));
        const subPrice = mode === 'case'
          ? parseFloat((subUnitPrice * unitsPerCase * 0.95).toFixed(2))
          : subUnitPrice;
        charged.push(item);
        lineItems.push({
          price_data: withTax({
            currency    : 'usd',
            product_data: { name: p.name_zh + '  ' + p.name_en + caseSuffix + '（订阅 Subscription）' },
            unit_amount : Math.round(subPrice * 100),
            recurring   : {
              interval      : p.subscription_interval || 'month',
              interval_count: p.subscription_interval_count || 1,
            },
          }, p),
          quantity: item.qty,
        });
      } else {
        charged.push(item);
        lineItems.push({
          price_data: withTax({
            currency    : 'usd',
            product_data: { name: p.name_zh + '  ' + p.name_en + caseSuffix },
            unit_amount : Math.round(onceOffPrice * 100),
          }, p),
          quantity: item.qty,
        });
      }
    }

    if (lineItems.length === 0)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({
        error: purchaseType === 'subscription'
          ? 'No subscribable items in cart'
          : (skippedNoCase.length ? 'Selected items do not support whole-case purchase' : 'No valid items'),
      }) };

    // ── 配送费（仅一次性购买计算；订阅商品按合同/批量方式另行安排配送，不在结账时计费）──
    const subtotalCents = lineItems.reduce(
      (s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    let deliveryCents = 0;
    let shippingOptions;
    if (purchaseType !== 'subscription') {
      const thresholdCents = Math.round((store.free_delivery_threshold ?? 30) * 100);
      const feeCents       = Math.round((store.delivery_fee ?? 5) * 100);
      deliveryCents        = subtotalCents < thresholdCents ? feeCents : 0;
      if (deliveryCents > 0) {
        if (TAX_ENABLED) {
          // 启用 Stripe Tax 时，配送费走 shipping_options，才能按运费税码正确计税
          shippingOptions = [{
            shipping_rate_data: {
              type        : 'fixed_amount',
              fixed_amount: { amount: deliveryCents, currency: 'usd' },
              display_name: '配送费 Delivery Fee',
              tax_behavior: 'exclusive',
              tax_code    : SHIPPING_TAX_CODE,
            },
          }];
        } else {
          lineItems.push({
            price_data: {
              currency    : 'usd',
              product_data: { name: '配送费 Delivery Fee' },
              unit_amount : deliveryCents,
            },
            quantity: 1,
          });
        }
      }
    }

    // ── 创建 Stripe 收银会话 ───────────────────────────────────
    let requestedHost = '';
    try { requestedHost = new URL(origin).hostname.toLowerCase().replace(/^www\./, ''); } catch {}
    const storeHost = String(store.domain || '').toLowerCase().replace(/^www\./, '');
    const allowedHost = requestedHost === 'sorghuman.com' ||
      (storeHost && (requestedHost === storeHost || requestedHost.endsWith('.' + storeHost)));
    const base = allowedHost ? `https://${requestedHost}` : `https://${storeHost || 'sorghuman.com'}`;
    const successUrl = `${base}/shop/?order=success`;
    const cancelUrl  = `${base}/shop/`;

    const sessionParams = {
      payment_method_types        : ['card'],
      line_items                  : lineItems,
      mode                        : purchaseType === 'subscription' ? 'subscription' : 'payment',
      success_url                 : successUrl,
      cancel_url                  : cancelUrl,
      metadata                    : {
        store_id: storeId, purchase_type: purchaseType,
        subtotal_cents: String(subtotalCents), delivery_cents: String(deliveryCents),
        ...cartToMetadata(charged),          // 订单落库失败时 webhook 据此补建
      },
      shipping_address_collection : { allowed_countries: ['US'] },
      phone_number_collection     : { enabled: true },
    };
    if (shippingOptions) sessionParams.shipping_options = shippingOptions;
    if (TAX_ENABLED)     sessionParams.automatic_tax    = { enabled: true };

    const session = await stripe.checkout.sessions.create(sessionParams);

    // ── 写订单到 Supabase（必须成功，否则不放行付款）──────────────
    const saved = await sbInsert('orders', {
      store_id         : storeId,
      stripe_session_id: session.id,
      items            : charged,
      subtotal         : subtotalCents  / 100,
      delivery_fee     : deliveryCents  / 100,
      total            : (subtotalCents + deliveryCents) / 100,
      status           : 'pending',
      purchase_type    : purchaseType,
    });
    if (!saved) {
      // 订单没记上就让会话立刻过期，顾客无法付款；让前端提示重试
      try { await stripe.checkout.sessions.expire(session.id); }
      catch (e) { console.error('failed to expire session', session.id, e.message); }
      return bad(503, 'Could not create order, please try again');
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      url: session.url,
      skipped: skippedNonSubscribable.length ? skippedNonSubscribable : undefined,
      skippedNoCase: skippedNoCase.length ? skippedNoCase : undefined,
    }) };

  } catch (e) {
    console.error('checkout error:', e.message);
    // 不把内部错误（表名、Stripe 细节）返回给浏览器
    return bad(500, 'Checkout failed, please try again');
  }
};
