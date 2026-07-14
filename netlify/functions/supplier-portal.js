// netlify/functions/supplier-portal.js
// 供应商后台 API —— 与 store-catalog.js 完全同构，只是主体换成 suppliers
// 供应商能做：选品、定箱价、设起送/服务范围、看补货单、确认/发货

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

async function verifySupplier(supplierId, token) {
  if (!supplierId || !token) return null;
  const rows = await sb('GET', 'suppliers',
    `supplier_id=eq.${supplierId}&admin_token=eq.${token}&active=eq.true&select=*`);
  if (!rows[0]) return null;
  const { admin_token, ...safe } = rows[0];
  return safe;
}

const num = v => (v === '' || v === null || v === undefined) ? null : Number(v);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const p = JSON.parse(event.body || '{}');
    const { action, supplierId, token } = p;

    const sup = await verifySupplier(supplierId, token);
    if (!sup)
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '令牌无效 / Invalid token' }) };

    // ── 我的供货商品 ────────────────────────────────────────────
    if (action === 'GET_MY_ITEMS') {
      const items = await sb('GET', 'supplier_products',
        `supplier_id=eq.${supplierId}` +
        `&select=sku,case_price,units_per_case,moq,stock_status,note,active,` +
        `products(name_zh,name_en,spec,category,base_price,image_url)`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, supplier: sup, items }) };
    }

    // ── 总商品库（选品用）──────────────────────────────────────
    if (action === 'GET_ALL_PRODUCTS') {
      const products = await sb('GET', 'products',
        `active=eq.true&select=sku,name_zh,name_en,spec,category,base_price,image_url&order=sort_order.asc`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, products }) };
    }

    // ── 上架 / 改价（upsert）────────────────────────────────────
    if (action === 'SAVE_ITEMS') {
      const rows = (p.items || []).filter(i => i.sku && Number(i.case_price) > 0).map(i => ({
        supplier_id    : supplierId,
        sku            : i.sku,
        case_price     : Number(i.case_price),
        units_per_case : Math.max(1, parseInt(i.units_per_case) || 1),
        moq            : Math.max(1, parseInt(i.moq) || 1),
        stock_status   : ['in_stock','low','out'].includes(i.stock_status) ? i.stock_status : 'in_stock',
        note           : i.note || null,
        active         : i.active !== false,
        updated_at     : new Date().toISOString(),
      }));
      if (rows.length) await sb('POST', 'supplier_products', null, rows);   // merge-duplicates = upsert

      const rm = p.remove || [];
      if (rm.length) {
        await fetch(`${SUPA_URL}/rest/v1/supplier_products?supplier_id=eq.${supplierId}&sku=in.(${rm.join(',')})`,
          { method: 'DELETE', headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, saved: rows.length }) };
    }

    // ── 供应商上新品到总库（进口商推新品给全网门店）───────────────
    if (action === 'ADD_NEW_PRODUCT') {
      const { sku, name_zh, name_en, spec, category, base_price, image_url,
              case_price, units_per_case, moq } = p;
      if (!sku || !name_zh || !case_price)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '缺少必填字段' }) };

      await sb('POST', 'products', null, [{
        sku, name_zh, name_en: name_en || '', spec: spec || null,
        category: category || 'grocery',
        base_price: Number(base_price) || Number(case_price) / (parseInt(units_per_case) || 1) * 1.8, // 无建议零售价时按 1.8 倍成本兜底
        image_url: image_url || null,
        common: true,          // 供应商上的品 = 公共品，任何门店都能选
        active: true,
      }]);
      await sb('POST', 'supplier_products', null, [{
        supplier_id: supplierId, sku,
        case_price: Number(case_price),
        units_per_case: Math.max(1, parseInt(units_per_case) || 1),
        moq: Math.max(1, parseInt(moq) || 1),
        active: true,
      }]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ── 交易条件 / 服务范围 ─────────────────────────────────────
    if (action === 'SAVE_PROFILE') {
      const patch = {};
      ['min_order','delivery_fee','free_delivery_threshold','lead_time_days'].forEach(k => {
        if (p[k] !== undefined) patch[k] = num(p[k]);
      });
      ['payment_terms','contact_name','phone','email'].forEach(k => {
        if (p[k] !== undefined) patch[k] = p[k] || null;
      });
      ['service_zips','service_states','delivery_days'].forEach(k => {
        if (Array.isArray(p[k])) patch[k] = p[k];
      });
      if (!Object.keys(patch).length)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '无可保存字段' }) };

      await sb('PATCH', 'suppliers', `supplier_id=eq.${supplierId}`, patch);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ══ 门店开户审核 ═══════════════════════════════════════════
    // 列出申请我这里开户的门店（含待审 / 已开 / 已停）
    if (action === 'GET_STORE_ACCOUNTS') {
      const rows = await sb('GET', 'store_suppliers',
        `supplier_id=eq.${supplierId}&order=applied_at.desc` +
        `&select=*,stores(name_zh,name_en,address,city,state,zip,contact_name,contact_phone,domain)`);

      // 每家店的未结金额（帮你判断要不要继续放账）
      const owedRows = await sb('GET', 'purchase_orders',
        `supplier_id=eq.${supplierId}&status=in.(submitted,confirmed,shipped,received)&select=store_id,total`);
      const owed = {};
      owedRows.forEach(o => { owed[o.store_id] = (owed[o.store_id] || 0) + Number(o.total || 0); });

      const accounts = rows.map(r => ({ ...r, open_amount: Number((owed[r.store_id] || 0).toFixed(2)) }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, accounts }) };
    }

    // 批准 / 拒绝 / 停单，并给这家店定专属条件
    if (action === 'REVIEW_STORE') {
      const { store_id, status, payment_terms, credit_limit, supplier_note } = p;
      if (!store_id || !['approved','rejected','suspended'].includes(status))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '参数无效' }) };

      const patch = { status, reviewed_at: new Date().toISOString() };
      if (payment_terms !== undefined) patch.payment_terms = payment_terms || null;
      if (credit_limit  !== undefined) patch.credit_limit  = num(credit_limit);
      if (supplier_note !== undefined) patch.supplier_note = supplier_note || null;

      // 供应商也可以主动给一家从没申请过的店开户（比如线下已经在供货的老客户）
      const exist = await sb('GET', 'store_suppliers',
        `supplier_id=eq.${supplierId}&store_id=eq.${store_id}&select=store_id`);
      if (exist.length) {
        await sb('PATCH', 'store_suppliers',
          `supplier_id=eq.${supplierId}&store_id=eq.${store_id}`, patch);
      } else {
        await sb('POST', 'store_suppliers', null,
          [{ supplier_id: supplierId, store_id, ...patch }]);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // 可开户的门店名单（服务范围内、还没建立关系的）
    if (action === 'GET_INVITABLE_STORES') {
      const stores = await sb('GET', 'stores',
        `select=store_id,name_zh,name_en,city,state,zip`);
      const rel = await sb('GET', 'store_suppliers',
        `supplier_id=eq.${supplierId}&select=store_id`);
      const have = new Set(rel.map(r => r.store_id));
      const zips   = Array.isArray(sup.service_zips)   ? sup.service_zips   : [];
      const states = Array.isArray(sup.service_states) ? sup.service_states : [];
      const list = stores.filter(s => {
        if (have.has(s.store_id)) return false;
        if (!zips.length && !states.length) return true;
        if (zips.length   && s.zip   && zips.includes(String(s.zip)))   return true;
        if (states.length && s.state && states.includes(String(s.state).toUpperCase())) return true;
        return false;
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stores: list }) };
    }

    // ── 收到的补货单（带门店收货信息）────────────────────────────
    // since=ISO 时间 → 增量；unsynced=true → 只取 ERP 还没导过的（给 Sorghuman 自己的 ERP 用）
    if (action === 'GET_POS') {
      let qs = `supplier_id=eq.${supplierId}&order=created_at.desc&limit=200` +
               `&select=*,stores(name_zh,name_en,address,city,state,zip,contact_name,contact_phone)`;
      if (p.since)    qs += `&created_at=gte.${p.since}`;
      if (p.unsynced) qs += `&erp_synced_at=is.null`;
      const pos = await sb('GET', 'purchase_orders', qs);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, pos }) };
    }

    // ── ERP 导入后回标，防止重复导单 ─────────────────────────────
    if (action === 'MARK_SYNCED') {
      const ids = (p.poIds || []).filter(Boolean);
      if (!ids.length)
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '缺少 poIds' }) };
      await sb('PATCH', 'purchase_orders',
        `supplier_id=eq.${supplierId}&id=in.(${ids.join(',')})`,
        { erp_synced_at: new Date().toISOString() });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, synced: ids.length }) };
    }

    // ── 确认 / 发货 / 拒单 ──────────────────────────────────────
    if (action === 'UPDATE_PO') {
      const { poId, status, supplier_note, expected_date } = p;
      const flow = { confirmed: 'submitted', shipped: 'confirmed', cancelled: null };
      if (!(status in flow))
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '状态无效' }) };

      const patch = { status, updated_at: new Date().toISOString() };
      if (supplier_note !== undefined) patch.supplier_note = supplier_note || null;
      if (expected_date) patch.expected_date = expected_date;

      let qs = `id=eq.${poId}&supplier_id=eq.${supplierId}`;
      if (flow[status]) qs += `&status=eq.${flow[status]}`;                       // 不能跳状态
      else qs += `&status=in.(submitted,confirmed)`;                              // 已发货的不能取消

      const upd = await sb('PATCH', 'purchase_orders', qs, patch);
      if (!upd.length)
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '订单状态已变更，请刷新' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, po: upd[0] }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '未知操作' }) };

  } catch (e) {
    console.error('supplier-portal error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
