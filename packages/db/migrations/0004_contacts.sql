-- S4 Contatos: importação (CSV/XLSX/TXT) com prévia e declaração de origem, contatos, listas,
-- registro de consentimento e lista de supressão permanente por cliente (FR-CON-01…06).

-- ---------------------------------------------------------------------------
-- Importações
-- ---------------------------------------------------------------------------
create table contact_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  original_filename text not null,
  file_format text not null check (file_format in ('csv', 'txt', 'xlsx')),
  file_size bigint not null,
  file_sha256 bytea not null,                -- evidência do arquivo recebido (o arquivo em si é apagado)
  status text not null default 'uploaded'
    check (status in ('uploaded', 'parsing', 'preview', 'confirming', 'confirmed', 'failed', 'cancelled')),
  mapping jsonb not null,                    -- {phone, name?, attributes?, hasHeader, delimiter?}
  list_name text not null,
  row_count int,
  valid_count int,
  invalid_count int,
  duplicate_count int,
  suppressed_count int,
  existing_count int,                        -- válidos que já eram contatos do cliente
  error_sample jsonb,                        -- primeiras linhas inválidas (linha + motivo)
  error text,
  -- Declaração de origem (FR-CON-03): obrigatória
  origin_declaration text not null check (origin_declaration in ('customers', 'signup', 'leads', 'other')),
  legal_basis text not null check (legal_basis in ('consentimento', 'legitimo_interesse', 'execucao_contrato')),
  declaration_notes text,
  declared_by uuid not null references users(id),
  declared_at timestamptz not null,
  list_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index contact_imports_tenant_idx on contact_imports (tenant_id, created_at desc);

-- Fila do processador (análise do arquivo e confirmação). Sem RLS de propósito, como
-- meta_asset_routes: o worker precisa achar trabalho de qualquer cliente; a tabela só tem IDs (nenhum
-- dado de contato) e todo o processamento roda depois com o contexto do cliente (withTenant).
create table contact_import_jobs (
  import_id uuid primary key references contact_imports(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('parse', 'confirm')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text
);
create index contact_import_jobs_available_idx on contact_import_jobs (available_at);

-- Linhas da prévia. UNLOGGED: são temporárias (apagadas na confirmação/cancelamento), não vão para
-- o WAL nem para os backups e gravam bem mais rápido (1M linhas).
create unlogged table contact_import_rows (
  import_id uuid not null references contact_imports(id) on delete cascade,
  tenant_id uuid not null,
  row_no int not null,
  phone_e164 text,
  phone_hash bytea,
  name text,
  attributes jsonb not null default '{}',
  status text not null check (status in ('valid', 'invalid', 'duplicate', 'suppressed')),
  reason text,
  primary key (import_id, row_no)
);
create index contact_import_rows_phone_idx on contact_import_rows (import_id, phone_e164);

-- ---------------------------------------------------------------------------
-- Contatos, listas, consentimento, supressão
-- ---------------------------------------------------------------------------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_e164 text not null,
  phone_hash bytea not null,
  name text,
  attributes jsonb not null default '{}',    -- variáveis do template
  first_import_id uuid references contact_imports(id) on delete set null,
  invalid_at timestamptz,                    -- marcado inválido após falha permanente (S5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone_e164)
);
create index contacts_hash_idx on contacts (tenant_id, phone_hash);

create table contact_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  import_id uuid unique references contact_imports(id) on delete set null,
  name text not null,
  size int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index contact_lists_tenant_idx on contact_lists (tenant_id, created_at desc);

alter table contact_imports
  add constraint contact_imports_list_fk foreign key (list_id) references contact_lists(id) on delete set null;

create table contact_list_members (
  list_id uuid not null references contact_lists(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  tenant_id uuid not null,
  primary key (list_id, contact_id)
);
create index contact_list_members_contact_idx on contact_list_members (contact_id);

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  basis text not null,
  source text not null check (source in ('import_declaration', 'opt_in_reply', 'manual')),
  import_id uuid references contact_imports(id) on delete set null,
  evidence jsonb,
  recorded_at timestamptz not null default now()
);
create index consent_records_contact_idx on consent_records (tenant_id, contact_id);

-- Supressão permanente (FR-CON-06): por hash do telefone no cliente; não há rota para remover.
create table suppressions (
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_hash bytea not null,
  phone_masked text not null,                -- só para exibição (+55119****4321)
  reason text not null check (reason in ('opt_out_keyword', 'opt_out_button', 'manual', 'complaint', 'invalid')),
  source_message_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone_hash)
);
create index suppressions_tenant_created_idx on suppressions (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['contact_imports', 'contact_import_rows', 'contacts', 'contact_lists',
                           'contact_list_members', 'consent_records', 'suppressions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
      t
    );
  end loop;
end $$;

grant select, insert, update on contact_imports, contacts, contact_lists to bm_app;
grant select, insert, update, delete on contact_import_jobs to bm_app;
grant select, insert, update, delete on contact_import_rows, contact_list_members to bm_app;
grant select, insert on consent_records, suppressions to bm_app;
