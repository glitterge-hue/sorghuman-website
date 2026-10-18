-- 后台管理员白名单
-- 之前所有后台表的策略都是「任何登录用户 = 全部读写」，而 Supabase 开着公开注册，
-- 外人自己注册一个账号就能读写全部数据。改为：只有 admin_users 名单里的邮箱才能读写。
-- Netlify 函数和 ERP 用 service key，绕过 RLS，不受影响。

create table if not exists public.admin_users (
  email      text primary key,
  note       text,
  added_at   timestamptz not null default now()
);
alter table public.admin_users enable row level security;

insert into public.admin_users (email, note)
values ('glitter.ge@sorghuman.com', '创始管理员')
on conflict (email) do nothing;

-- 当前登录用户是否在白名单里（邮箱必须已验证）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.admin_users a on lower(a.email) = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 管理员可以查看/增删白名单（即「授权他人」）
drop policy if exists admin_users_admin_all on public.admin_users;
create policy admin_users_admin_all on public.admin_users
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 把所有「登录即全权」的策略换成「管理员才全权」
do $$
declare
  t text;
begin
  foreach t in array array[
    'distributor_products','distributors','orders','products','purchase_orders',
    'settings','store_adds','store_distributors','store_drops','store_prices',
    'store_products','stores'
  ] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists admin_authenticated_all on public.%I', t);
    execute format('drop policy if exists admin_only_all on public.%I', t);
    execute format(
      'create policy admin_only_all on public.%I for all to authenticated
         using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- 商品图片上传也只允许管理员
drop policy if exists "mainsite 1a5cjkv_0" on storage.objects;
drop policy if exists admin_upload_product_photos on storage.objects;
create policy admin_upload_product_photos on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-photos' and public.is_admin());
