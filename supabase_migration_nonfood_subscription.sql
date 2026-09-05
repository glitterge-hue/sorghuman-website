-- ============================================================================
-- 非食品板块 + 订阅购买 —— Supabase 迁移脚本
-- Non-food section + subscription purchase — Supabase migration
--
-- 用法：登录 Supabase 项目 → SQL Editor → 粘贴整段执行。
-- 全部使用 IF NOT EXISTS，重复执行是安全的（不会报错、不会重复添加）。
-- ============================================================================

-- products 表：订阅相关字段
ALTER TABLE products ADD COLUMN IF NOT EXISTS subscription_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subscription_interval text NOT NULL DEFAULT 'month';
ALTER TABLE products ADD COLUMN IF NOT EXISTS subscription_interval_count integer NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS subscription_price numeric;      -- 为空时结账函数按一次性价 92 折自动计算
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_line text NOT NULL DEFAULT 'food';  -- 'food' | 'non_food'（与 ERP 中宁塑业档案的字段同名，便于对照）

-- orders 表：记录订单是一次性购买还是订阅，以及关联的 Stripe 订阅 ID
ALTER TABLE orders ADD COLUMN IF NOT EXISTS purchase_type text NOT NULL DEFAULT 'one_time';   -- 'one_time' | 'subscription'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- 索引：按订阅状态筛选订单时更快（例如做「本月应发订阅货」报表）
CREATE INDEX IF NOT EXISTS idx_orders_purchase_type ON orders(purchase_type);
CREATE INDEX IF NOT EXISTS idx_products_subscription_enabled ON products(subscription_enabled) WHERE subscription_enabled = true;

-- store_products 表：确保 (store_id, sku) 唯一约束存在
-- （seed-zhongning-nonfood.js 用 on_conflict=store_id,sku 做 upsert，需要这个约束）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_products_store_id_sku_key'
  ) THEN
    ALTER TABLE store_products ADD CONSTRAINT store_products_store_id_sku_key UNIQUE (store_id, sku);
  END IF;
END $$;

-- ============================================================================
-- 说明 · Notes
-- ============================================================================
-- 1. 新增分类（category / showcase_category 是自由文本，不需要建表结构即可使用）：
--      mealbox → 一次性餐盒 Disposable Meal Boxes
--      film    → 包装膜 Packaging Film
--      tape    → 打包胶带辅料 Packing Tape & Supplies
--
-- 2. 商品要出现在官网 /products 页面，需要 active=true 且 showcase=true；
--    要出现在 /shop/（sorghuman.com 直营下单）里，需要在 store_products 表中
--    为 store_id='default' 插入一行关联该 SKU。
--    随本迁移附带的 seed-zhongning-nonfood.js 会自动完成这两步。
--
-- 3. 结账逻辑（create-checkout.js）：
--    - 一次性购买：mode='payment'，行为与原来完全一致。
--    - 订阅购买：mode='subscription'，只接受 subscription_enabled=true 的商品，
--      单价取 subscription_price；未设置则自动按一次性价打 92 折。
--      订阅结账不计算配送费（配送方式下单后另行与客户确认）。
-- ============================================================================
