// Retail -single SKUs inherit only a missing image from their exact case SKU.
// Do not copy prices, availability, descriptions, or another product's image.
exports.inheritMissingImages = async function (products, readProducts) {
  const parents = [...new Set(products.filter(p => !String(p.image_url || '').trim() &&
    typeof p.sku === 'string' && p.sku.endsWith('-single') && p.sku.length > 7)
    .map(p => p.sku.slice(0, -7)))];
  if (!parents.length) return products;
  const images = new Map();
  for (let offset = 0; offset < parents.length; offset += 50) {
    const values = parents.slice(offset, offset + 50).map(sku =>
      '"' + sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
    const rows = await readProducts('sku=in.' + encodeURIComponent('(' + values + ')') + '&select=sku,image_url');
    for (const row of rows) if (row.image_url) images.set(row.sku, row.image_url);
  }
  return products.map(p => String(p.image_url || '').trim() || typeof p.sku !== 'string' || !p.sku.endsWith('-single') ? p : {
    ...p, image_url: images.get(p.sku.slice(0, -7)) || p.image_url || null
  });
};
