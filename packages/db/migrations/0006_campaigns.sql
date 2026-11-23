-- S5 — Campanhas, envio e capacidade (docs/02-arquitetura.md §4.2, §5, §6; docs/03-modelo-de-dados.md §4.7).
-- MVP na VPS: fila no próprio Postgres (como webhooks e importações), sem Redis/BullMQ; sem
-- particionamento ainda (campaign_recipients guarda wamid e status — a tabela `messages` completa
-- entra com o histórico/custos).

-- App próprio do cliente (ponte até o Tech Provider): os webhooks do app dele chegam assinados com
-- o App Secret DELE. Cifrado como os tokens.
alter table meta_connections
  add column meta_app_id text,
  add column app_secret_enc bytea,
  add column app_secret_key_id text;

-- Opt-out de marketing vindo da Meta: erro 131050 no envio ou webhook user_preferences = stop.
alter table suppressions drop constraint suppressions_reason_check;
alter table suppressions add constraint suppressions_reason_check
  check (reason in ('opt_out_keyword', 'opt_out_button', 'manual', 'complaint', 'invalid',
                    'marketing_opt_out'));

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_number_id uuid not null references phone_numbers(id),
  template_id uuid not null references message_templates(id),
  list_id uuid not null references contact_lists(id),
  name text not null check (length(name) between 1 and 200),
  status text not null default 'draft'
    check (status in ('draft', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  pause_reason text,
  -- placeholder ("1" ou nome) → {source: name|attribute|fixed, value?, fallback?}
  variables jsonb not null default '{}',
  audience_size integer,
  created_by uuid references users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_tenant_idx on campaigns (tenant_id, created_at desc);
create index campaigns_phone_idx on campaigns (phone_number_id);
create index campaigns_template_idx on campaigns (template_id);
create index campaigns_list_idx on campaigns (list_id);

-- Fila do motor de envio: campanhas em andamento (sem RLS — só IDs, como contact_import_jobs; o
-- motor precisa achar campanhas de todos os clientes antes de entrar no contexto de cada um).
create table campaign_dispatch (
  campaign_id uuid primary key references campaigns(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  next_run_at timestamptz not null default now(),
  lease_until timestamptz,
  created_at timestamptz not null default now()
);
create index campaign_dispatch_tenant_idx on campaign_dispatch (tenant_id);

-- Audiência congelada no início da campanha. Estados:
--   pending → sending (reservado, chamando a Meta) → accepted (Meta aceitou; wamid)
--   → sent → delivered → read (webhooks) | failed | skipped | uncertain (timeout: nunca reenviar
--   sozinho) | cancelled
create table campaign_recipients (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  tenant_id uuid not null,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'accepted', 'sent', 'delivered', 'read', 'failed',
                      'skipped', 'uncertain', 'cancelled')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz,
  wamid text,
  error_code integer,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_recipients_queue_idx on campaign_recipients (campaign_id, status, id);
create index campaign_recipients_contact_idx on campaign_recipients (contact_id);
create unique index campaign_recipients_wamid_idx on campaign_recipients (wamid) where wamid is not null;

-- Janela de 24 h móveis por portfolio (limite = usuários únicos fora da janela de atendimento,
-- docs/10-meta-referencia.md §5). Uma linha por telefone; last_sent_at = último template aceito.
-- Também serve ao limite de pares (1 msg a cada 6 s para o mesmo usuário).
create table capacity_usage (
  portfolio_id uuid not null references business_portfolios(id) on delete cascade,
  tenant_id uuid not null,
  phone_hash bytea not null,
  last_sent_at timestamptz not null,
  primary key (portfolio_id, phone_hash)
);
create index capacity_usage_window_idx on capacity_usage (portfolio_id, last_sent_at);

do $$
declare t text;
begin
  foreach t in array array['campaigns', 'campaign_recipients', 'capacity_usage']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
      t
    );
  end loop;
end $$;

grant select, insert, update on campaigns to bm_app;
grant select, insert, update, delete on campaign_dispatch to bm_app;
grant select, insert, update on campaign_recipients to bm_app;
grant select, insert, update, delete on capacity_usage to bm_app;
