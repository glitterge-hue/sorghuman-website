// tests/hardening.test.cjs — 查询注入防护 / 令牌校验 / 订单落库 / webhook 幂等 / 税费开关
// 运行：node --test tests/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FN = path.join(__dirname, '..', 'netlify', 'functions');

// ── 伪造 stripe 模块（不需要安装依赖、不联网）──────────────────────────
let stripeCalls;
function fakeStripe() {
  return {
    checkout: { sessions: {
      create: async (p) => { stripeCalls.create.push(p); return { id: 'cs_test_1', url: 'https://stripe.test/pay' }; },
      expire: async (id) => { stripeCalls.expire.push(id); return {}; },
      listLineItems: async () => ({ data: [{ description: '某商品', quantity: 2 }] }),
    } },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) },
  };
}
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'stripe') return () => fakeStripe();
  return origLoad.call(this, request, ...rest);
};

function fresh(file, env = {}) {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh',
    STRIPE_TAX_ENABLED: 'false',
  }, env);
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN)) delete require.cache[k];
  return require(path.join(FN, file));
}

let fetchLog, router;
beforeEach(() => {
  stripeCalls = { create: [], expire: [] };
  fetchLog = [];
  router = () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' });
  global.fetch = async (url, opts = {}) => {
    fetchLog.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    return router(String(url), opts);
  };
});
const res = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

// ── safe.js ──────────────────────────────────────────────────────────
test('q(): 注入字符被编码，值无法变成查询语法', () => {
  const { q } = require(path.join(FN, '_lib', 'safe.js'));
  const out = q('default&or=(store_id.not.is.null)');
  assert.ok(!/[&=()]/.test(out), out);
  assert.equal(decodeURIComponent(out), 'default&or=(store_id.not.is.null)');
  assert.equal(q(null), '');
  assert.ok(q('x'.repeat(1000)).length <= 256);
});

test('inList(): 每项加引号并转义，逗号/括号/引号不会逃逸', () => {
  const { inList } = require(path.join(FN, '_lib', 'safe.js'));
  const out = decodeURIComponent(inList(['A1', 'B,2', 'C")&x=(', 'D\\']));
  assert.equal(out, '("A1","B,2","C\\")&x=(","D\\\\")');
  assert.equal(decodeURIComponent(inList([])), '()');
  assert.equal(decodeURIComponent(inList('not-an-array')), '()');
});

// ── auth.js ──────────────────────────────────────────────────────────
const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
const ev = { headers: { 'x-nf-client-connection-ip': '1.2.3.4' } };
const base = { table: 'stores', idCol: 'store_id', id: 's1', event: ev, scope: 't', select: 'store_id,name_zh' };

test('auth: 哈希比对成功，返回行里不含 token 字段', async () => {
  fresh('store-orders.js');
  const { verifyToken } = require(path.join(FN, '_lib', 'auth.js'));
  router = (url) => url.includes('admin_auth_failures') ? res([]) :
    res([{ store_id: 's1', name_zh: '店', admin_token: 'plain', admin_token_hash: sha('secret') }]);
  const r = await verifyToken({ ...base, token: 'secret' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.row).sort(), ['name_zh', 'store_id']);
  // token 绝不出现在任何查询串里
  assert.ok(fetchLog.every(f => !f.url.includes('secret')));
});

test('auth: 有哈希时不再接受明文匹配（哈希为准）', async () => {
  fresh('store-orders.js');
  const { verifyToken } = require(path.join(FN, '_lib', 'auth.js'));
  router = (url) => url.includes('admin_auth_failures') ? res([]) :
    res([{ store_id: 's1', admin_token: 'old', admin_token_hash: sha('new') }]);
  assert.equal((await verifyToken({ ...base, token: 'old' })).ok, false);
});

test('auth: 迁移前（无哈希列）回退到明文比对', async () => {
  fresh('store-orders.js');
  const { verifyToken } = require(path.join(FN, '_lib', 'auth.js'));
  let n = 0;
  router = (url) => {
    if (url.includes('admin_auth_failures')) return res([]);
    return (n++ === 0) ? res({ message: 'column admin_token_hash does not exist' }, 400)
                       : res([{ store_id: 's1', admin_token: 'plain' }]);
  };
  assert.equal((await verifyToken({ ...base, token: 'plain' })).ok, true);
});

test('auth: 错误令牌写入失败记录；同 IP 失败 10 次后锁定', async () => {
  fresh('store-orders.js');
  const { verifyToken } = require(path.join(FN, '_lib', 'auth.js'));
  router = (url, opts) => {
    if (url.includes('admin_auth_failures')) return res(opts.method === 'POST' ? [] : []);
    return res([{ store_id: 's1', admin_token_hash: sha('right') }]);
  };
  const r = await verifyToken({ ...base, token: 'wrong' });
  assert.deepEqual(r, { ok: false, locked: false });
  assert.ok(fetchLog.some(f => f.method === 'POST' && f.url.includes('admin_auth_failures')));

  router = (url) => url.includes('admin_auth_failures') ? res(new Array(10).fill({ id: 1 })) : res([]);
  assert.deepEqual(await verifyToken({ ...base, token: 'x' }), { ok: false, locked: true });
});

