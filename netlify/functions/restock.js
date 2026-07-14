// netlify/functions/restock.js  (v2)
// 门店补货 API —— 门店(店主 token) 向【已开户】的供应商下补货单
//
// 核心规则：
//  1. 供应商必须先审核通过（store_suppliers.status='approved'）门店才看得到价格、才能下单
//  2. 前端只传 sku + 箱数，价格一律服务端从 supplier_products 现查重算
//  3. 不显示毛利率，只显示箱价 / 单件成本
//  4. 供应商可给单店设账期额度，超额自动拒单

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                : 'application/json',
};

async function sb(method, table, qs, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`, {
    method : method || 'GET',
    headers: {
      'apikey'       : SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type' : 'application/json',
      'Prefer'       : 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${method}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

async function verifyStore(storeId, token, origin) {
  if (!storeId || !token) return null;
  const rows = await sb('GET', 'stores',
    `store_id=eq.${storeId}&admin_token=eq.${token}` +
    `&select=store_id,name_zh,name_en,domain,address,city,state,zip,contact_name,contact_phone`);
  const store = rows[0];
  if (!store) return null;
  if (origin) {
    const host     = origin.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const isMaster = host.endsWith('sorghuman.com');
    const isSelf   = store.domain && host.endsWith(store.domain.replace(/^www\./, ''));
    if (!isMaster && !isSelf) return null;
  }
  return store;
}

// 送货范围覆盖到这家店吗（决定能不能"申请"；能不能"下单"另看开户状态）
function inRange(sup, store) {
  const zips   = Array.isArray(sup.service_zips)   ? sup.service_zips   : [];
  const states = Array.isArray(sup.service_states) ? sup.service_states : [];
  if (!zips.length && !states.length) return true;
  if (zips.length   && store.zip   && zips.includes(String(store.zip)))   return true;
  if (states.length && store.state && states.includes(String(store.state).toUpperCase())) return true;
  return false;
}

async function myAccounts(storeId) {
  const rows = await sb('GET', 'store_suppliers',
    `store_id=eq.${storeId}&select=supplier_id,status,payment_terms,credit_limit,applied_at,reviewed_at`);
  return new Map(rows.map(r => [r.supplier_id, r]));
}

const pub = ({ admin_token, ...safe }) => safe;   // 绝不外泄别家 token

function poNumber(storeId) {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${storeId.toUpperCase()}-${ymd}-${rnd}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const origin = event.headers.origin || event.headers.referer || '';

  try {
    const payload = JSON.parse(event.body || '{}');
    const { action, storeId, token } = payload;

    const store = await verifyStore(storeId, token, origin);
    if (!store)
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '令牌无效 / Invalid token' }) };

    // ═══ 1. 供应商名录：谁能送到我这儿 + 我的开户状态 ═══════════════
    if (action === 'GET_SUPPLIER_DIRECTORY') {
      const all  = await sb('GET', 'suppliers', `active=eq.true&select=*`);
      const acct = await myAccounts(storeId);
      const list = all.filter(s => inRange(s, store)).map(s => {
        const a  = acct.get(s.supplier_id);
        const ok = a?.status === 'approved';
        const p  = pub(s);
        return {
          supplier_id: p.supplier_id, name_zh: p.name_zh, name_en: p.name_en,
          type: p.type, contact_name: p.contact_name, phone: p.phone, email: p.email,
          lead_time_days: p.lead_time_days, delivery_days: p.delivery_days,
          // 未开户只看得到"他送不送我这一片"，看不到价格条件
          min_order    : ok ? p.min_order    : null,
          delivery_fee : ok ? p.delivery_fee : null,
          free_delivery_threshold: ok ? p.free_delivery_threshold : null,
          payment_terms: ok ? (a.payment_terms || p.payment_terms) : null,
          credit_limit : ok ? (a.credit_limit ?? null) : null,
          account_status: a?.status || 'none',   // none/pending/approved/rejected/suspended
          applied_at    : a?.applied_at || null,
        };
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, store, suppliers: list }) };
    }

    // ═══ 2. 申请开户 ═══════════════════════════════════════════════
    if (action === 'APPLY_SUPPLIER') {
      const { supplierId, note } = payload;
      const supRows = await sb('GET', 'suppliers', `supplier_id=eq.${supplierId}&active=eq.true&select=*`);
      const sup = supRows[0];
      if (!sup || !inRange(sup, store))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '该供应商不服务本店区域' }) };

      const a = (await myAccounts(storeId)).get(supplierId);
      if (a?.status === 'approved')
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '已经开户了' }) };
      if (a?.status === 'pending')
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '申请审核中，请等待供应商联系' }) };
      if (a?.status === 'suspended')
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '账户已被供应商停单，请电话联系' }) };

      // rejected 允许重新申请（upsert 重置为 pending）
      await sb('POST', 'store_suppliers', null, [{
        supplier_id: supplierId, store_id: storeId, status: 'pending',
        apply_note : (note || '').slice(0, 500),
        applied_at : new Date().toISOString(), reviewed_at: null,
      }]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ═══ 3. 补货目录：只有已开户供应商的商品和价格 ═══════════════════
    if (action === 'GET_RESTOCK_CATALOG') {
      const acct  = await myAccounts(storeId);
      const okIds = [...acct.values()].filter(a => a.status === 'approved').map(a => a.supplier_id);
      const empty = { ok: true, store, suppliers: [], items: [] };
      if (!okIds.length)
        return { statusCode: 200, headers: CORS, body: JSON.stringify(empty) };

      const rowsSup = await sb('GET', 'suppliers',
        `supplier_id=in.(${okIds.join(',')})&active=eq.true&select=*`);
      const suppliers = rowsSup.filter(s => inRange(s, store)).map(s => {
        const a = acct.get(s.supplier_id);
        return { ...pub(s),
                 payment_terms: a.payment_terms || s.payment_terms,
                 credit_limit : a.credit_limit ?? null };
      });
      if (!suppliers.length)
        return { statusCode: 200, headers: CORS, body: JSON.stringify(empty) };

      const ids  = suppliers.map(s => s.supplier_id).join(',');
      const rows = await sb('GET', 'supplier_products',
        `supplier_id=in.(${ids})&active=eq.true` +
        `&select=supplier_id,sku,case_price,units_per_case,moq,stock_status,note,` +
        `products(name_zh,name_en,spec,category,image_url)`);

      // 只用来标"这个我店里在不在卖"，不回传零售价、不算毛利
      const mine  = await sb('GET', 'store_products', `store_id=eq.${storeId}&select=sku,active`);
      const shelf = new Set(mine.filter(m => m.active !== false).map(m => m.sku));

      const items = rows.filter(r => r.products).map(r => ({
        supplier_id: r.supplier_id,
        sku        : r.sku,
        name_zh    : r.products.name_zh,
        name_en    : r.products.name_en,
        spec       : r.products.spec,
        category   : r.products.category,
        image_url  : r.products.image_url,
        case_price    : Number(r.case_price),
        units_per_case: r.units_per_case,
        moq           : r.moq || 1,
        stock_status  : r.stock_status,
        note          : r.note,
        unit_cost  : Number((r.units_per_case > 0 ? r.case_price / r.units_per_case : r.case_price).toFixed(3)),
        on_shelf   : shelf.has(r.sku),
      }));

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, store, suppliers, items }) };
    }

    // ═══ 4. 提交补货单（按供应商拆单）═══════════════════════════════
    if (action === 'CREATE_POS') {
      const carts = payload.carts;
      if (!Array.isArray(carts) || !carts.length)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '购物车为空' }) };

      const acct = await myAccounts(storeId);
      const created = [], rejected = [];

      for (const cart of carts) {
        // ★ 开户校验：没批准 = 下不了单
        const a = acct.get(cart.supplier_id);
        if (!a || a.status !== 'approved') {
          rejected.push({ supplier_id: cart.supplier_id,
            reason: a?.status === 'suspended' ? '账户已被停单，请联系供应商'
                  : a?.status === 'pending'   ? '开户申请审核中'
                  : '尚未在该供应商开户' });
          continue;
        }

        const supRows = await sb('GET', 'suppliers',
          `supplier_id=eq.${cart.supplier_id}&active=eq.true&select=*`);
        const sup = supRows[0];
        if (!sup || !inRange(sup, store)) {
          rejected.push({ supplier_id: cart.supplier_id, reason: '供应商暂停服务本区域' });
          continue;
        }

        const skus = (cart.items || []).map(i => i.sku).filter(Boolean);
        if (!skus.length) continue;

        const priced = await sb('GET', 'supplier_products',
          `supplier_id=eq.${cart.supplier_id}&sku=in.(${skus.join(',')})&active=eq.true` +
          `&select=sku,case_price,units_per_case,moq,stock_status,products(name_zh,spec)`);
        const pMap = new Map(priced.map(p => [p.sku, p]));

        const lines = [];
        for (const it of cart.items) {
          const p = pMap.get(it.sku);
          if (!p) { rejected.push({ sku: it.sku, reason: '该供应商已下架此商品' }); continue; }
          if (p.stock_status === 'out') { rejected.push({ sku: it.sku, reason: '缺货' }); continue; }
          let cases = Math.floor(Number(it.cases) || 0);
          if (cases <= 0) continue;
          if (cases < (p.moq || 1)) cases = p.moq;      // 自动补足起订量
          lines.push({
            sku: it.sku,
            name_zh: p.products?.name_zh || it.sku,
            spec   : p.products?.spec || null,
            cases,
            units_per_case: p.units_per_case,
            case_price    : Number(p.case_price),
            line_total    : Number((cases * Number(p.case_price)).toFixed(2)),
          });
        }
        if (!lines.length) continue;

        const subtotal = Number(lines.reduce((s, l) => s + l.line_total, 0).toFixed(2));

        if (Number(sup.min_order) > 0 && subtotal < Number(sup.min_order)) {
          rejected.push({ supplier_id: sup.supplier_id,
            reason: `未达起送金额 $${Number(sup.min_order).toFixed(2)}（当前 $${subtotal.toFixed(2)}）` });
          continue;
        }

        // ★ 账期额度：未结清金额 + 本单 不得超限
        if (a.credit_limit != null) {
          const open = await sb('GET', 'purchase_orders',
            `store_id=eq.${storeId}&supplier_id=eq.${sup.supplier_id}` +
            `&status=in.(submitted,confirmed,shipped,received)&select=total`);
          const owed = open.reduce((s, o) => s + Number(o.total || 0), 0);
          if (owed + subtotal > Number(a.credit_limit)) {
            rejected.push({ supplier_id: sup.supplier_id,
              reason: `超出账期额度 $${Number(a.credit_limit).toFixed(2)}（未结 $${owed.toFixed(2)}），请先结款` });
            continue;
          }
        }

        const freeAt = sup.free_delivery_threshold;
        const fee = (freeAt != null && subtotal >= Number(freeAt)) ? 0 : Number(sup.delivery_fee || 0);

        const eta = new Date();
        eta.setDate(eta.getDate() + (sup.lead_time_days || 3));

        const rows = await sb('POST', 'purchase_orders', null, [{
          po_number    : poNumber(storeId),
          store_id     : storeId,
          supplier_id  : sup.supplier_id,
          status       : 'submitted',
          items        : lines,
          subtotal,
          delivery_fee : fee,
          total        : Number((subtotal + fee).toFixed(2)),
          store_note   : cart.note || null,
          expected_date: eta.toISOString().slice(0, 10),
        }]);
        created.push(rows[0]);
      }

      if (!created.length)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '无有效补货单', rejected }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, created, rejected }) };
    }

    // ═══ 5. 我的补货单 ═════════════════════════════════════════════
    if (action === 'GET_MY_POS') {
      const pos = await sb('GET', 'purchase_orders',
        `store_id=eq.${storeId}&order=created_at.desc&limit=60` +
        `&select=*,suppliers(name_zh,name_en,phone,contact_name)`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, pos }) };
    }

    // ═══ 6. 取消 / 确认收货 ════════════════════════════════════════
    if (action === 'CANCEL_PO' || action === 'RECEIVE_PO') {
      const { poId } = payload;
      const want = action === 'CANCEL_PO' ? 'cancelled' : 'received';
      const from = action === 'CANCEL_PO' ? 'submitted' : 'shipped';
      const upd = await sb('PATCH', 'purchase_orders',
        `id=eq.${poId}&store_id=eq.${storeId}&status=eq.${from}`,
        { status: want, updated_at: new Date().toISOString() });
      if (!upd.length)
        return { statusCode: 409, headers: CORS, body: JSON.stringify({
          error: action === 'CANCEL_PO' ? '供应商已确认，无法取消，请电话联系' : '该单尚未发货' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, po: upd[0] }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '未知操作' }) };

  } catch (e) {
    console.error('restock error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
