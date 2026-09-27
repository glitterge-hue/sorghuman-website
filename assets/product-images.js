/* Cache public product images on our existing Netlify host, at display sizes.
 * Keep the allowlist in sync with netlify.toml. Never proxy signed/private URLs.
 *
 * 2026-09 流量事故教训：店铺后台曾用 onerror="this.src=同一个URL" 做回退，
 * 图片解码失败时浏览器会无限重试，3 天刷掉 Supabase 约 400GB 流量。
 * 以后所有商品图一律用 productImgHtml() 生成：走 Netlify 图片 CDN，
 * 失败时最多回退一次到原图，之后停止，绝不循环。
 */
(function (root) {
  'use strict';
  var photoHost = 'uvvdyqmuxiupgyerxbep.supabase.co';
  root.productImageUrl = function (source, width) {
    if (!source) return '';
    var url;
    try { url = new URL(source); } catch (_) { return source; }
    if (url.protocol !== 'https:' || url.host !== photoHost || url.username || url.password ||
        url.search || url.hash ||
        !url.pathname.startsWith('/storage/v1/object/public/product-photos/')) return source;
    // A few fixed variants keep the CDN cache reusable across pages.
    var size = [160, 640, 960].indexOf(width) !== -1 ? width : 640;
    return '/.netlify/images?url=' + encodeURIComponent(url.href) +
      '&w=' + size + '&fit=contain&q=75';
  };

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 图片加载失败：先摘掉 onerror（保证不会再触发），最多换一次原图，然后放弃。
  root.productImgFallback = function (img) {
    img.onerror = null;
    img.removeAttribute('onerror');
    var orig = img.getAttribute('data-orig');
    img.removeAttribute('data-orig');
    if (orig && img.src !== orig && img.getAttribute('src') !== orig) {
      img.src = orig;
    } else {
      img.style.visibility = 'hidden';
    }
  };

  // 生成安全的 <img>：CDN 缩略图 + 懒加载 + 一次性回退。extraAttrs 为调用方写死的 class/style。
  root.productImgHtml = function (source, width, extraAttrs) {
    if (!source) return '';
    var src = root.productImageUrl(source, width);
    return '<img ' + (extraAttrs || '') + ' src="' + escAttr(src) + '"' +
      (src !== source ? ' data-orig="' + escAttr(source) + '"' : '') +
      ' loading="lazy" decoding="async" onerror="productImgFallback(this)">';
  };

  // 上传前统一把图片解码并重新编码为 JPEG：
  // 浏览器解不开的文件（HEIC、损坏文件、改了扩展名的非图片）直接拒绝，不让坏图进库；
  // 同时把超大原图缩到最长边 maxSide，控制体积。
  root.normalizeProductImage = function (file, maxSide, quality) {
    maxSide = maxSide || 1600;
    quality = quality || 0.85;
    var bad = new Error('无法识别这张图片（可能是 HEIC 或文件已损坏），请另存为 JPG/PNG 后再上传');
    return new Promise(function (resolve, reject) {
      if (!file || !file.size) return reject(bad);
      var objUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { URL.revokeObjectURL(objUrl); return reject(bad); }
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); // 透明 PNG 转白底
          ctx.drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(objUrl);
          canvas.toBlob(function (blob) {
            if (!blob || !blob.size) return reject(bad);
            var base = String(file.name || 'photo').replace(/\.[^.]*$/, '') || 'photo';
            resolve(new File([blob], base + '.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', quality);
        } catch (e) { URL.revokeObjectURL(objUrl); reject(bad); }
      };
      img.onerror = function () { URL.revokeObjectURL(objUrl); reject(bad); };
      img.src = objUrl;
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
