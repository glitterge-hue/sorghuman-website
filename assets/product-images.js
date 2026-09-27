/* Cache public product images on our existing Netlify host, at display sizes.
 * Keep the allowlist in sync with netlify.toml. Never proxy signed/private URLs.
 */
(function (root) {
  'use strict';
  var origin = 'https://uvvdyqmuxiupgyerxbep.supabase.co';
  root.productImageUrl = function (source, width) {
    if (!source) return '';
    var url;
    try { url = new URL(source); } catch (_) { return source; }
    if (url.origin !== origin || url.username || url.password ||
        url.search || url.hash ||
        !url.pathname.startsWith('/storage/v1/object/public/product-photos/')) return source;
    // A few fixed variants keep the CDN cache reusable across pages.
    var size = [160, 640, 960].indexOf(width) !== -1 ? width : 640;
    return '/.netlify/images?url=' + encodeURIComponent(url.href) +
      '&w=' + size + '&fit=contain&q=75';
  };
})(typeof window !== 'undefined' ? window : globalThis);
