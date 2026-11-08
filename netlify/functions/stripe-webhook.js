// netlify/functions/stripe-webhook.js
// Stripe 付款成功 → 更新订单状态 → 发邮件给门店

const { q, inList, esc } = require('./_lib/safe');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const crypto = require('crypto');

function deliverySignature(orderId, expires) {
  return crypto.createHmac('sha256', process.env.DELIVERY_LINK_SECRET || process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${orderId}.${expires}`).digest('base64url');
}

const DB_HEADERS = () => ({
  'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json',
});

// tax 列是后加的：迁移还没跑时，去掉它重试一次，不让整个订单更新失败
const withoutTax = (o) => { const { tax, ...rest } = o; return rest; };
const isColumnError = (status, text) => status === 400 && /tax|column/i.test(text);

// pending → paid，且只在订单仍是 pending 时生效（幂等）。返回 { ok, row } ；row 为空表示 0 行被更新
async function patchPaid(sid, update) {
  const url = `${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${sid}&status=eq.pending`;
  const opts = (body) => ({ method: 'PATCH', headers: { ...DB_HEADERS(), Prefer: 'return=representation' }, body: JSON.stringify(body) });
  let res = await fetch(url, opts(update));
  if (!res.ok) {
    const t = await res.text();
    if (!isColumnError(res.status, t)) { console.error('order update failed', res.status, t.slice(0, 300)); return { ok: false }; }
    res = await fetch(url, opts(withoutTax(update)));
    if (!res.ok) { console.error('order update failed', res.status, (await res.text()).slice(0, 300)); return { ok: false }; }
  }
  const rows = await res.json();
  return { ok: true, row: rows[0] || null };
}

// 从会话 metadata（create-checkout 写入的 cart_0.. 分段）还原购物车；失败返回 null
function parseCartMeta(meta) {
  if (!meta || meta.cart_truncated) return null;
  let json = '';
  for (let n = 0; meta['cart_' + n] !== undefined; n++) json += meta['cart_' + n];
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr.map(([sku, qty, m]) => ({ sku, qty, mode: m === 'c' ? 'case' : 'unit' }));
  } catch { return null; }
}

const cents = (v) => (Number(v) || 0) / 100;

// 订单行不存在（创建订单时写库失败）→ 用会话数据补建一条已付款订单
// 返回 { row } | { duplicate: true } | null（补建失败，调用方应返回 500 让 Stripe 重试）
async function rebuildOrder(session, update, storeId) {
  const meta = session.metadata || {};
  let items = parseCartMeta(meta);
  if (!items) {
    try {
      const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      items = li.data.map(l => ({ _lookupKey: l.description, qty: l.quantity }));
    } catch (e) { console.error('listLineItems failed:', e.message); items = []; }
  }
  const row = {
    store_id: storeId, stripe_session_id: session.id, items,
    subtotal: cents(meta.subtotal_cents), delivery_fee: cents(meta.delivery_cents),
    ...update, status: 'paid',
  };
  const post = (body) => fetch(`${SUPA_URL}/rest/v1/orders`, {
    method: 'POST', headers: { ...DB_HEADERS(), Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  let res = await post(row);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 409) return { duplicate: true };          // 并发重发：另一次已建好
    if (!isColumnError(res.status, t)) { console.error('order rebuild failed', res.status, t.slice(0, 300)); return null; }
    res = await post(withoutTax(row));
    if (!res.ok) {
      if (res.status === 409) return { duplicate: true };
      console.error('order rebuild failed', res.status, (await res.text()).slice(0, 300)); return null;
    }
  }
  console.warn('订单行缺失，已根据 Stripe 会话补建:', session.id);
  const rows = await res.json();
  return { row: rows[0] };
}

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
    // 税费（启用 Stripe Tax 时才有值；需要 orders.tax 列，见迁移脚本）
    tax                   : cents(session.total_details?.amount_tax),
    // 订阅（session.mode==='subscription'）会带上 stripe 的订阅 ID，
    // 用于后续自动续订、取消或客户自助管理。
    purchase_type          : session.mode === 'subscription' ? 'subscription' : 'one_time',
    stripe_subscription_id : session.subscription || null,
  };

  // 1) 只在订单仍为 pending 时改成 paid（幂等）。写库失败 → 返回 500，Stripe 会自动重试。
  const paid = await patchPaid(q(session.id), update);
  if (!paid.ok) return { statusCode: 500, body: 'order update failed' };

  let order = paid.row;
  if (!order) {
    // 0 行被更新：要么是 Stripe 重发的重复事件，要么订单行根本不存在
    const ex = await fetch(`${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${q(session.id)}&select=id&limit=1`,
      { headers: DB_HEADERS() });
    if (!ex.ok) return { statusCode: 500, body: 'order lookup failed' };
    if ((await ex.json())[0]) {
      console.log('重复的 checkout.session.completed，订单已处理，跳过通知:', session.id);
      return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    }
    const rebuilt = await rebuildOrder(session, update, storeId);
    if (!rebuilt) return { statusCode: 500, body: 'order rebuild failed' };
    if (rebuilt.duplicate) return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    order = rebuilt.row;
  }

  // ── 读取门店信息、商品名称（通知用；失败不影响订单已记账）─────────
  try {
    const storeRes = await fetch(
      `${SUPA_URL}/rest/v1/stores?store_id=eq.${q(storeId)}&select=name_zh,name_en,contact_email,contact_phone,drivers&limit=1`,
      { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } });
    const stores = await storeRes.json();
    const store  = stores[0];

    if (!store || !order) {
      console.log('无法发送通知：门店或订单不存在');
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // 读取商品名称
    const cart  = Array.isArray(order.items) ? order.items : [];
    const skus  = cart.map(i => i.sku).filter(Boolean);
    let prodMap = {};
    if (skus.length > 0) {
      const prodRes = await fetch(
        `${SUPA_URL}/rest/v1/products?sku=in.${inList(skus)}&select=sku,name_zh,name_en`,
        { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }
      );
      const prods = await prodRes.json();
      prods.forEach(p => { prodMap[p.sku] = p; });
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
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0ea;">${esc(name)}</td>
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
        <div style="color:#888;font-size:13px;">${esc(storeName)}</div>
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
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">${esc(update.customer_phone || 'N/A')}</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">顾客邮箱 Email</td>
            <td style="padding:10px 16px;font-size:13px;">${esc(update.customer_email || 'N/A')}</td>
          </tr>
          <tr style="border-top:1px solid #eee;">
            <td style="padding:10px 16px;font-size:12px;color:#888;">配送地址 Address</td>
            <td style="padding:10px 16px;font-size:13px;font-weight:600;">${esc(addrStr)}</td>
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
          </tr>${Number(update.tax) > 0 ? `
          <tr>
            <td style="padding:4px 0;font-size:13px;color:#888;">税费 Tax</td>
            <td style="padding:4px 0;font-size:13px;text-align:right;">$${Number(update.tax).toFixed(2)}</td>
          </tr>` : ''}
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

    // ── 通过 Twilio 发短信给门店 + 兼职司机 ────────────────────────
    const TWILIO_SID     = process.env.TWILIO_SID;
    const TWILIO_TOKEN   = process.env.TWILIO_TOKEN;
    const TWILIO_FROM    = process.env.TWILIO_PHONE;
    const TWILIO_MSG_SVC = process.env.TWILIO_MESSAGING_SERVICE_SID; // 已审批的 Messaging Service（推荐走这个）

    if (TWILIO_SID && TWILIO_TOKEN && (TWILIO_MSG_SVC || TWILIO_FROM)) {
      const twilioAuth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      const smsSend = (to, body) => fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method : 'POST',
          headers: { 'Authorization':`Basic ${twilioAuth}`, 'Content-Type':'application/x-www-form-urlencoded' },
          body   : new URLSearchParams(
            TWILIO_MSG_SVC
              ? { MessagingServiceSid: TWILIO_MSG_SVC, To: to, Body: body }
              : { From: TWILIO_FROM, To: to, Body: body }
          ),
        }
      ).catch(e => console.error('短信失败:', to, e.message));

      const siteBase = `https://sorghuman.com`;
      const deliveryExpires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      const deliverySig = deliverySignature(session.id, deliveryExpires);
      const deliveryLink = `${siteBase}/delivery/?id=${encodeURIComponent(session.id)}&e=${deliveryExpires}&sig=${encodeURIComponent(deliverySig)}`;

      // 1. 通知顾客：订单已确认
      if (update.customer_phone) {
        await smsSend(update.customer_phone,
          `【${store.name_zh}】您的订单 #${orderId} 已确认
` +
          `金额：$${total}
` +
          `我们正在为您备货，配送员即将出发。
回复 STOP 退订。`
        );
      }

      // 2. 通知门店
      if (store.contact_phone) {
        await smsSend(store.contact_phone,
          `新订单 #${orderId} · $${total}
` +
          `顾客：${update.customer_phone||'未填'}
` +
          `地址：${addrStr}
` +
          `详情请查收邮件`
        );
      }

      // 3. 通知兼职司机（附配送操作链接）
      const drivers = store.drivers || [];
      await Promise.all(drivers.filter(d=>d.phone).map(d =>
        smsSend(d.phone,
          `新配送任务 #${orderId}
` +
          `${store.name_zh} → ${addrStr}
` +
          `顾客电话：${update.customer_phone||'未填'}
` +
          `金额：$${total}
` +
          `操作链接：${deliveryLink}`
        )
      ));

      console.log(`短信已发：顾客+门店+${drivers.length}位司机`);
    }

    // ── 通过 Resend 发送邮件 ──────────────────────────────────────
    if (!store.contact_email || !RESEND_KEY) {
      console.log('门店未配置通知邮箱或 Resend，跳过邮件');
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
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
