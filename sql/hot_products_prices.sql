-- Hot Products — add price + match columns for the suggested↔listed comparison.
-- Run once in Supabase → SQL Editor (after sql/hot_products.sql). Idempotent.
--
-- When a suggestion link is added, the price service scrapes its price; when the
-- Kapruka link is pasted, it scrapes that too and scores how well they match.
-- All prices are stored in LKR (foreign USD pages are converted at the "270 rule"
-- on the server). price_diff = kapruka_price − suggested_price (negative = Kapruka
-- is cheaper than the suggested source).

alter table hot_products
  add column if not exists suggested_title    text,
  add column if not exists suggested_price    numeric,   -- LKR
  add column if not exists suggested_currency text,       -- original detected currency (e.g. USD/LKR)
  add column if not exists kapruka_title      text,
  add column if not exists kapruka_price      numeric,   -- LKR
  add column if not exists kapruka_currency   text,
  add column if not exists match_rate         int,        -- 0–100 confidence same product
  add column if not exists price_diff         numeric,   -- LKR, kapruka − suggested
  add column if not exists compared_at        timestamptz;
