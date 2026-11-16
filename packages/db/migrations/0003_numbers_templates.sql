-- S3: estoque de números (D-13), registro de número na WABA e templates por cliente.
-- Endpoints/campos da Meta: docs/10-meta-referencia.md §3.9–3.11 (webhooks de template) e §10–11.

-- ---------------------------------------------------------------------------
-- Provedores e estoque de números do operador. Não pertencem a um cliente (sem tenant_id):
-- o vínculo com cliente fica em number_assignments, que tem RLS.
-- ---------------------------------------------------------------------------
create table number_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  api_kind text not null check (api_kind in ('manual', 'sms_webhook', 'voice_transcription')),
  -- configuração da API do provedor (envelope encryption), se houver
  config_enc bytea,
  key_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table number_inventory (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references number_providers(id),
  phone_e164 text not null unique,
  monthly_cost_brl numeric(10, 2) not null default 0,
  status text not null default 'available'
    check (status in ('available', 'verifying', 'active', 'quarantine', 'cancelled')),
  quarantine_until timestamptz,
  notes text,
  acquired_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index number_inventory_status_idx on number_inventory (status);

-- Histórico de atribuição número → cliente (D-13: sem rodízio; um número ativo por vez).
create table number_assignments (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references number_inventory(id),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_number_id uuid references phone_numbers(id) on delete set null,
  assigned_by uuid references users(id),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text
);
create index number_assignments_tenant_idx on number_assignments (tenant_id);
-- um número do estoque só pode estar com um cliente por vez
create unique index number_assignments_one_active on number_assignments (inventory_id)
  where released_at is null;
-- D-13: um número ativo por cliente
create unique index number_assignments_one_per_tenant on number_assignments (tenant_id)
  where released_at is null;

-- ---------------------------------------------------------------------------
-- Registro do número na Cloud API (números do estoque). Números compartilhados por parceria já
-- chegam registrados e ficam com registration_status nulo.
-- ---------------------------------------------------------------------------
alter table phone_numbers
  add column inventory_id uuid references number_inventory(id),
  add column registration_status text
    check (registration_status in ('added', 'code_requested', 'code_verified', 'registered', 'deregistered')),
  add column registration_error text,
  -- PIN da verificação em duas etapas (exigido no register; envelope encryption)
  add column two_step_pin_enc bytea,
  add column pin_key_id text;

-- ---------------------------------------------------------------------------
-- Templates por cliente (WABA). Status/categoria/qualidade sincronizados por webhook e sync.
-- ---------------------------------------------------------------------------
create table message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  waba_id uuid not null references whatsapp_accounts(id) on delete cascade,
  meta_template_id text unique,
  name text not null,
  language text not null,
  category text,
  submitted_category text,
  previous_category text,
  parameter_format text,
  status text not null default 'PENDING',
  quality_score text,
  rejection_reason text,
  components jsonb not null,
  meta_raw jsonb,
  last_status_at timestamptz,
  synced_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, name, language)
);
create index message_templates_tenant_idx on message_templates (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['number_assignments', 'message_templates']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
      t
    );
  end loop;
end $$;

grant select, insert, update on number_providers, number_inventory to bm_app;
grant select, insert, update on number_assignments to bm_app;
grant select, insert, update, delete on message_templates to bm_app;
