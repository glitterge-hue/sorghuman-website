// netlify/functions/store-icon.js
// 生成门店 App 图标：主题色底 + 店名首字（白色）。纯 SVG，无需数据库。
// 参数：c=颜色(无#)  t=首字  s=尺寸  m=1 表示 maskable(全出血、字号缩小留安全区)
// 经 _redirects 挂到 /shop/app-icon.svg

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const hex = (p.c || '2A6B3A').replace(/[^0-9a-fA-F]/g, '').slice(0, 6).padEnd(6, '0');
  const color = '#' + hex;
  const t = esc((p.t || 'S').slice(0, 1));
  const maskable = p.m === '1';

  // 512 画布；maskable 全出血无圆角、字号小一点（留安全区），否则圆角
  const rx = maskable ? 0 : 96;
  const fontSize = maskable ? 210 : 270;

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" rx="${rx}" fill="${color}"/>
<text x="256" y="256" text-anchor="middle" dominant-baseline="central"
  font-family="'PingFang SC','Microsoft YaHei','Noto Sans SC','DM Sans',sans-serif"
  font-size="${fontSize}" font-weight="700" fill="#ffffff">${t}</text>
</svg>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    body: svg,
  };
};
