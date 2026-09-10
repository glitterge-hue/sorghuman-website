# 非食品板块 + 订阅购买 · 变更说明

本次改动给官网加了一个「非食品 · 餐厅耗材」板块（一次性餐盒 / 包装膜 / 打包胶带辅料），
产品对应之前给 ERP 建档的 **江苏中宁塑业** 6 款样品；并且在 `/shop/` 直营下单渠道里，
每个支持订阅的商品都可以选「一次性购买」或「按月订阅自动配送」。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `netlify/functions/get-products.js` | 加 `mealbox` / `film` / `tape` 三个分类标签；查询字段加订阅相关列 |
| `netlify/functions/get-catalog.js` | 同上，供 `/shop/` 使用 |
| `netlify/functions/create-checkout.js` | 加 `purchaseType` 参数：`one_time`（原逻辑不变）或 `subscription`（Stripe `mode:'subscription'`，按 `subscription_price` 计费，不计配送费）|
| `netlify/functions/stripe-webhook.js` | 订单表记录 `purchase_type` 和 `stripe_subscription_id` |
| `shop/index.html` | 商品卡片/详情页加「一次性 / 订阅省X%」切换按钮；购物车拆成「一次性购买」「订阅配送」两个独立结账区块（Stripe 一个 Checkout Session 不能混合多个一次性商品和订阅商品，所以分开结账）|
| `products.html` | 分类顺序里加入 `mealbox`/`film`/`tape`；商品卡片显示「📅 可订阅」标签；非食品分组前加一段说明文字 |
| `supabase_migration_nonfood_subscription.sql` | **新文件**，数据库迁移脚本 |
| `seed-zhongning-nonfood.js` | **新文件**，把中宁塑业 6 款样品写入 Supabase 并关联到 sorghuman.com 直营店 |

## 部署步骤

1. **跑数据库迁移**：登录 Supabase 项目 → SQL Editor → 粘贴 `supabase_migration_nonfood_subscription.sql`
   全部内容 → 执行。全部用 `IF NOT EXISTS`，重复执行不会报错。

2. **导入中宁塑业样品数据**（本地跑一次即可，Node 18+ 自带 `fetch`，无需装依赖）：
   ```bash
   SUPABASE_URL=https://你的项目.supabase.co \
   SUPABASE_SERVICE_KEY=sb_secret_xxx \
   node seed-zhongning-nonfood.js
   ```
   这一步是 upsert（按 SKU 去重），重复跑是安全的，跑完会把 6 款商品同时：
   - 写入 `products` 表（`active=true, showcase=true` → 出现在 `/products.html`）
   - 关联进 `store_products` 表的 `default` 门店 → 出现在 `/shop/`（sorghuman.com 直营下单）

3. **正常部署网站**（Netlify 自动构建，或按你平时的流程 push 到 GitHub）。

4. 确认环境变量已有（应该已配置过，无需新增）：`SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、
   `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`。

## 效果

- **`sorghuman.com/products.html`**：滚到最下面会看到新的「餐厅耗材 · Non-Food Restaurant
  Supplies」分组，含一次性餐盒、包装膜、打包胶带三个子分类，卡片上标注是否支持订阅。
- **`sorghuman.com/shop/`**：品类标签栏多了 🍱一次性餐盒 / 🧻包装膜 / 📦打包耗材 三个金色（区别于
  食品的绿色）标签。点开支持订阅的商品，会看到「一次性 One-time / 📅订阅省X% Subscribe」切换按钮，
  切换后价格跟着变。购物车里，一次性商品和订阅商品分两块显示，各自有独立的结账按钮
  （因为 Stripe 一次结账只能是一种模式，不能把普通购买和自动续订混在一张账单里）。

## 后续可以再做的

- 目前订阅价默认是一次性价的 92 折（未在 `subscription_price` 里单独设置时）；如果要不同商品用
  不同折扣，直接在 Supabase `products` 表里改 `subscription_price` 即可，前端和结账都会自动跟着变。
- 目前订阅结账不计配送费（假设走批量物流单独安排）。如果之后想按固定运费/首月免运费之类的规则收，
  需要在 `create-checkout.js` 里加逻辑。
- 中宁塑业目前只是示范性地导入了产品手册里的 6 款代表产品；如果要把两份 PDF 里全部型号建档，
  可以照着 `seed-zhongning-nonfood.js` 的格式继续加。
