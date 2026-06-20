// netlify/functions/sign-agreement.js
// 在线签约：勾选同意 = 电子签字。记录签署信息（含 IP / 时间 / UA），
// 写入 Supabase signed_agreements 表，并通过 Resend 把已签署协议邮件发给客户 + 销售。
//
// 环境变量（你项目里已有）：SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY

const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

// 协议版本与商务条款（以服务端为准，客户端仅作展示，防篡改）
const AGREEMENT_VERSION = '2026-v1';

// 三档套餐 —— 价格以此为准（服务端权威，忽略客户端传来的金额，防篡改）
const PLANS = {
  basic   : { id:'basic',    name:'基础门店 Basic',    price:299 },
  standard: { id:'standard', name:'标准门店 Standard', price:399 },
  large   : { id:'large',    name:'大型门店 Large',    price:499 },
};

const TERMS = {
  processing_pct: 3.5,        // 支付处理费 %
  processing_fix: 0.30,       // 支付处理费 固定
  commission    : 0,          // 佣金（2026–2027 零佣金）
};

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type'                : 'application/json',
};

function esc(s){ return String(s||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
function isEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'')); }

// 生成协议编号：SH-AGR-YYYYMMDD-XXXXX
function makeAgreementId(){
  const d = new Date();
  const ymd = d.getUTCFullYear().toString()
            + String(d.getUTCMonth()+1).padStart(2,'0')
            + String(d.getUTCDate()).padStart(2,'0');
  const rand = Math.random().toString(36).slice(2,7).toUpperCase();
  return `SH-AGR-${ymd}-${rand}`;
}

// 已签署协议的邮件 HTML（绿/金品牌风格）
function buildEmailHtml(d){
  const feeLine = `套餐 ${esc(d.plan_name)}：每月平台服务费 $${Number(d.monthly_fee).toFixed(2)}；`
    + `支付处理费 ${TERMS.processing_pct}% + $${TERMS.processing_fix.toFixed(2)} / 笔；`
    + `2026–2027 年零佣金。`;
  const signedAtET = new Date(d.signed_at).toLocaleString('zh-CN', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit'
  });
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"></head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;"><tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:620px;width:100%;">
  <tr><td style="background:#1A4A28;padding:22px 32px;">
    <div style="color:#F0C060;font-size:13px;font-weight:700;letter-spacing:.1em;">平台服务协议 PLATFORM SERVICE AGREEMENT</div>
    <div style="color:rgba(255,255,255,.7);font-size:11px;margin-top:4px;">Sorghuman Holding LLC · 高仁控股国际有限公司</div>
  </td></tr>
  <tr><td style="padding:24px 32px 8px;">
    <div style="font-size:20px;font-weight:700;color:#1A4A28;">✓ 协议已签署 Agreement Executed</div>
    <div style="color:#888;font-size:13px;margin-top:6px;">协议编号 Agreement No. <b style="font-family:monospace;color:#1A4A28;">${esc(d.agreement_id)}</b></div>
  </td></tr>
  <tr><td style="padding:8px 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f5;border-radius:6px;overflow:hidden;font-size:13px;">
      ${[
        ['店铺名 Store', d.store_name],
        ['法定名称 Legal Entity', d.legal_name],
        ['联系人 Contact', d.contact_name],
        ['电子邮件 Email', d.email],
        ['联系电话 Phone', d.phone || '—'],
        ['营业地址 Address', d.address || '—'],
      ].map(([k,v],i)=>`<tr${i?' style="border-top:1px solid #eee;"':''}>
        <td style="padding:9px 16px;color:#888;width:160px;">${k}</td>
        <td style="padding:9px 16px;font-weight:600;">${esc(v)}</td></tr>`).join('')}
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 16px;">
    <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:6px;">商务条款 Commercial Terms</div>
    <div style="font-size:13px;color:#444;line-height:1.7;background:#fff;border:1px solid #eee;border-radius:6px;padding:12px 14px;">${feeLine}</div>
  </td></tr>
  <tr><td style="padding:0 32px 24px;">
    <div style="border:1px dashed #ccc;border-radius:6px;padding:14px 16px;">
      <div style="font-size:12px;color:#888;">电子签署 Electronically signed by</div>
      <div style="font-size:18px;color:#1A4A28;font-weight:700;margin:2px 0 6px;">${esc(d.signatory_name)}</div>
      <div style="font-size:12px;color:#888;line-height:1.6;">
        代表 on behalf of ${esc(d.legal_name)}<br>
        时间 Signed at：${signedAtET} (ET)<br>
        IP：${esc(d.ip)} · 版本 Version：${esc(d.agreement_version)}
      </div>
    </div>
  </td></tr>
  <tr><td style="background:#f8f8f5;padding:16px 32px;border-top:1px solid #eee;">
    <div style="font-size:11px;color:#aaa;text-align:center;line-height:1.6;">
      勾选同意并提交即构成《电子签名》(ESIGN/UETA) 下的有效签署。<br>
      Checking the box and submitting constitutes a valid electronic signature.<br>
      Sorghuman Holding LLC · sales@sorghuman.com
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const store_name     = (body.store_name     || '').trim();
  const legal_name     = (body.legal_name     || '').trim();
  const contact_name   = (body.contact_name   || '').trim();
  const email          = (body.email          || '').trim();
  const phone          = (body.phone          || '').trim();
  const address        = (body.address        || '').trim();
  const signatory_name = (body.signatory_name || '').trim();
  const agreed         = body.agreed === true;
  const plan           = PLANS[body.plan] || PLANS.basic;   // 价格以服务端为准

  // ── 校验 ────────────────────────────────────────────────────
  const missing = [];
  if (!store_name)     missing.push('店铺名');
  if (!legal_name)     missing.push('法定名称');
  if (!contact_name)   missing.push('联系人');
  if (!isEmail(email)) missing.push('有效电子邮件');
  if (!signatory_name) missing.push('签字人姓名');
  if (missing.length)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '请完整填写：' + missing.join('、') }) };
  if (!agreed)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '请勾选同意协议条款' }) };

  const ip = event.headers['x-nf-client-connection-ip']
          || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || 'unknown';
  const ua = event.headers['user-agent'] || '';

  const record = {
    agreement_id      : makeAgreementId(),
    store_name, legal_name, contact_name, email, phone, address,
    signatory_name, agreed,
    agreement_version : AGREEMENT_VERSION,
    plan_id           : plan.id,
    plan_name         : plan.name,
    monthly_fee       : plan.price,
    terms_json        : { plan: plan.id, ...TERMS },
    signed_at         : new Date().toISOString(),
    ip, user_agent    : ua,
  };

  // ── 写入 Supabase ───────────────────────────────────────────
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/signed_agreements`, {
      method : 'POST',
      headers: {
        'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('signed_agreements insert failed:', t);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '保存失败，请稍后重试 / Save failed' }) };
    }
  } catch (e) {
    console.error('supabase error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '保存失败 / Save failed' }) };
  }

  // ── 发邮件（客户 + 销售）。邮件失败不影响签署成功 ────────────
  try {
    const html = buildEmailHtml(record);
    await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        from   : '平台服务协议 Agreement <noreply@sorghuman.com>',
        to     : [email],
        cc     : ['sales@sorghuman.com'],
        subject: `已签署 · 平台服务协议 ${record.agreement_id} · ${store_name}`,
        html,
      }),
    });
  } catch (e) {
    console.error('resend error:', e.message);
  }

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({
      ok: true,
      agreement_id: record.agreement_id,
      signed_at   : record.signed_at,
    }),
  };
};
