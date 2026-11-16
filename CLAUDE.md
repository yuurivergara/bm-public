# CLAUDE.md — contexto do projeto para agentes

Plataforma **interna** (uso exclusivo do operador) para conectar BMs de clientes e disparar campanhas
de WhatsApp **somente pela API oficial da Meta (Cloud API)**. Idioma de trabalho com o usuário:
**português**. O usuário é programador e único desenvolvedor; trate-o como parceiro técnico.

## Leia antes de qualquer trabalho

1. `docs/00-decisoes-discovery.md` — decisões D-01…D-16 e o que está **fora de escopo**.
2. `docs/05-roadmap.md` — plano semanal e seção **7. Progresso** (estado atual).
3. `docs/02-arquitetura.md` e `docs/03-modelo-de-dados.md` antes de mexer em módulos/banco.
4. `docs/09-pendencias-meta.md` — itens da Meta ainda **não validados** na documentação oficial.

## Regras inegociáveis

- **Somente APIs oficiais da Meta.** Nada de Evolution/Baileys/WhatsApp Web.
- **Fora de escopo, mesmo se pedido:** rodízio de números entre BMs, "aquecimento" artificial,
  variação de texto para evadir detecção, proxies rotativos, multi-login, BMs próprias para
  disparar por terceiros, usar contatos de um cliente em campanha de outro. Explique o risco
  (bloqueio do app inteiro, LGPD) e ofereça a alternativa legítima.
- **Nunca** armazenar login/senha de Facebook de clientes; nunca pedir credenciais pelo chat.
- **Não inventar endpoints/campos/erros da Meta.** Confirmar na documentação oficial vigente;
  itens não confirmados ficam marcados "⚠️ a validar".
- Ativos Meta pertencem aos clientes; um número ativo por cliente/WABA (D-13).

## Comandos

```bash
pnpm install && pnpm build
pnpm lint          # Biome — precisa sair com código 0
pnpm typecheck
pnpm test          # exige Postgres local (docker compose up -d); TEST_DATABASE_ADMIN_URL opcional
pnpm db:migrate    # DATABASE_ADMIN_URL + DATABASE_APP_PASSWORD
pnpm dev:api
```
Definição de pronto: lint, typecheck e testes verdes; CI (`.github/workflows/ci.yml`) verde.

## Convenções de código

- Monorepo pnpm + Turborepo. Pacotes **CommonJS** (TS `module: NodeNext`). Node 22.
- `packages/db/migrations/*.sql` são a **fonte da verdade** do banco (migrador próprio em
  `packages/db/src/migrator.ts`). O schema Drizzle (`schema.ts`) espelha as migrations; o teste de
  drift falha se divergirem. Migrations já publicadas nunca são editadas — crie uma nova.
- **Toda tabela com `tenant_id` precisa de RLS habilitada + forçada + política** (teste automático
  em `packages/db/src/db.test.ts`; exceções documentadas em `RLS_EXEMPT`). Acesse dados de cliente
  com `withTenant(db, tenantId, fn)` / `setTenantContext(tx, id)`.
- A aplicação conecta como `bm_app` (sem BYPASSRLS); migrations rodam como dono do schema.
- Toda escrita administrativa grava `AuditService.record(ctx, entry, tx)` **na mesma transação**.
- Validação de entrada com zod nos controllers (`ZodPipe`); erros no formato
  `{ code, message, details, traceId }` (`AppError`).
- Permissões: matriz em `packages/shared/src/rbac.ts` + `@RequirePermission()`. Rotas são privadas
  por padrão; use `@Public()` só quando necessário.
- Segredos (tokens Meta, TOTP) sempre com `encryptSecret`/`decryptSecret`; nunca em logs.
- Telefones: `normalizePhone` (E.164, nono dígito); logs usam `maskPhone`.
- Testes de API: `apps/api/src/test/harness.ts` cria banco isolado por suíte.

## Estado atual (ver roadmap §7)

- ✅ S1 Fundação: monorepo, CI, banco com RLS, auth senha+TOTP, sessões, RBAC, auditoria,
  CRUD de clientes, Dockerfile. Chave mestra MASTER_KEY (D-16). 61 testes.
- ✅ S2 Ativos + Meta: `packages/meta-client` (Graph API v27.0, catálogo de erros), `apps/meta-sim`,
  webhooks (verificação, assinatura, fila em `webhook_events`, processador + handlers de ativos),
  cadastro de ativos por parceria/manual e sync. Referência oficial validada em `docs/10-meta-referencia.md`
  (consulte-a antes de usar qualquer campo/endpoint). 127 testes. Falta validar com app/número reais da Meta.
- ✅ S3 Números + templates: estoque (provedor manual), registro na WABA (request/verify/register, PIN cifrado),
  liberação com quarentena, templates por cliente (criar/sync/excluir) e webhooks de template. Migration 0003.
  147 testes. Staging e2e cobre registro + aprovação via webhook (meta-sim). Falta validar com número/app reais.
- ⏳ Próximo: **S4 Contatos** (upload CSV/XLSX/TXT, E.164 com nono dígito, dedupe, supressão, listas); depois S5 envio.
- 🟡 Infra (D-16/D-16a/D-16b): staging no ar em https://bm.179-197-76-7.sslip.io (VPS BMS, `/opt/bm-platform`,
  projeto compose `bm-platform`, com meta-sim). Deploy oficial: Actions → GHCR → `ssh deploy@… "deploy <sha>"`
  (comando forçado `deploy/bm-deploy.sh`); ponte manual `deploy/vps-deploy.sh`; teste ponta a ponta
  `deploy/staging-e2e.sh`; app real da Meta: `deploy/set-meta-app.sh`. Merge no master dispara o deploy (ativo desde o PR #1).
  Pendente antes do piloto: backup contínuo do Postgres fora da VPS + restauração testada, e decidir a VPS de
  produção (página `decisoes/2026-11-16-infra-producao.html`).

## Infra / VPS (D-16)

- MVP e piloto rodam em **VPS** (docker compose de produção), não na AWS. Staging: VPS BMS (`ssh bms-vps`),
  via Coolify. O PC do Yuri usa Cloudflare WARP, que a VPS bloqueia: `warp-cli --accept-tos disconnect`.
- Na VPS BMS a **Vendra** é produção de outro projeto: nunca parar/alterar containers que não sejam da
  plataforma sem confirmar a lista exata com o Yuri.
- Condições obrigatórias: backup contínuo **fora** da VPS + restauração testada; Cloudflare na
  frente, firewall, SSH só por chave, atualizações automáticas, Postgres/Redis sem porta pública;
  monitor externo com alerta.
- A plataforma oficial **não deve dividir servidor com a Evolution** (ou fica totalmente isolada).
- Ao operar a VPS: preferir scripts versionados no repositório; mostrar o comando e pedir
  confirmação antes de qualquer ação destrutiva ou que altere firewall/SSH; nunca exibir segredos.

## Pendências do usuário (fora do código)

- Verificação da empresa / app no Meta for Developers (há algo "em análise" — confirmar o quê).
- App Review (acesso avançado `whatsapp_business_management` / `whatsapp_business_messaging`).
- Política de privacidade e termos publicados; domínio + Cloudflare.
- Provedor de números virtuais (código de verificação por API).
- Decisão sobre o cliente urgente (docs/07-riscos.md, R-02).
