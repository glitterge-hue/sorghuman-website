// stripe-webhook.js
// 放到 netlify/functions/ 目录下
// Odoo 认证：API Key via Basic Auth (Odoo 16/17 支持)
// 无需任何额外 npm 包

// ── 配置 ──────────────────────────────────────────────────────────────────
const ODOO_URL     = "https://sorg.odoo.com";
const ODOO_DB      = "sorg";
const ODOO_USER    = "glitter.ge@sorghuman.com";
const ODOO_API_KEY = "780cfd71458536ff21acb93352b50258d467eef5";

// Basic Auth header: base64(user:api_key)
const ODOO_AUTH = "Basic " + Buffer.from(`${ODOO_USER}:${ODOO_API_KEY}`).toString("base64");

// 产品名关键词 → Odoo 货号
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

// ── Odoo JSON-RPC 封装（Basic Auth）────────────────────────────────────────
async function odoo(model, method, args, kwargs = {}) {
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": ODOO_AUTH,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "call",
      params: {
        model,
        method,
        args,
        kwargs: { context: {}, ...kwargs },
      },
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.data?.message || JSON.stringify(data.error));
  }
  return data.result;
}

// ── 业务逻辑 ───────────────────────────────────────────────────────────────

async function findOrCreatePartner(email, name) {
  const ids = await odoo("res.partner", "search", [[["email", "=", email]]]);
  if (ids.length > 0) {
    console.log(`已有客户: ${email} id=${ids[0]}`);
    return ids[0];
  }
  const id = await odoo("res.partner", "create", [{
    name: name || email,
    email: email,
    customer_rank: 1,
  }]);
  console.log(`新客户已创建: ${email} id=${id}`);
  return id;
}

async function findProduct(ref) {
  const ids = await odoo("product.product", "search", [[["default_code", "=", ref]]]);
  if (!ids.length) throw new Error(`找不到产品货号: ${ref}`);
  const rows = await odoo("product.product", "read", [ids], { fields: ["id", "list_price"] });
  return rows[0];
}

// 解析 order 参数字符串
// 格式: "Dried Mustard Green Bun 梅干菜包 x2 $9.98 | Adzuki Bean Bun 豆沙包 x1 $4.99"
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
  const email       = session.customer_details?.email || "unknown@sorghuman.com";
  const name        = session.customer_details?.name  || email;
  const amountTotal = (session.amount_total || 0) / 100;
  const stripeId    = session.id;

  console.log(`处理订单: ${stripeId} | ${email} | $${amountTotal}`);

  // 1. 找或创建客户
  const partnerId = await findOrCreatePartner(email, name);

  // 2. 解析产品明细
  const orderParam = session.metadata?.order || "";
  const items = parseOrderParam(orderParam);
  console.log(`解析到 ${items.length} 个产品`);

  // 3. 构建订单行
  const orderLines = [];
  for (const item of items) {
    if (!item.ref) {
      orderLines.push([0, 0, {
        name: item.rawName,
        product_uom_qty: item.qty,
        price_unit: 4.99,
      }]);
      continue;
    }
    try {
      const product = await findProduct(item.ref);
      orderLines.push([0, 0, {
        product_id: product.id,
        product_uom_qty: item.qty,
        price_unit: product.list_price,
      }]);
    } catch (e) {
      console.error(`跳过 ${item.ref}: ${e.message}`);
    }
  }

  // 兜底：完全解析不到时建通用行
  if (orderLines.length === 0) {
    orderLines.push([0, 0, {
      name: `Online Order - ${stripeId}`,
      product_uom_qty: 1,
      price_unit: amountTotal,
    }]);
  }

  // 4. 创建销售订单
  const soId = await odoo("sale.order", "create", [{
    partner_id: partnerId,
    order_line: orderLines,
    client_order_ref: stripeId,
    note: `Stripe: ${stripeId} | sorghuman.com local delivery`,
  }]);
  console.log(`销售订单已创建: id=${soId}`);

  // 5. 确认订单
  await odoo("sale.order", "action_confirm", [[soId]]);
  console.log(`销售订单已确认`);

  // 6. 创建发票
  await odoo("sale.order", "_create_invoices", [[soId]]);

  // 7. 取发票 id
  const soData = await odoo("sale.order", "read", [[soId]], { fields: ["invoice_ids"] });
  const invoiceId = soData[0]?.invoice_ids?.[0];
  if (!invoiceId) {
    console.log("发票暂未生成，订单已建立");
    return soId;
  }
  console.log(`发票已创建: id=${invoiceId}`);

  // 8. 确认发票
  await odoo("account.move", "action_post", [[invoiceId]]);
  console.log(`发票已确认`);

  return soId;
}

// ── Netlify Handler ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const Stripe = require("stripe");
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig    = event.headers["stripe-signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
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
    // 返回 200 防止 Stripe 重复推送
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
