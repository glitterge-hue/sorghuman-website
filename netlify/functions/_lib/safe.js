// netlify/functions/_lib/safe.js
// PostgREST 查询参数的安全编码。
//
// 背景：各函数用 service key 直接拼 `store_id=eq.${storeId}`，值里若带 & = , ( ) 等字符，
// 就能改写过滤条件。这里统一编码 / 加引号，保证"用户输入只能是值，不可能变成语法"。
//
// 用法：
//   `store_id=eq.${q(storeId)}`
//   `sku=in.${inList(skus)}`          // 注意：不要再手写括号

const MAX_LEN = 256;

// 单个值 → 已编码字符串（永不抛错：非字符串会转成字符串，超长截断）
function q(v) {
  const s = (v === null || v === undefined) ? '' : String(v).slice(0, MAX_LEN);
  // encodeURIComponent 不转义 ! ' ( ) *，这里一并转义，输出里不留任何 PostgREST 语法字符
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// 数组 → PostgREST in 列表。每项加双引号并转义，再整体 URL 编码。
// 空数组返回 `()`，对应 in.() 不匹配任何行。
function inList(values) {
  const arr = Array.isArray(values) ? values : [];
  const items = arr.map(v => {
    const s = (v === null || v === undefined) ? '' : String(v).slice(0, MAX_LEN);
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return encodeURIComponent('(' + items.join(',') + ')');
}

// HTML 转义（给邮件 / 页面拼接用）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { q, inList, esc };
