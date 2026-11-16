-- 0001 — Fundação: extensões, papel da aplicação, helpers de tenant e partições,
-- operadores, sessões, clientes, configurações e auditoria.
-- Ver docs/03-modelo-de-dados.md

create extension if not exists citext;
create extension if not exists pgcrypto;

-- Schema "app" para funções utilitárias
create schema if not exists app;

-- Tenant corrente da transação (definido com SET LOCAL app.tenant_id). Sem contexto → null,
-- e as políticas RLS não retornam nenhuma linha (falha segura).
create or replace function app.current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Cria partições mensais [mês corrente − back, mês corrente + ahead] para uma tabela particionada
-- por range de timestamptz. Idempotente; chamada pelas migrations e por job agendado.
create or replace function app.ensure_monthly_partitions(parent regclass, back int default 0, ahead int default 3)
returns void language plpgsql as $$
declare
  m date;
  start_d date := date_trunc('month', now())::date - make_interval(months => back);
  name text;
begin
  for i in 0..(back + ahead) loop
    m := (start_d + make_interval(months => i))::date;
    name := format('%s_%s', parent::text, to_char(m, 'YYYYMM'));
    if to_regclass(name) is null then
      execute format(
        'create table %I partition of %s for values from (%L) to (%L)',
        name, parent, m, (m + interval '1 month')::date
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Operadores
-- ---------------------------------------------------------------------------
create type user_role as enum ('owner', 'operator', 'viewer');
create type user_status as enum ('active', 'disabled');

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  password_hash text not null,
  totp_secret_enc bytea not null,
  totp_enrolled_at timestamptz,
  totp_last_used_step bigint,
  role user_role not null default 'operator',
  status user_status not null default 'active',
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  ip inet,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index user_sessions_active_idx on user_sessions (user_id) where revoked_at is null;

-- Desafio de login (senha ok, aguardando TOTP). Curta duração, uso único.
create table login_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clientes (tenants)
-- ---------------------------------------------------------------------------
create type tenant_status as enum ('onboarding', 'active', 'paused', 'offboarded');

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  cnpj char(14) unique,
  contact_name text,
  contact_phone text,
  contact_email citext,
  status tenant_status not null default 'onboarding',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  offboarded_at timestamptz,
  constraint tenants_cnpj_format check (cnpj is null or cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$')
);
create index tenants_status_idx on tenants (status);

create table tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  monthly_cost_cap_usd numeric(12, 2) check (monthly_cost_cap_usd is null or monthly_cost_cap_usd >= 0),
  capacity_safety_pct smallint not null default 90 check (capacity_safety_pct between 50 and 100),
  wave_policy jsonb not null default '{"firstPct":5,"min":20,"max":200,"growth":2,"gateMinutes":15}',
  max_msgs_per_contact_24h smallint not null default 1 check (max_msgs_per_contact_24h between 1 and 10),
  contact_button_url text,
  auto_reply_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Auditoria (append-only, particionada por mês)
-- ---------------------------------------------------------------------------
create table audit_logs (
  id bigint generated always as identity,
  user_id uuid references users(id),
  tenant_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
create table audit_logs_default partition of audit_logs default;
create index audit_logs_tenant_idx on audit_logs (tenant_id, created_at desc);
create index audit_logs_user_idx on audit_logs (user_id, created_at desc);
select app.ensure_monthly_partitions('audit_logs', 1, 3);

-- ---------------------------------------------------------------------------
-- Row-Level Security nas tabelas por cliente
-- (tenants = registro de clientes; audit_logs = log do operador, cross-tenant)
-- ---------------------------------------------------------------------------
alter table tenant_settings enable row level security;
alter table tenant_settings force row level security;
create policy tenant_isolation on tenant_settings
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- ---------------------------------------------------------------------------
-- Permissões do papel da aplicação (criado pelo migrador: bm_app)
-- ---------------------------------------------------------------------------
grant usage on schema public, app to bm_app;
grant execute on all functions in schema app to bm_app;
grant select, insert, update, delete on users, user_sessions, login_challenges, tenants, tenant_settings to bm_app;
grant select, insert on audit_logs to bm_app;
grant usage, select on all sequences in schema public to bm_app;
