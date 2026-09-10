// netlify/functions/sign-agreement.js
// 在线签约：勾选同意 = 电子签字。记录签署信息（含 IP / 时间 / UA），
// 写入 Supabase signed_agreements 表，并通过 Resend 把已签署协议邮件发给客户 + 销售。
//
// 环境变量（你项目里已有）：SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY

const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

// ── Google Drive（服务账号）配置 ──────────────────────────────
const crypto = require('crypto');
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GDRIVE_FOLDER_ID    = process.env.GDRIVE_FOLDER_ID;

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

// ── 用于归档/PDF 的完整合同文档 HTML（语义清晰，便于 Google Doc 转换）──
function buildDocHtml(d){
  const when = new Date(d.signed_at).toLocaleString('zh-CN', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit'
  });
  const fee = Number(d.monthly_fee).toFixed(2);
  return `<html><head><meta charset="utf-8"></head><body style="font-family:'Noto Sans SC',Arial,sans-serif;color:#222;line-height:1.6;">
  <h1 style="text-align:center;color:#1A4A28;">平台服务协议 Platform Service Agreement</h1>
  <p style="text-align:center;color:#666;">Sorghuman Holding LLC · 高仁控股国际有限公司</p>
  <p style="text-align:center;color:#666;">协议编号 Agreement No. <b>${esc(d.agreement_id)}</b></p>
  <hr>
  <h3>协议双方 Parties</h3>
  <p>本协议由 <b>Sorghuman Holding LLC</b>（高仁控股国际有限公司，"平台方/Provider"）与
  <b>${esc(d.legal_name)}</b>（"商户/Merchant"，经营店铺 <b>${esc(d.store_name)}</b>）签订。</p>

  <h3>一、服务内容 Services</h3>
  <p>平台方为商户提供独立品牌在线商城（白标电商平台），含：独立域名店铺与商品目录、后台商品/价格/促销管理、订单管理、配送范围与免运费门槛设置、顾客/门店/配送员三方短信通知。</p>

  <h3>二、费用 Fees</h3>
  <ul>
    <li>所选套餐 Plan：<b>${esc(d.plan_name)}</b></li>
    <li>每月平台服务费 Monthly platform fee：<b>$${fee}</b></li>
    <li>支付处理费 Payment processing：3.5% + $0.30 / 笔（支付通道实际成本）</li>
    <li>平台佣金 Commission（2026–2027）：$0 零佣金</li>
  </ul>
  <p style="color:#666;">门店面积与单品数对应不同档位时，以较高档位为准。</p>

  <h3>三、期限与终止 Term &amp; termination</h3>
  <p>自签署日起按月自动续订；任一方可提前三十（30）日书面（含电子邮件）通知终止。</p>

  <h3>四、数据与隐私 Data &amp; privacy</h3>
  <p>商户的商品、订单与顾客数据归商户所有；平台方仅为提供本服务目的处理，不向第三方出售。</p>

  <h3>五、电子签署 Electronic signature</h3>
  <p>勾选同意并提交即构成《电子签名法》(ESIGN/UETA) 下具有法律效力的签署，与手写签名同等效力。</p>

  <hr>
  <h3>签署 Executed</h3>
  <p style="font-size:22px;color:#1A4A28;"><b>${esc(d.signatory_name)}</b></p>
  <p style="color:#555;">
    代表 on behalf of ${esc(d.legal_name)}<br>
    联系人 Contact：${esc(d.contact_name)} · ${esc(d.email)}${d.phone?(' · '+esc(d.phone)):''}<br>
    ${d.address?('地址 Address：'+esc(d.address)+'<br>'):''}
    签署时间 Signed at：${when} (ET)<br>
    IP：${esc(d.ip)} · 版本 Version：${esc(d.agreement_version)}
  </p>
  </body></html>`;
}

