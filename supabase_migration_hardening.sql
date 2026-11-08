-- ============================================================================
-- 加固迁移：令牌哈希 + 失败限速 + 税费字段
-- Hardening migration: token hashing + auth-failure rate limiting + tax column
--
-- 用法：Supabase 控制台 → SQL Editor → 粘贴整段执行（可重复执行，全部幂等）。
--
-- ★ 部署顺序：先跑这份 SQL，再部署新代码。
--   （新代码对"列还没建"做了兼容，不会崩，但哈希/限速/税费要等 SQL 跑完才生效。）
-- ============================================================================

-- ── 1. 令牌哈希 ──────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;

alter table public.stores       add column if not exists admin_token_hash text;
alter table public.distributors add column if not exists admin_token_hash text;

-- 写入/修改 admin_token 时自动同步哈希；置空（撤销令牌）时哈希一并清空。
create or replace function public.sync_admin_token_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.admin_token is null or new.admin_token = '' then
    new.admin_token_hash := null;
  else
    new.admin_token_hash := encode(extensions.digest(new.admin_token, 'sha256'), 'hex');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_admin_token_hash on public.stores;
create trigger trg_sync_admin_token_hash
  before insert or update of admin_token on public.stores
  for each row execute function public.sync_admin_token_hash();

drop trigger if exists trg_sync_admin_token_hash on public.distributors;
create trigger trg_sync_admin_token_hash
  before insert or update of admin_token on public.distributors
  for each row execute function public.sync_admin_token_hash();

-- 回填现有令牌的哈希
update public.stores       set admin_token_hash = encode(extensions.digest(admin_token, 'sha256'), 'hex')
  where admin_token is not null and admin_token <> '' and admin_token_hash is null;
update public.distributors set admin_token_hash = encode(extensions.digest(admin_token, 'sha256'), 'hex')
  where admin_token is not null and admin_token <> '' and admin_token_hash is null;

-- ── 2. 登录失败记录（限速用）──────────────────────────────────────────────────
create table if not exists public.admin_auth_failures (
  id          bigserial primary key,
  scope       text not null,                    -- 哪个接口：store-catalog / store-orders / restock / distributor-portal
  ip          text not null,
  key         text,                             -- 被尝试的 store_id / distributor_id
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_auth_failures_lookup
  on public.admin_auth_failures (scope, ip, created_at desc);
-- 开启 RLS 且不建任何策略：只有 service key（Netlify 函数）能读写，浏览器端（anon / 登录用户）一律不行
alter table public.admin_auth_failures enable row level security;

-- ── 3. 订单税费 ──────────────────────────────────────────────────────────────
alter table public.orders add column if not exists tax numeric not null default 0;

-- 可选：给个别商品单独指定 Stripe 税码（留空 = 按 product_line 的默认规则）
alter table public.products add column if not exists tax_code text;

-- ============================================================================
-- 【可选 · 第二步】清除明文令牌
-- 现在代码已优先使用哈希比对，但 stores / distributors 里的明文 admin_token 还在，
-- 数据库泄露时仍然可被直接使用。确认以下几点后再执行：
--   a) 新代码已部署，店主后台 / 供货商后台都能正常登录（说明哈希比对工作正常）；
--   b) ERP 或其它外部程序没有读取 stores.admin_token / distributors.admin_token
--      （比如用它拼"店主登录链接"）；
--   c) 你已经把每个令牌发给了对应的人（清除后无法再查看，只能重置）。
-- 先关触发器，否则触发器会把哈希也清空：
--
--   alter table public.stores       disable trigger trg_sync_admin_token_hash;
--   alter table public.distributors disable trigger trg_sync_admin_token_hash;
--   update public.stores       set admin_token = null where admin_token_hash is not null;
--   update public.distributors set admin_token = null where admin_token_hash is not null;
--   alter table public.stores       enable trigger trg_sync_admin_token_hash;
--   alter table public.distributors enable trigger trg_sync_admin_token_hash;
--
-- 注意：此后后台"重发令牌"写入的新令牌仍会以明文落库一次（触发器只补哈希、不清明文），
-- 需要时再重复执行上面的清除语句；若想自动清除，可把触发器函数里 else 分支末尾加一行
--   new.admin_token := null;
-- （前提：后台界面只在生成时展示令牌，不再从库里回读，distributors.html 已是这种做法）。
-- ============================================================================
