// stripe-webhook.js
// 放到 netlify/functions/ 目录下

const ODOO_URL  = "https://sorg.odoo.com";
const ODOO_DB   = "sorg";
const ODOO_USER = "glitter.ge@sorghuman.com";
const ODOO_PASS = process.env.ODOO_PASSWORD;

// 所有网站零售订单统一挂在这个虚拟客户下
const ONLINE_PARTNER_ID = 87;

const NAME_TO_REF = {
  "Dried Mustard Green":           "BAG-7951",
  "梅干菜":                         "BAG-7951",
  "Shredded Radish":               "BAG-7985",
  "萝卜":                           "BAG-7985",
  "Bok Choy":                      "BAG-9615",
  "上海青":                         "BAG-9615",
  "Chinese Chive":                 "BAG-CHIVE",
  "韭菜":                           "BAG-CHIVE",
  "Adzuki Bean":                   "BAG-9913",
  "豆沙":                           "BAG-9913",
  "Tofu":                          "BAG-6784",
  "豆腐":                           "BAG-6784",
  "Plum Soup 酸梅汤 (single)":      "BAG-PLUM1",
  "Plum Soup 酸梅汤 (case":         "BAG-PLUM20",
  "Concentrate":                   "BAG-CONC",
  "浓缩":                           "BAG-CONC",
};

async function odooLogin() {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS },
    }),
  });
  const data = await res.json();
  if (!data.result?.uid) throw new Error("Odoo 登录失败，请检查密码");
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/session_id=([^;]+)/);
  if (!match) throw new Error("无法获取 session cookie");
  console.log(`Odoo 登录成功 uid=${data.result.uid}`);
  return match[1];
}

async function odoo(sid, model, method, args, kwargs = {}) {
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `session_id=${sid}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "call",
      params: { model, method, args, kwargs: { context: {}, ...kwargs } },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
  return data.result;
}

async function findProduct(sid, ref) {
  const ids = await odoo(sid, "product.product", "search", [[["default_code", "=", ref]]]);
  if (!ids.length) throw new Error(`找不到产品: ${ref}`);
  const rows = await odoo(sid, "product.product", "read", [ids], { fields: ["id", "list_price", "name"] });
  console.log(`产品: ${rows[0].name} $${rows[0].list_price}`);
  return rows[0];
}

function parseOrderParam(orderStr) {
  if (!orderStr) return [];
  const result = [];
  for (const line of orderStr.split(" | ")) {
    const match = line.match(/^(.+?)\s+x(\d+)/);
    if (!match) continue;
    const rawName = match[1].trim();
    const qty = parseInt(match[2]);
    let ref = null;
    for (const [key, val] of Object.entries(NAME_TO_REF)) {
      if (rawName.includes(key)) { ref = val; break; }
    }
    if (qty > 0) result.push({ ref, qty, rawName });
  }
  return result;
}

async function createOdooOrder(session) {
  const email       = session.customer_details?.email || "";
  const name        = session.customer_details?.name  || email;
  const amountTotal = (session.amount_total || 0) / 100;
  const stripeId    = session.id;
  const shipping    = session.shipping_details || session.customer_details;

  console.log(`处理订单: ${stripeId} | ${email} | $${amountTotal}`);

  const sid = await odooLogin();

  // 解析产品
  const orderParam = session.metadata?.order || "";
  console.log(`order 参数: "${orderParam}"`);
  const items = parseOrderParam(orderParam);
  console.log(`解析到 ${items.length} 个产品`);

  const orderLines = [];
  for (const item of items) {
    if (!item.ref) {
      orderLines.push([0, 0, { name: item.rawName, product_uom_qty: item.qty, price_unit: 4.99 }]);
      continue;
    }
    try {
      const product = await findProduct(sid, item.ref);
      orderLines.push([0, 0, {
        product_id: product.id,
        product_uom_qty: item.qty,
        price_unit: product.list_price,
      }]);
    } catch (e) {
      console.error(`跳过 ${item.ref}: ${e.message}`);
    }
  }

  if (orderLines.length === 0) {
    console.log("使用兜底产品 BAG-7951");
    const fallback = await findProduct(sid, "BAG-7951");
    orderLines.push([0, 0, {
      product_id: fallback.id,
      product_uom_qty: 1,
      price_unit: amountTotal,
    }]);
  }

  // 配送地址和客户信息写入备注
  const shippingAddr = shipping ? [
    shipping.name,
    shipping.address?.line1,
    shipping.address?.line2,
    shipping.address?.city,
    shipping.address?.state,
    shipping.address?.postal_code,
  ].filter(Boolean).join(", ") : "";

  const noteLines = [];
  if (name)        noteLines.push(`客户: ${name}`);
  if (email)       noteLines.push(`邮件: ${email}`);
  if (shippingAddr) noteLines.push(`配送地址: ${shippingAddr}`);

  // 创建销售订单，统一用 Online Retail Customer
  const soId = await odoo(sid, "sale.order", "create", [{
    partner_id: ONLINE_PARTNER_ID,
    order_line: orderLines,
    note: noteLines.join("\n"),
  }]);
  console.log(`销售订单已创建: id=${soId}`);

  await odoo(sid, "sale.order", "action_confirm", [[soId]]);
  console.log(`销售订单已确认`);

  await odoo(sid, "sale.order", "_create_invoices", [[soId]]);

  const soData = await odoo(sid, "sale.order", "read", [[soId]], { fields: ["invoice_ids"] });
  const invoiceId = soData[0]?.invoice_ids?.[0];
  if (!invoiceId) { console.log("发票暂未生成"); return soId; }
  console.log(`发票已创建: id=${invoiceId}`);

  await odoo(sid, "account.move", "action_post", [[invoiceId]]);
  console.log(`发票已确认`);

  return soId;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const Stripe = require("stripe");
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers["stripe-signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("签名验证失败:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Ignored" };
  }

  try {
    const soId = await createOdooOrder(stripeEvent.data.object);
    return { statusCode: 200, body: JSON.stringify({ success: true, soId }) };
  } catch (err) {
    console.error("Odoo 建单失败:", err.message);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
