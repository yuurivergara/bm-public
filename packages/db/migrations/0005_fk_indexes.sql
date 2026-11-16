-- Índices para FKs com ON DELETE CASCADE/SET NULL em tabelas que crescem com os contatos.
-- Sem eles, cada contato apagado varria consent_records inteira (o índice (tenant_id, contact_id)
-- não serve para a busca da FK, que filtra só por contact_id): apagar 1M contatos levava horas no
-- staging. Teste "toda FK tem um índice…" em packages/db/src/db.test.ts evita a regressão.
create index consent_records_contact_id_idx on consent_records (contact_id);
create index consent_records_import_idx on consent_records (import_id);
create index contacts_first_import_idx on contacts (first_import_id);