test('auth: 限速表不存在时放行（不把店主锁在门外）', async () => {
  fresh('store-orders.js');
  const { verifyToken } = require(path.join(FN, '_lib', 'auth.js'));
  router = (url) => url.includes('admin_auth_failures') ? res({ message: 'relation does not exist' }, 404)
    : res([{ store_id: 's1', admin_token_hash: sha('ok') }]);
  assert.equal((await verifyToken({ ...base, token: 'ok' })).ok, true);
});

// ── create-checkout ──────────────────────────────────────────────────
function checkoutRouter({ insertOk = true } = {}) {
  return (url, opts) => {
    if (opts.method === 'POST' && url.endsWith('/orders')) return insertOk ? res([], 201) : res({ message: 'boom' }, 500);
    if (url.includes('/stores?'))       return res([{ store_id: 'default', markup: 1, domain: 'sorghuman.com', free_delivery_threshold: 100, delivery_fee: 5 }]);
    if (url.includes('/products?'))     return res([
      { sku: 'F1', name_zh: '食', name_en: 'Food', base_price: 10, product_line: 'food' },
      { sku: 'N1', name_zh: '盒', name_en: 'Box',  base_price: 20, product_line: 'non_food' },
    ]);
    return res([]);
  };
}
const post = (cart, extra = {}) => ({ httpMethod: 'POST', body: JSON.stringify({ cart, origin: 'https://sorghuman.com', ...extra }) });

test('checkout: 订单写库失败 → 会话立即过期，返回 503，不放行付款', async () => {
  const { handler } = fresh('create-checkout.js');
  router = checkoutRouter({ insertOk: false });
  const r = await handler(post([{ sku: 'F1', qty: 1 }]));
  assert.equal(r.statusCode, 503);
  assert.deepEqual(stripeCalls.expire, ['cs_test_1']);
  assert.ok(!r.body.includes('boom'));
});

test('checkout: 订单写库成功 → 返回支付链接，metadata 带购物车', async () => {
  const { handler } = fresh('create-checkout.js');
  router = checkoutRouter();
  const r = await handler(post([{ sku: 'F1', qty: 2 }, { sku: 'N1', qty: 1, mode: 'case' }]));
  assert.equal(r.statusCode, 200);
  assert.equal(stripeCalls.expire.length, 0);
  const meta = stripeCalls.create[0].metadata;
  assert.equal(JSON.parse(meta.cart_0)[0][0], 'F1');
  assert.equal(meta.subtotal_cents, '2000');
});

test('checkout: 恶意 sku / storeId 不会改写查询', async () => {
  const { handler } = fresh('create-checkout.js');
  router = checkoutRouter();
  await handler(post([{ sku: 'F1",x&or=(a.eq.1)', qty: 1 }, { sku: 'F1', qty: 1 }], { storeId: 'default&limit=1000' }));
  const urls = fetchLog.map(f => f.url).filter(u => u.includes('/rest/v1/'));
  assert.ok(urls.length > 0);
  for (const u of urls) {
    const qs = u.split('?')[1] || '';
    assert.ok(!/(^|&)or=/.test(qs), u);
    assert.ok(!/(^|&)limit=1000/.test(qs), u);
  }
});

test('checkout: 非法参数被拒绝或清洗', async () => {
  const { handler } = fresh('create-checkout.js');
  router = checkoutRouter();
  assert.equal((await handler(post([]))).statusCode, 400);
  assert.equal((await handler(post([{ sku: { $ne: 1 }, qty: 1 }, { sku: 'F1', qty: -5 }, { sku: 'F1', qty: 'x' }]))).statusCode, 400);
  assert.equal((await handler(post([{ sku: 'F1', qty: 1 }], { storeId: { a: 1 } }))).statusCode, 400);
  const r = await handler(post([{ sku: 'F1', qty: 999999 }]));
  assert.equal(r.statusCode, 200);
  assert.equal(stripeCalls.create.at(-1).line_items[0].quantity, 999);
});

test('checkout: 税费关闭时行为不变（配送费仍是行项目，无 automatic_tax）', async () => {
  const { handler } = fresh('create-checkout.js', { STRIPE_TAX_ENABLED: 'false' });
  router = checkoutRouter();
  await handler(post([{ sku: 'F1', qty: 1 }]));          // $10 < 免运费线 $100 → 收 $5
  const p = stripeCalls.create[0];
  assert.equal(p.automatic_tax, undefined);
  assert.equal(p.shipping_options, undefined);
  assert.ok(p.line_items.some(li => li.price_data.product_data.name.includes('配送费')));
  assert.equal(p.line_items[0].price_data.tax_behavior, undefined);
});