// ── Google 服务账号取 access_token（手签 JWT，零依赖）────────────
function b64url(buf){
  return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
async function getGoogleToken(){
  const now = Math.floor(Date.now()/1000);
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss  : GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/drive',
    aud  : 'https://oauth2.googleapis.com/token',
    iat  : now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(GOOGLE_PRIVATE_KEY));
  const jwt = `${header}.${claim}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method : 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Google token: ' + JSON.stringify(j));
  return j.access_token;
}

// ── 归档：HTML→Google Doc→导出 PDF→PDF 存回 Drive→删临时 Doc ──
// 返回 { pdfBase64, webViewLink } 或 null（任何缺配置/出错都返回 null，不影响签署）
async function archiveToDrive(name, html){
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GDRIVE_FOLDER_ID) return null;
  try {
    const token = await getGoogleToken();
    const auth  = { 'Authorization': `Bearer ${token}` };
    const bd    = 'sh-' + Date.now();

    // 1) 上传 HTML 并转换为 Google Doc
    const docBody =
      `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, mimeType:'application/vnd.google-apps.document', parents:[GDRIVE_FOLDER_ID] }) +
      `\r\n--${bd}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${bd}--`;
    const docRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
      { method:'POST', headers:{ ...auth, 'Content-Type':`multipart/related; boundary=${bd}` }, body: docBody });
    const doc = await docRes.json();
    if (!doc.id) throw new Error('create doc: ' + JSON.stringify(doc));

    // 2) 导出为 PDF
    const pdfRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=application/pdf`,
      { headers: auth });
    if (!pdfRes.ok) throw new Error('export pdf: ' + pdfRes.status);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());

    // 3) 把 PDF 传回 Drive 同一文件夹
    const pre = Buffer.from(
      `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: name + '.pdf', parents:[GDRIVE_FOLDER_ID] }) +
      `\r\n--${bd}\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8');
    const post = Buffer.from(`\r\n--${bd}--`, 'utf8');
    const upRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
      { method:'POST', headers:{ ...auth, 'Content-Type':`multipart/related; boundary=${bd}` },
        body: Buffer.concat([pre, pdfBuf, post]) });
    const up = await upRes.json();

    // 4) 删除临时 Google Doc（只保留 PDF）
    await fetch(`https://www.googleapis.com/drive/v3/files/${doc.id}?supportsAllDrives=true`,
      { method:'DELETE', headers: auth }).catch(()=>{});

    return { pdfBase64: pdfBuf.toString('base64'), webViewLink: up.webViewLink || null };
  } catch (e) {
    console.error('archiveToDrive error:', e.message);
    return null;
  }
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

  // ── 生成 PDF + 归档 Google Drive，再发邮件（均不影响签署成功）──
  let driveLink = null;
  try {
    const docName  = `平台服务协议_${record.agreement_id}_${store_name}`.replace(/[\/\\?%*:|"<>]/g,'_');
    const archive  = await archiveToDrive(docName, buildDocHtml(record));
    if (archive) driveLink = archive.webViewLink;

    const emailPayload = {
      from   : '平台服务协议 Agreement <noreply@sorghuman.com>',
      to     : [email],
      cc     : ['sales@sorghuman.com'],
      subject: `已签署 · 平台服务协议 ${record.agreement_id} · ${store_name}`,
      html   : buildEmailHtml(record),
    };
    if (archive && archive.pdfBase64) {
      emailPayload.attachments = [{ filename: docName + '.pdf', content: archive.pdfBase64 }];
    }

    await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify(emailPayload),
    });

    if (driveLink) {
      await fetch(`${SUPA_URL}/rest/v1/signed_agreements?agreement_id=eq.${record.agreement_id}`, {
        method : 'PATCH',
        headers: { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}`, 'Content-Type':'application/json', 'Prefer':'return=minimal' },
        body   : JSON.stringify({ pdf_url: driveLink }),
      }).catch(()=>{});
    }
  } catch (e) {
    console.error('archive/email error:', e.message);
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
