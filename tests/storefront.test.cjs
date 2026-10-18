const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const photoHost = 'uvvdyqmuxiupgyerxbep.supabase.co';
const photo = new URL('/storage/v1/object/public/product-photos/quote-import/sample.jpg', `https://${photoHost}`).href;

function page(file, marker, start) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach(code => new vm.Script(code));
  const elements = new Map();
  const listeners = [];
  function element() {
    return { style: {}, disabled: false, innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} };
  }
  for (const m of html.matchAll(/id="([^"]+)"/g)) elements.set(m[1], element());
  const tabs = [element(), element()];
  const context = vm.createContext({ URL, URLSearchParams, console, setTimeout, clearTimeout,
    location: { search: '', origin: 'https://sorghuman.com' },
    document: {
      addEventListener(type, fn) { listeners.push({ type, fn }); },
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll(selector) { return selector === '.cat-tab' ? tabs : []; },
      querySelector() { return element(); }, createElement: element,
      documentElement: { style: { setProperty() {} } }
    }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/product-images.js'), 'utf8'), context);
  vm.runInContext(scripts.find(code => code.includes(marker)).replace(start + '();', ''), context);
  return { context, elements, tabs, listeners };
}

test('outage does not crash, offer demo products or allow checkout; retry recovers', async () => {
  const { context: c, elements, tabs } = page('shop/index.html', 'var CHECKOUT_URL', 'boot');
  c.fetch = async () => ({ ok: false });
  await c.boot();
  assert.equal(c.catalog, null);
  assert.equal(c.store, null);
  assert.match(elements.get('catalogStatus').innerHTML, /temporarily unavailable/);
  assert.ok(tabs.every(t => t.disabled));
  assert.equal(c.collectCart('one_time').length, 0);
  c.setCat('frozen');
  c.onSearch('bun');
  c.submitCheckout([], 'one_time', 'checkoutBtn', 'Checkout');
  let applied = 0;
  c.applyStore = () => applied++;
  c.loadPromo = c.renderProducts = () => {};
  c.fetch = async () => ({ ok: true, json: async () => ({ store: { store_id: 'default' }, products: [] }) });
  await elements.get('retryCatalog').onclick();
  assert.equal(applied, 1);
  assert.equal(c.store.store_id, 'default');
  assert.equal(elements.get('catalogStatus').style.display, 'none');
  assert.ok(tabs.every(t => !t.disabled));
});

test('malformed catalog and network failures remain retryable; store override is encoded', async () => {
  const { context: c, elements } = page('shop/index.html', 'var CHECKOUT_URL', 'boot');
  c.location.search = '?store=foo%26bar';
  let requested;
  c.fetch = async url => { requested = url; return { ok: true, json: async () => ({ store: {}, products: {} }) }; };
  await c.boot();
  assert.equal(requested, '/.netlify/functions/get-catalog?store=foo%26bar');
  assert.equal(c.catalog, null);
  c.fetch = async () => { throw new Error('offline'); };
  await elements.get('retryCatalog').onclick();
  assert.match(elements.get('catalogStatus').innerHTML, /Retry/);
});

test('product directory distinguishes failed, malformed, empty and populated results', async () => {
  const { context: c, elements } = page('products.html', 'var PRODUCTS_API', 'loadProducts');
  const box = elements.get('productSections');
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ error: 'backend failure', products: [] }) },
    { ok: true, json: async () => ({ products: {} }) }
  ]) {
    c.fetch = async () => response;
    await c.loadProducts();
    assert.match(box.innerHTML, /temporarily unavailable/);
    assert.doesNotMatch(box.innerHTML, /No products yet/);
  }
  c.fetch = async () => ({ ok: true, json: async () => ({ products: [] }) });
  await elements.get('retryProducts').onclick();
  assert.match(box.innerHTML, /No products yet/);
  c.fetch = async () => ({ ok: true, json: async () => ({ products: [{ sku: 'A', name_en: 'Bun', image_url: photo }] }) });
  await c.loadProducts();
  assert.match(box.innerHTML, /Bun/);
  assert.match(box.innerHTML, /\.netlify\/images/);
  assert.match(box.innerHTML, /w=640/);
});