test('checkout: 税费开启 → automatic_tax、税前标价、非食品税码、运费走 shipping_options', async () => {
  const { handler } = fresh('create-checkout.js', { STRIPE_TAX_ENABLED: 'true' });
  router = checkoutRouter();
  await handler(post([{ sku: 'F1', qty: 1 }, { sku: 'N1', qty: 1 }]));
  const p = stripeCalls.create[0];
  assert.deepEqual(p.automatic_tax, { enabled: true });
  const food = p.line_items.find(li => li.price_data.product_data.name.includes('Food'));
  const box  = p.line_items.find(li => li.price_data.product_data.name.includes('Box'));
  assert.equal(food.price_data.tax_behavior, 'exclusive');
  assert.equal(food.price_data.product_data.tax_code, undefined);      // 食品：用 Stripe 后台默认税码
  assert.equal(box.price_data.product_data.tax_code, 'txcd_99999999'); // 非食品：一般有形商品
  assert.equal(p.shipping_options[0].shipping_rate_data.tax_code, 'txcd_92010001');
  assert.equal(p.shipping_options[0].shipping_rate_data.fixed_amount.amount, 500);
  assert.ok(!p.line_items.some(li => li.price_data.product_data.name.includes('配送费')));
});

// ── stripe-webhook ───────────────────────────────────────────────────
const sessionEvent = (extra = {}) => JSON.stringify({
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_1', mode: 'payment', payment_intent: 'pi_1', amount_total: 1650,
    total_details: { amount_tax: 150 },
    customer_details: { email: 'a@b.c', phone: '+15550001111' },
    shipping_details: { name: 'N', address: { line1: '1 Main' } },
    metadata: { store_id: 'default', subtotal_cents: '1000', delivery_cents: '500',
                cart_0: JSON.stringify([['F1', 2, 'u']]) },
    ...extra } },
});
const whEvent = (body) => ({ httpMethod: 'POST', headers: { 'stripe-signature': 'sig' }, body });

test('webhook: 首次事件 → 更新为 paid（带税费），仅在 pending 时生效', async () => {
  const { handler } = fresh('stripe-webhook.js');
  router = (url, opts) => {
    if (opts.method === 'PATCH') return res([{ id: 'abcdef12345678', items: [{ sku: 'F1', qty: 2 }], subtotal: 10, delivery_fee: 5 }]);
    return res([]);
  };
  const r = await handler(whEvent(sessionEvent()));
  assert.equal(r.statusCode, 200);
  const patch = fetchLog.find(f => f.method === 'PATCH');
  assert.ok(patch.url.includes('status=eq.pending'));
  assert.equal(JSON.parse(patch.body).tax, 1.5);
  assert.equal(JSON.parse(patch.body).total, 16.5);
});

test('webhook: Stripe 重发（0 行被更新但订单已存在）→ 200 且跳过通知', async () => {
  const { handler } = fresh('stripe-webhook.js', { TWILIO_SID: 'x', TWILIO_TOKEN: 'y', TWILIO_PHONE: '+1' });
  router = (url, opts) => {
    if (opts.method === 'PATCH') return res([]);
    if (url.includes('/orders?') ) return res([{ id: 'o1' }]);
    return res([]);
  };
  const r = await handler(whEvent(sessionEvent()));
  assert.equal(r.statusCode, 200);
  assert.ok(JSON.parse(r.body).duplicate);
  assert.ok(fetchLog.every(f => !f.url.includes('twilio.com') && !f.url.includes('resend.com') && !f.url.includes('/stores?')));
});

test('webhook: 数据库更新失败 → 返回 500，让 Stripe 重试', async () => {
  const { handler } = fresh('stripe-webhook.js');
  router = (url, opts) => opts.method === 'PATCH' ? res({ message: 'db down' }, 503) : res([]);
  assert.equal((await handler(whEvent(sessionEvent()))).statusCode, 500);
});

test('webhook: 订单行缺失 → 根据会话 metadata 补建已付款订单', async () => {
  const { handler } = fresh('stripe-webhook.js');
  router = (url, opts) => {
    if (opts.method === 'PATCH') return res([]);
    if (opts.method === 'POST' && url.endsWith('/orders')) return res([{ id: 'new1', items: JSON.parse(opts.body).items }], 201);
    return res([]);                          // 查不到现有订单
  };
  const r = await handler(whEvent(sessionEvent()));
  assert.equal(r.statusCode, 200);
  const ins = fetchLog.find(f => f.method === 'POST' && f.url.endsWith('/orders'));
  const row = JSON.parse(ins.body);
  assert.equal(row.status, 'paid');
  assert.deepEqual(row.items, [{ sku: 'F1', qty: 2, mode: 'unit' }]);
  assert.equal(row.subtotal, 10);
  assert.equal(row.delivery_fee, 5);
});

test('webhook: orders.tax 列还不存在时，去掉 tax 重试（部署顺序容错）', async () => {
  const { handler } = fresh('stripe-webhook.js');
  let n = 0;
  router = (url, opts) => {
    if (opts.method === 'PATCH') return (n++ === 0) ? res({ message: 'column "tax" does not exist' }, 400)
                                                    : res([{ id: 'o1', items: [] }]);
    return res([]);
  };
  const r = await handler(whEvent(sessionEvent()));
  assert.equal(r.statusCode, 200);
  const patches = fetchLog.filter(f => f.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal('tax' in JSON.parse(patches[1].body), false);
});
