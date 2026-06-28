-- Hot Products — migrate the existing table to the weekly board model.
-- Run once in Supabase → SQL Editor. Safe to run on the existing table or a
-- fresh project (every statement is idempotent / guarded).
--
-- New model: week_start (Monday) · product_link · listed · kapruka_link
-- The research team pastes ~5 product links per week; the product dept lists
-- each on Kapruka and pastes the link (a Kapruka link means "listed").

-- Fresh installs: create the table if it doesn't exist yet.
create table if not exists hot_products (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  product_link  text not null,
  listed        boolean not null default false,
  kapruka_link  text
);

-- 1) Add the weekly grouping column.
alter table hot_products add column if not exists week_start date;

-- 2) Legacy columns (from the old category board) become optional, so a
--    link-only insert succeeds. These no-op if the columns don't exist.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'hot_products' and column_name = 'category') then
    alter table hot_products alter column category drop not null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_name = 'hot_products' and column_name = 'sales_count') then
    alter table hot_products alter column sales_count set default 0;
  end if;
end $$;

-- 3) Backfill week_start for existing rows = the Monday of their created_at.
update hot_products
set week_start = (created_at::date - ((extract(isodow from created_at)::int - 1)))
where week_start is null;

-- 4) Default future inserts to the current week's Monday, then require it.
alter table hot_products
  alter column week_start set default (current_date - ((extract(isodow from current_date)::int - 1)));
alter table hot_products alter column week_start set not null;

create index if not exists idx_hot_products_week on hot_products (week_start desc, created_at);