test('only allowlisted public photos use stable, bounded CDN variants', () => {
  const { context: c } = page('products.html', 'var PRODUCTS_API', 'loadProducts');
  for (const width of [160, 640, 960]) {
    const optimized = new URL(c.productImageUrl(photo, width), 'https://sorghuman.com');
    assert.equal(optimized.pathname, '/.netlify/images');
    assert.equal(optimized.searchParams.get('url'), photo);
    assert.equal(optimized.searchParams.get('w'), String(width));
  }
  assert.match(c.productImageUrl(photo, 99999), /w=640/);
  for (const url of [photo + '?token=private', photo.replace('/public/', '/sign/'),
    photo.replace('.supabase.co/', '.supabase.co.evil.example/'), '/images/logo.jpg', 'https://other.example/a.jpg']) {
    assert.equal(c.productImageUrl(url, 160), url);
  }
});

test('list, gallery thumbnails and switched hero use appropriate image sizes', () => {
  const { context: c, elements, listeners } = page('shop/index.html', 'var CHECKOUT_URL', 'boot');
  const p = { sku: 'A', name_en: 'Bun', name_zh: '包子', base_price: 5, image_url: photo, gallery: [photo, photo.replace('sample', 'second')] };
  c.store = {};
  assert.match(c.imgTag(p, 'prod-img'), /w=160/);
  assert.match(c.imgTag(p, 'prod-img'), /loading="lazy"/);
  c.renderDetail(p);
  const detail = elements.get('detailBody').innerHTML;
  assert.match(detail, /id="detailHero" src="[^\"]+w=960/);
  assert.match(detail, /class="detail-thumb[^\"]*" src="[^\"]+w=160/);
  const hero = c.document.getElementById('detailHero');
  const target = { closest(selector) { return selector === '[data-swap]' ?
    { getAttribute: () => p.gallery[1], classList: { add() {} } } : null; } };
  listeners.filter(l => l.type === 'click').forEach(l => l.fn({ target }));
  assert.match(hero.src, /w=960/);
  assert.equal(new URL(hero.src, 'https://sorghuman.com').searchParams.get('url'), p.gallery[1]);
});

test('retail images inherit only from exact case SKU and preserve retail data', async () => {
  const { inheritMissingImages } = require('../netlify/functions/_lib/product-images');
  const products = [
    { sku: '4650-single', image_url: null, base_price: 2.50 },
    { sku: 'other-single', image_url: 'own.jpg' },
    { sku: '4650-random', image_url: null },
    { image_url: null }
  ];
  let calls = 0;
  const result = await inheritMissingImages(products, async qs => {
    calls++;
    assert.equal(decodeURIComponent(qs), 'sku=in.("4650")&select=sku,image_url');
    return [{ sku: '4650', image_url: photo }];
  });
  assert.equal(calls, 1);
  assert.equal(result[0].image_url, photo);
  assert.equal(result[0].base_price, 2.50);
  assert.equal(result[1].image_url, 'own.jpg');
  assert.equal(result[2], products[2]);
  assert.equal(result[3], products[3]);
  assert.equal(products[0].image_url, null);
  await inheritMissingImages([products[1]], () => assert.fail('unnecessary lookup'));
});

test('detail purchase controls add one unit and synchronize cart quantity', () => {
  const { context: c, elements } = page('shop/index.html', 'var CHECKOUT_URL', 'boot');
  const p = { sku: '4650-single', name_en: 'Rice shaomai', name_zh: '糯米烧卖', price: 2.50 };
  c.catalog = { products: [p] };
  c.store = {};
  let updates = 0;
  c.updateCart = () => updates++;
  c.renderDetail(p);
  assert.match(elements.get('detailBuy').innerHTML, /data-add-cart="4650-single"/);
  assert.match(elements.get('detailBuy').innerHTML, /data-cart-checkout="4650-single"/);
  c.zipConfirmed = true;
  c.addDetailToCart(p.sku);
  assert.equal(c.qty[p.sku], 1);
  assert.equal(elements.get('dq-' + p.sku).textContent, 1);
  assert.equal(c.zipConfirmed, false);
  c.addDetailToCart(p.sku);
  assert.equal(c.qty[p.sku], 2);
  assert.equal(updates, 2);
  c.addDetailToCart('missing');
  assert.equal(updates, 2);
});
