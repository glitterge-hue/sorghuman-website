// netlify/functions/stripe-webhook.js
// Stripe 付款成功回调 → 自动把订单状态改为 paid
//
// 需要在 Netlify 环境变量里加：
//   STRIPE_WEBHOOK_SECRET   whsec_... （从 Stripe Webhooks 页面复制）

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  // 只接受 POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // ── 验证 Stripe 签名（防止伪造请求）──────────────────────────
  const sig     = event.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Webhook 签名验证失败:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  // ── 只处理付款成功事件 ────────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // 收集客户信息
    const update = {
      status                 : 'paid',
      stripe_payment_intent  : session.payment_intent || null,
      customer_email         : session.customer_details?.email || null,
      customer_phone         : session.customer_details?.phone || null,
      shipping_address       : session.shipping_details?.address || null,
      total                  : session.amount_total ? session.amount_total / 100 : null,
    };

    // 按 stripe_session_id 找到订单并更新
    const res = await fetch(
      `${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${session.id}`,
      {
        method : 'PATCH',
        headers: {
          'apikey'        : SUPA_KEY,
          'Authorization' : `Bearer ${SUPA_KEY}`,
          'Content-Type'  : 'application/json',
          'Prefer'        : 'return=minimal',
        },
        body: JSON.stringify(update),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error('Supabase 更新失败:', text);
      return { statusCode: 500, body: 'DB update failed' };
    }

    console.log('订单已标记为 paid:', session.id);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
