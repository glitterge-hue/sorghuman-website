// seed-zhongning-nonfood.js
// ----------------------------------------------------------------------------
// 把「江苏中宁塑业」的 6 款非食品样品（餐盒/包装膜/胶带）写入 Supabase：
//   1) 插入/更新 products 表（active + showcase，可在官网 /products 展示）
//   2) 关联到 store_products 表的 default 门店（可在 sorghuman.com/shop/ 直接下单）
//
// 运行方式（本地，Node 18+ 自带 fetch，无需装依赖）：
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_KEY=sb_secret_xxx \
//   node seed-zhongning-nonfood.js
//
// 重复运行是安全的：已存在的 SKU 会被更新（upsert），不会重复插入。
// 运行前请先在 Supabase SQL Editor 里执行 supabase_migration_nonfood_subscription.sql。
// ----------------------------------------------------------------------------

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error('缺少环境变量 SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// 代表性样品：3款餐盒 + 3款包装材料（源自《中宁产品手册》，规格取自手册文字说明）
// 均标记 subscription_enabled=true —— 餐厅耗材属于持续复购品类，适合按月订阅自动配送。
const PRODUCTS = [
  {
    sku: 'ZN124', name_zh: '一次性餐盒（圆形，带盖）', name_en: 'Round Disposable Meal Box w/ Lid',
    spec: '18.8×15×5.7cm，49只/箱', category: 'mealbox', showcase_category: 'mealbox',
    base_price: 26.90, subscription_price: 24.90,
    description: '圆形一次性餐盒，带盖密封，适合外卖打包。Round disposable meal box with lid, ideal for takeout.',
  },
  {
    sku: 'ZN148', name_zh: '五格分隔餐盒（带盖）', name_en: '5-Compartment Meal Box w/ Lid',
    spec: '43.6g，250只/箱', category: 'mealbox', showcase_category: 'mealbox',
    base_price: 54.90, subscription_price: 49.90,
    description: '五格分隔设计，适合套餐/自助餐分装。5-compartment tray, ideal for combo meals & buffet packaging.',
  },
  {
    sku: 'ZN130', name_zh: '圆形碗（带盖）', name_en: 'Round Bowl w/ Lid',
    spec: '16.3×11.4×9.3cm，300只/箱', category: 'mealbox', showcase_category: 'mealbox',
    base_price: 59.90, subscription_price: 54.90,
    description: '深型圆碗带盖，适合汤类、面食、盖浇饭外带。Deep round bowl with lid, ideal for soups, noodles & rice bowls.',
  },
  {
    sku: 'ZN-FILM-STRETCH', name_zh: '手工缠绕膜', name_en: 'Hand Stretch Wrap Film',
    spec: '高8cm，厚2丝，可用长度300m/卷', category: 'film', showcase_category: 'film',
    base_price: 8.90, subscription_price: 7.90,
    description: '手动缠绕打包膜，用于货盘/箱体固定包装。Hand stretch wrap film for pallet & carton packaging.',
  },
  {
    sku: 'ZN-TAPE-PP', name_zh: 'PP打包带', name_en: 'PP Packing Tape / Strap',
    spec: '宽12mm，厚0.9mm，10kg/卷（可定制颜色/规格）', category: 'tape', showcase_category: 'tape',
    base_price: 19.90, subscription_price: 17.90,
    description: 'PP材质打包带，可定制颜色与规格。PP packing strap, customizable color & size.',
  },
  {
    sku: 'ZN-TAPE-CLOTH', name_zh: '彩色布基胶带', name_en: 'Colored Cloth (Duct) Tape',
    spec: '高7.8cm，可用长度150m/卷', category: 'tape', showcase_category: 'tape',
    base_price: 6.90, subscription_price: 5.90,
    description: '彩色布基胶带，适合封箱/临时标记。Colored cloth duct tape for sealing & marking.',
  },
];

const SUPPLIER_NAME_ZH = '江苏中宁塑业有限公司';
const SUPPLIER_NAME_EN = 'Jiangsu Zhongning Plastic Co., Ltd.';

async function sb(method, table, qs, body) {
  const url = `${SUPA_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    method: method || 'GET',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${table} ${method}: ${res.status} ${t}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function run() {
  console.log(`导入供应商：${SUPPLIER_NAME_ZH} (${SUPPLIER_NAME_EN}) 的 ${PRODUCTS.length} 款非食品样品\n`);

  // 计算 sort_order 起点：接在现有商品之后，避免打乱已有排序
  const existing = await sb('GET', 'products', 'select=sort_order&order=sort_order.desc&limit=1');
  let sortOrder = (existing[0]?.sort_order || 0) + 1;

  for (const p of PRODUCTS) {
    const row = {
      sku: p.sku,
      name_zh: p.name_zh,
      name_en: p.name_en,
      spec: p.spec,
      category: p.category,
      showcase_category: p.showcase_category,
      description: p.description,
      base_price: p.base_price,
      active: true,
      showcase: true,
      product_line: 'non_food',
      subscription_enabled: true,
      subscription_interval: 'month',
      subscription_interval_count: 1,
      subscription_price: p.subscription_price,
      sort_order: sortOrder++,
    };

    // upsert products（按 sku 冲突时更新）
    await sb('POST', 'products', 'on_conflict=sku', row);
    console.log(`✓ products: ${p.sku} — ${p.name_zh} / ${p.name_en}`);

    // 关联到 default 门店（sorghuman.com 直营下单渠道），使其出现在 /shop/
    await sb('POST', 'store_products', 'on_conflict=store_id,sku', {
      store_id: 'default',
      sku: p.sku,
      active: true,
      featured: false,
      sort_order: sortOrder,
    });
    console.log(`  → 已关联到 default 门店（sorghuman.com/shop/）`);
  }

  console.log('\n全部完成。可在以下位置查看：');
  console.log('  官网产品页：https://sorghuman.com/products.html（餐厅耗材 · Non-Food Restaurant Supplies 板块）');
  console.log('  直营下单：  https://sorghuman.com/shop/');
}

run().catch((e) => {
  console.error('导入失败：', e.message);
  process.exit(1);
});
