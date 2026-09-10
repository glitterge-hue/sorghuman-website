-- ============================================================================
-- 单件 / 整箱购买 —— Supabase 迁移脚本
-- Single-item / whole-case purchase — Supabase migration
--
-- 用法：登录 Supabase 项目 → SQL Editor → 粘贴整段执行。
-- 全部使用 IF NOT EXISTS，重复执行是安全的（不会报错、不会重复添加）。
-- ============================================================================

-- products 表：装箱数（选填）。填写后 base_price 代表单件价格，
-- 网站会同时提供"单件购买"与"整箱购买"，整箱价 = base_price × units_per_case × 0.95
-- （统一95折，适用于所有门店，见 create-checkout.js / get-catalog.js / shop/index.html）。
-- 与 ERP 里 erp_products.units_per_case（装箱数）同名，方便与 ERP 数据对照/同步。
ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_case integer;

-- ============================================================================
-- 说明 · Notes
-- ============================================================================
-- 1. units_per_case 为空/为1：商品在网站上保持原样，只能整份购买，不受影响。
--
-- 2. units_per_case > 1：商品同时支持：
--      · "单件"购买：单价 = base_price（不打折）
--      · "整箱"购买：单价 = base_price × units_per_case × 0.95（自动95折）
--    两种价格均由服务端（create-checkout.js）用 products 表当前数据重新计算，
--    不信任前端传来的价格；折扣比例统一为95折，不支持按门店单独调整
--    （店铺可以有各自的 base_price/markup 覆盖，但95折比例本身固定统一）。
--
-- 3. 该字段通常由 ERP 的"商品 → 同步到官网"功能写入（见 sorghuman-erp 的
--    /products/sync-to-website 路由），也可以在 manage/products.html 里手动维护
--    没有对应 ERP 商品的网站自建 SKU。
-- ============================================================================
