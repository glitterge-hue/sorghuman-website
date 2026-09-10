// netlify/functions/store-manifest.js
// 按门店动态生成 PWA manifest（白标）——远东顾客装的是"远东"App，
// 名称/主题色/图标都来自该门店在 stores 表里的配置。
// 经 _redirects 挂到 /shop/manifest.webmanifest。

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(table, qs) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

function normColor(c) {
  if (!c) return '#2A6B3A';
  const v = String(c).trim();
  return /^#?[0-9a-fA-F]{6}$/.test(v) ? (v[0] === '#' ? v : '#' + v) : '#2A6B3A';
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const host = (event.headers.host || 'sorghuman.com').replace(/^www\./, '');
  const H = { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=600' };

  // 兜底 manifest（取不到数据时也能装）
  const fallback = {
    name: 'Store', short_name: 'Store', start_url: '/shop/', scope: '/shop/',
    display: 'standalone', background_color: '#ffffff', theme_color: '#2A6B3A',
    icons: [{ src: '/shop/app-icon.svg?c=2A6B3A&t=S&s=512', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };

  try {
    let storeId = p.store;
    if (!storeId) {
      const rows = await sb('stores', `domain=eq.${host}&select=store_id&limit=1`);
      if (rows.length) storeId = rows[0].store_id;
    }
    if (!storeId) storeId = 'default';

    const rows = await sb('stores', `store_id=eq.${storeId}&select=name_zh,name_en,theme&limit=1`);
    const s = rows[0];
    if (!s) return { statusCode: 200, headers: H, body: JSON.stringify(fallback) };

    const name    = (s.name_zh || s.name_en || 'Store').trim();
    const nameEn  = (s.name_en || '').trim();
    const color   = normColor(s.theme);
    const initial = (s.name_zh || s.name_en || 'S').trim().charAt(0);
    const cparam  = color.replace('#', '');
    const storeQ  = p.store ? `&store=${encodeURIComponent(storeId)}` : '';
    const startQ  = p.store ? `?store=${encodeURIComponent(storeId)}` : '';
    const icon = (s, m) =>
      `/shop/app-icon.svg?c=${encodeURIComponent(cparam)}&t=${encodeURIComponent(initial)}&s=${s}${m ? '&m=1' : ''}${storeQ}`;

    const manifest = {
      id: `/shop/${p.store ? '?store=' + encodeURIComponent(storeId) : '#' + storeId}`,
      name: name + (nameEn ? ' · ' + nameEn : ''),
      short_name: name.slice(0, 12),
      description: nameEn ? `${name} · ${nameEn}` : name,
      start_url: `/shop/${startQ}`,
      scope: '/shop/',
      display: 'standalone',
      orientation: 'portrait',
      lang: 'zh',
      background_color: '#ffffff',
      theme_color: color,
      icons: [
        { src: icon(192), sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: icon(512), sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        { src: icon(512), sizes: 'any',     type: 'image/svg+xml', purpose: 'any' },
        { src: icon(512, true), sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
      ],
    };
    return { statusCode: 200, headers: H, body: JSON.stringify(manifest) };
  } catch (e) {
    console.error('store-manifest error:', e.message);
    return { statusCode: 200, headers: H, body: JSON.stringify(fallback) };
  }
};
