// netlify/functions/stripe-webhook.js
// Stripe 付款成功 → 更新订单状态 → 发邮件给门店

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method not allowed' };

  // ── 验证 Stripe 签名 ──────────────────────────────────────────
  const sig    = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('签名验证失败:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  if (stripeEvent.type !== 'checkout.session.completed')
    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  const session = stripeEvent.data.object;
  const storeId = session.metadata?.store_id || 'default';

  // ── 更新 Supabase 订单状态 ────────────────────────────────────
  const update = {
    status                : 'paid',
    stripe_payment_intent : session.payment_intent || null,
    customer_email        : session.customer_details?.email || null,
    customer_phone        : session.customer_details?.phone || null,
    shipping_address      : session.shipping_details?.address 
                            || session.customer_details?.address || null,
    shipping_name         : session.shipping_details?.name 
                            || session.customer_details?.name || null,
    total                 : session.amount_total ? session.amount_total / 100 : null,
  };

  await fetch(`${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${session.id}`, {
    method : 'PATCH',
    headers: {
      'apikey'       : SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type' : 'application/json',
      'Prefer'       : 'return=minimal',
    },
    body: JSON.stringify(update),
  });

  // ── 读取订单详情、门店信息、商品名称 ─────────────────────────
  try {
    const [orderRes, storeRes] = await Promise.all([
      fetch(`${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${session.id}&select=*&limit=1`,
        { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }),
      fetch(`${SUPA_URL}/rest/v1/stores?store_id=eq.${storeId}&select=name_zh,name_en,contact_email&limit=1`,
        { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }),
    ]);

    const orders = await orderRes.json();
    const stores = await storeRes.json();
    const order  = orders[0];
    const store  = stores[0];

    if (!store?.contact_email || !order) {
      console.log('无法发邮件：门店无邮箱或订单不存在');
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // 读取商品名称
    const cart  = Array.isArray(order.items) ? order.items : [];
    const skus  = cart.map(i => i.sku).filter(Boolean);
    let prodMap = {};
    if (skus.length > 0) {
      const prodRes = await fetch(
        `${SUPA_URL}/rest/v1/products?sku=in.(${skus.join(',')})&select=sku,name_zh,name_en`,
        { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }
      );
      const prods = await prodRes.json();
      prods.forEach(p => { prodMap[p.sku] = p; });
    }

    // 对没有 SKU 的 item（local.html 旧格式），用 Stripe API 查商品名
    for (const item of cart) {
      if (!item.sku && item.price) {
        try {
          const priceData = await stripe.prices.retrieve(item.price, { expand: ['product'] });
          const productName = priceData.product?.name || item.price.slice(-8);
          prodMap[item.price] = { name_zh: productName, name_en: '' };
          item._lookupKey = item.price; // 用 price 作为查询 key
        } catch(e) {
          prodMap[item.price] = { name_zh: item.price.slice(-8), name_en: '' };
          item._lookupKey = item.price;
        }
      }
    }

    // ── 构建订单邮件 HTML ────────────────────────────────────────
    const addr    = update.shipping_address;
    const addrName = update.shipping_name || '';
    const addrStr = addr
      ? [addrName, addr.line1, addr.line2, addr.city, addr.state, addr.postal_code].filter(Boolean).join(', ')
      : 'N/A';
    const orderId  = order.id ? order.id.slice(-8).toUpperCase() : 'N/A';
    const orderTime = new Date(order.created_at).toLocaleString('zh-CN', {
      timeZone: 'America/New_York',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit'
    });
    const total      = Number(update.total || order.total || 0).toFixed(2);
    const subtotal   = Number(order.subtotal || 0).toFixed(2);
    const deliveryFee= Number(order.delivery_fee || 0).toFixed(2);
    const storeName  = store.name_zh + (store.name_en ? ' / ' + store.name_en : '');

    const itemRows = cart.map(i => {
      const key  = i.sku || i._lookupKey || i.price;
      const p    = prodMap[key] || {};
      const name = p.name_zh ? `${p.name_zh} ${p.name_en || ''}`.trim() : (key || '?');
      const qty  = i.qty || i.quantity || 1;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0ea;">${name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0ea;text-align:center;">${qty}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

      <!-- 顶部品牌栏 -->
      <tr><td style="background:#1A4A28;padding:20px 32px;">
        <div style="color:#F0C060;font-size:13px;font-weight:700;letter-spacing:0.1em;">
          订单通知 ORDER NOTIFICATION
        </div>
        <div style="color:rgba(255,255,255,0.7);font-size:11px;margin-top:4px;">
          Sorghuman Holdings · 高仁控股
        </div>
      </td></tr>

      <!-- 订单摘要 -->
      <tr><td style="padding:24px 32px 16px;">
        <div style="font-size:22px;font-weight:700;color:#1A4A28;margin-bottom:4px;">
          🛒 新订单 New Order
        </div>
        <div style="color:#888;font-size:13px;">${storeName}</div>
        <div style="margin-top:16px;display:flex;gap:24px;">
          <span style="background:#f0f7f2;color:#1A4A28;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;">
            已付款 PAID
          </span>
        </div>
      </td></tr>

      <!-- 订单基本信息 -->
      <tr><td style="padding:0 32px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f5;border-radius:6px;overflow:hidden;">
          <tr>
            <td style="padding:10px 16px;font-size:12px;color:#888;width:120px;">订单号 Order</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;font-family:monospace;">#${orderId}</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">时间 Time</td>
            <td style="padding:10px 16px;font-size:13px;">${orderTime} (ET)</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">顾客电话 Phone</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">${update.customer_phone || 'N/A'}</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">顾客邮箱 Email</td>
            <td style="padding:10px 16px;font-size:13px;">${update.customer_email || 'N/A'}</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">配送地址 Address</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">${addrStr}</td>
          </tr>
        </table>
      </td></tr>

      <!-- 商品清单 -->
      <tr><td style="padding:0 32px 16px;">
        <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:8px;">
          商品清单 Items
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;">
          <tr style="background:#f8f8f5;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;font-weight:600;">商品 Product</th>
            <th style="padding:8px 12px;text-align:center;font-size:12px;color:#888;font-weight:600;width:60px;">数量 Qty</th>
          </tr>
          ${itemRows}
        </table>
      </td></tr>

      <!-- 金额 -->
      <tr><td style="padding:0 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:4px 0;font-size:13px;color:#888;">小计 Subtotal</td>
            <td style="padding:4px 0;font-size:13px;text-align:right;">$${subtotal}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;font-size:13px;color:#888;">配送费 Delivery</td>
            <td style="padding:4px 0;font-size:13px;text-align:right;">$${deliveryFee}</td>
          </tr>
          <tr style="border-top:2px solid #1A4A28;">
            <td style="padding:10px 0 4px;font-size:16px;font-weight:700;color:#1A4A28;">合计 Total</td>
            <td style="padding:10px 0 4px;font-size:16px;font-weight:700;color:#1A4A28;text-align:right;">$${total}</td>
          </tr>
        </table>
      </td></tr>

      <!-- 页脚 -->
      <tr><td style="background:#f8f8f5;padding:16px 32px;border-top:1px solid #eee;">
        <div style="font-size:11px;color:#aaa;text-align:center;">
          此邮件由系统自动发送，请勿回复。This is an automated email, please do not reply.<br>
          订单通知 Order Notification · noreply@sorghuman.com
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

    // ── 通过 Resend 发送邮件 ──────────────────────────────────────
    const emailRes = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        from   : '订单通知 Order Notification <noreply@sorghuman.com>',
        to     : store.contact_email,
        subject: `新订单 #${orderId} · ${store.name_zh} · $${total}`,
        html,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('Resend 发送失败:', err);
    } else {
      console.log('订单邮件已发送至:', store.contact_email);
    }

  } catch (err) {
    console.error('邮件发送异常:', err.message);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
