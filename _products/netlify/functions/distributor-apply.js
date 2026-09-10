// netlify/functions/distributor-apply.js
// 分销商自助入驻（公开接口，无需鉴权）
// 只创建 status='pending' 的记录，不发 token —— 总店批准后才发。

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
      'Prefer'       : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${method}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

// 公司名 → distributor_id（小写、只留字母数字、加随机后缀防撞）
function slug(name) {
  const base = (name || 'supplier').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'supplier';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

const clean = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : null) || null;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const p = JSON.parse(event.body || '{}');

    // ── 必填校验 ────────────────────────────────────────────────
    const required = {
      name_zh     : '公司中文名',
      legal_name  : '法定名称',
      ein         : '联邦税号 EIN',
      biz_address : '营业地址',
      contact_name: '联系人',
      phone       : '电话',
      email       : '邮箱',
    };
    for (const [k, label] of Object.entries(required)) {
      if (!clean(p[k])) 
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `请填写${label}` }) };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email))
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '邮箱格式不正确' }) };

    // ── 防重复：同一个 EIN 只能有一份在途/已批准的申请 ─────────────
    const ein  = clean(p.ein, 20);
    const dupe = await sb('GET', 'distributors',
      `ein=eq.${encodeURIComponent(ein)}&status=in.(pending,approved,suspended)&select=distributor_id,status`);
    if (dupe.length) {
      const s = dupe[0].status;
      return { statusCode: 409, headers: CORS, body: JSON.stringify({
        error: s === 'pending'   ? '该税号已有申请在审核中，请勿重复提交'
             : s === 'suspended' ? '该税号的账户已被停用，请联系 info@sorghuman.com'
             : '该税号已经入驻，请直接登录分销商后台' }) };
    }

    const row = {
      distributor_id : slug(clean(p.name_en) || clean(p.legal_name)),
      status      : 'pending',
      admin_token : null,                       // ★ 批准前不发 token
      active      : false,                      // ★ 批准前门店看不到

      name_zh     : clean(p.name_zh),
      name_en     : clean(p.name_en),
      legal_name  : clean(p.legal_name),
      ein,
      biz_address : clean(p.biz_address, 300),
      food_license: clean(p.food_license, 60),
      coi_expiry  : /^\d{4}-\d{2}-\d{2}$/.test(p.coi_expiry || '') ? p.coi_expiry : null,
      website     : clean(p.website),

      type        : ['distributor','importer','manufacturer'].includes(p.type) ? p.type : 'distributor',
      contact_name: clean(p.contact_name, 60),
      phone       : clean(p.phone, 30),
      email       : clean(p.email, 120),

      categories    : Array.isArray(p.categories)     ? p.categories.slice(0, 12)     : [],
      service_states: Array.isArray(p.service_states) ? p.service_states.slice(0, 60).map(s => String(s).toUpperCase()) : [],
      service_zips  : Array.isArray(p.service_zips)   ? p.service_zips.slice(0, 300)  : [],
      docs          : (p.docs && typeof p.docs === 'object') ? p.docs : {},

      apply_note  : clean(p.apply_note, 1000),
      applied_at  : new Date().toISOString(),
    };

    const created = await sb('POST', 'distributors', null, [row]);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      distributor_id: created[0]?.distributor_id,
      message: '申请已提交。我们会在 2 个工作日内核验资质并邮件通知您。',
    }) };

  } catch (e) {
    console.error('distributor-apply error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '提交失败，请稍后重试或邮件 info@sorghuman.com' }) };
  }
};
