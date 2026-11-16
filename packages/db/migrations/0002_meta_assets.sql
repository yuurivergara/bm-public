-- 0002 — Ativos Meta (S2): conexões (token cifrado), portfolios, WABAs, números,
-- rotas de webhook, histórico de saúde e eventos de webhook (fila durável).
-- Ver docs/03-modelo-de-dados.md §4.3/§4.8 e docs/10-meta-referencia.md

create type connection_status as enum ('active', 'broken', 'revoked');
create type onboarding_method as enum ('embedded_signup', 'partner_share', 'manual');

-- ---------------------------------------------------------------------------
-- Conexões com a Meta (token de system user / business integration). Token sempre cifrado
-- (envelope encryption); key_id permite localizar blobs a recifrar ao rotacionar a chave.
-- ---------------------------------------------------------------------------
create table meta_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('system_user', 'business_integration')),
  method onboarding_method not null,
  access_token_enc bytea not null,
  key_id text not null,
  token_last4 text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  status connection_status not null default 'active',
  last_validated_at timestamptz,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meta_connections_tenant_active_idx on meta_connections (tenant_id) where status = 'active';

create table business_portfolios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  meta_business_id text not null unique,
  name text,
  verification_status text,
  messaging_limit_tier text,
  messaging_limit_value integer,
  limit_synced_at timestamptz,
  meta_raw jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index business_portfolios_tenant_idx on business_portfolios (tenant_id);

create table whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  portfolio_id uuid not null references business_portfolios(id) on delete cascade,
  connection_id uuid references meta_connections(id) on delete set null,
  meta_waba_id text not null unique,
  name text,
  currency char(3),
  timezone_id text,
  account_review_status text,
  payment_status text,
  webhooks_subscribed boolean not null default false,
  status text not null default 'active' check (status in ('active', 'restricted', 'disabled')),
  restriction_info jsonb,
  meta_raw jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whatsapp_accounts_tenant_idx on whatsapp_accounts (tenant_id);

create table phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  waba_id uuid not null references whatsapp_accounts(id) on delete cascade,
  meta_phone_number_id text not null unique,
  phone_e164 text not null,
  display_phone_number text,
  verified_name text,
  name_status text,
  quality_rating text,
  messaging_limit_tier text,
  throughput_level text,
  code_verification_status text,
  meta_status text,
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'flagged', 'restricted', 'disconnected')),
  meta_raw jsonb,
  registered_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index phone_numbers_tenant_idx on phone_numbers (tenant_id);
create index phone_numbers_waba_idx on phone_numbers (waba_id);
-- D-13: um número só pode estar ativo em uma WABA por vez.
create unique index phone_numbers_active_e164 on phone_numbers (phone_e164) where status <> 'disconnected';

-- Histórico de sinais de saúde (qualidade, status, restrições), por entidade.
create table account_health (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_type text not null check (entity_type in ('portfolio', 'waba', 'phone_number', 'template')),
  entity_id uuid not null,
  quality_rating text,
  status text,
  source text not null check (source in ('webhook', 'sync')),
  signal jsonb not null,
  observed_at timestamptz not null default now()
);
create index account_health_entity_idx on account_health (entity_type, entity_id, observed_at desc);
create index account_health_tenant_idx on account_health (tenant_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- Rotas de webhook: ID Meta (WABA, número, portfolio) → tenant. Contém só identificadores,
-- nenhum dado de cliente. É lida pelo processador ANTES de saber o tenant, por isso é
-- isenta de RLS (decisão documentada em RLS_EXEMPT no teste de RLS).
-- ---------------------------------------------------------------------------
create table meta_asset_routes (
  meta_id text primary key,
  asset_type text not null check (asset_type in ('business', 'waba', 'phone_number')),
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index meta_asset_routes_tenant_idx on meta_asset_routes (tenant_id);

-- ---------------------------------------------------------------------------
-- Eventos de webhook (fila durável). Um registro por change (entry × changes[]) com
-- assinatura já validada. Particionada por mês (alto volume a partir da S4).
-- ---------------------------------------------------------------------------
create table webhook_events (
  id bigint generated always as identity,
  received_at timestamptz not null default now(),
  source text not null check (source in ('meta', 'number_provider')),
  object text,
  field text,
  entry_id text,
  dedupe_key text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'processed', 'failed', 'ignored', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  primary key (id, received_at)
) partition by range (received_at);
create table webhook_events_default partition of webhook_events default;
create index webhook_events_pending_idx on webhook_events (next_attempt_at) where status in ('queued', 'failed');
create index webhook_events_dedupe_idx on webhook_events (dedupe_key, received_at desc);
select app.ensure_monthly_partitions('webhook_events', 0, 3);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['meta_connections', 'business_portfolios', 'whatsapp_accounts', 'phone_numbers', 'account_health']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Permissões do papel da aplicação
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on meta_connections, business_portfolios, whatsapp_accounts, phone_numbers to bm_app;
grant select, insert on account_health to bm_app;
grant select, insert, delete on meta_asset_routes to bm_app;
grant select, insert, update on webhook_events to bm_app;
grant usage, select on all sequences in schema public to bm_app;
