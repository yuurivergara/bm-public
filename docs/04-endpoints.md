# 04 — Endpoints, Webhooks e Integrações

> Status: **aguardando aprovação** · Base interna: `/api/v1` · Formato: JSON · Autenticação: sessão (cookie) + Cloudflare Access
> Permissões: **O** = owner, **Op** = operator, **V** = viewer

## 1. API interna (painel)

### 1.1 Autenticação e operadores
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| POST | `/auth/login` | E-mail + senha → exige TOTP | público |
| POST | `/auth/totp` | Valida TOTP, cria sessão | público (pré-sessão) |
| POST | `/auth/logout` | Revoga sessão atual | todos |
| GET | `/auth/me` | Operador atual + permissões | todos |
| GET | `/auth/sessions` · DELETE `/auth/sessions/:id` | Listar/revogar sessões | todos (próprias) |
| GET/POST/PATCH | `/users` · `/users/:id` | Gestão de operadores | O |

### 1.2 Clientes
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET | `/tenants` | Lista com filtros (status, qualidade, verificação, tier, busca) | V |
| POST | `/tenants` | Cria cliente | Op |
| GET/PATCH | `/tenants/:id` | Detalhe/edição | V / Op |
| GET/PUT | `/tenants/:id/settings` | Configurações (teto, ondas, margem, frequência, botão) | V / O |
| POST | `/tenants/:id/pause` · `/resume` | Pausa/retoma todas as campanhas do cliente | Op |
| POST | `/tenants/:id/offboard` | Encerra: pausa, libera número para quarentena | O |
| DELETE | `/tenants/:id/data` | Exclusão completa (hot + arquivo); exige confirmação | O |

### 1.3 Provisioning
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| POST | `/tenants/:id/onboarding-links` | Gera link de uso único para Embedded Signup | Op |
| GET | `/tenants/:id/onboarding-runs` | Histórico de onboarding e passos | V |
| POST | `/tenants/:id/onboarding-runs/:runId/retry` | Re-executa passos com falha | Op |
| POST | `/tenants/:id/assets/partner-share` | Cadastra ativos compartilhados por parceria (IDs) e valida acesso | Op |
| POST | `/tenants/:id/assets/sync` | Força sincronização | Op |
| GET | `/onboarding/migration` | Painel da migração dos clientes atuais | V |

### 1.4 Página pública de conexão (sem login; protegida por token de uso único)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/connect/:token` | Página com botão Embedded Signup (FB JS SDK) |
| POST | `/api/v1/connect/:token/complete` | Recebe `code` + IDs retornados pelo fluxo; enfileira onboarding |
| POST | `/api/v1/connect/:token/event` | Registra abandono/erro do fluxo (diagnóstico) |

### 1.5 Ativos (Account Manager)
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET | `/accounts` | Visão consolidada: cliente, portfolio, WABA, número, status, verificação, limite, qualidade, volume, erros, última sync | V |
| GET | `/portfolios/:id` · `/wabas/:id` · `/phone-numbers/:id` | Detalhes | V |
| GET | `/phone-numbers/:id/health` | Histórico de qualidade/status | V |

### 1.6 Números (Number Inventory)
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET/POST | `/number-providers` | Provedores | O |
| GET | `/number-inventory` | Estoque com filtros de status | V |
| POST | `/number-inventory` | Cadastra número contratado (ou compra via API do provedor) | O |
| POST | `/tenants/:id/number/assign` | Atribui número disponível e inicia registro na WABA | Op |
| GET | `/tenants/:id/number` | Número atribuído + etapa do registro | V |
| POST | `/tenants/:id/phone-numbers/:phoneId/verification/request` · `/verify` | Solicita (`SMS`/`VOICE`) / confirma o código de 6 dígitos | Op |
| POST | `/tenants/:id/phone-numbers/:phoneId/register` | Registra na Cloud API (PIN de 2 etapas gerado e cifrado pela plataforma). Também serve para re-registro após aprovação de nome | Op |
| POST | `/tenants/:id/number/release` | Libera número → quarentena (somente em offboarding) | O |

> Implementado no S3. As rotas de número ficam sob `/tenants/:id/…` (e não `/phone-numbers/:id/…`) para que o RLS
> receba o cliente pela URL. A Meta **não tem API para apagar** um número da WABA (§10 de `docs/10`): depois da
> quarentena, reaproveitar o número em outro cliente exige removê-lo no WhatsApp Manager da WABA antiga.

### 1.7 Contatos
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| POST | `/tenants/:id/imports` | Upload (URL pré-assinada S3) + mapeamento de colunas + **declaração de origem** | Op |
| GET | `/tenants/:id/imports/:importId` | Status + relatório (válidos, inválidos, duplicados, suprimidos) | V |
| POST | `/tenants/:id/imports/:importId/confirm` | Confirma e cria a lista | Op |
| GET | `/tenants/:id/lists` · `/lists/:listId` | Listas | V |
| GET | `/tenants/:id/contacts` | Busca de contatos | V |
| GET/POST/DELETE | `/tenants/:id/suppressions` | Lista de descadastros (consulta por telefone, inclusão manual) | V / Op / O |

### 1.8 Templates
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET/POST/PATCH | `/template-library` · `/template-library/:id` | Biblioteca de modelos | V / O |
| POST | `/template-library/:id/apply` | Aplica em lote: `{tenantIds, variables por cliente}` → submete à WABA de cada um | Op |
| GET | `/tenants/:id/templates` | Templates do cliente com status/categoria/qualidade | V |
| POST | `/tenants/:id/templates` | Template personalizado (exceção) | Op |
| POST | `/tenants/:id/templates/sync` | Sincroniza com a Meta | Op |
| DELETE | `/tenants/:id/templates/:templateId` | Remove na Meta e localmente | O |

> Implementado no S3: criação, sync e exclusão por cliente (a biblioteca `template-library` fica para depois).
> Exclusão apaga **só aquele idioma** (`hsm_id` + `name`). Marketing exige botão de descadastro (FR-TPL-05).
> Nome repetido no mesmo idioma → `409 template_exists` (Meta 100/2388024).

### 1.9 Campanhas
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET | `/campaigns` | Todas as campanhas (filtros: cliente, status, período) | V |
| POST | `/tenants/:id/campaigns` | Cria rascunho | Op |
| POST | `/campaigns/:id/preflight` | Validações + estimativa de custo e duração | Op |
| POST | `/campaigns/:id/schedule` · `/start` | Agenda/inicia | Op |
| POST | `/campaigns/:id/pause` · `/resume` · `/cancel` | Controle | Op |
| GET | `/campaigns/:id` · `/stats` · `/waves` | Progresso, métricas e ondas | V |
| GET | `/campaigns/:id/recipients` | Destinatários com status (paginado) | V |
| POST | `/campaigns/:id/recipients/resend-uncertain` | Reenvio manual dos `uncertain` | Op |
| GET | `/campaigns/:id/report` | Relatório PDF/XLSX para o cliente | V |

### 1.10 Capacidade, custos, alertas, auditoria, operação
| Método | Rota | Descrição | Perm. |
|---|---|---|---|
| GET | `/capacity` · `/capacity/:portfolioId` | Limite, usado 24h, reservado, disponível, histórico | V |
| GET | `/costs/summary` · `/costs/tenants/:id` | Custo dia/mês por cliente e previsão da fatura | O |
| GET/POST | `/pricing-rates` | Tabela de preços | O |
| GET | `/alerts` · POST `/alerts/:id/ack` · `/resolve` | Alertas | V / Op |
| GET | `/audit-logs` | Auditoria com filtros | O |
| GET | `/dashboard/overview` | KPIs consolidados | V |
| GET | `/ops/queues` | Estado das filas/workers (Bull Board protegido) | O |
| GET | `/ops/dlq` · POST `/ops/dlq/:jobId/retry` | Dead letter queue | O |
| GET | `/healthz` · `/readyz` | Health checks (internos, sem dados) | infra |

**Padrões:** paginação por cursor (`?cursor=&limit=`), filtros por query, erros no formato `{ code, message, details, traceId }`, escrita idempotente com header `Idempotency-Key` nas rotas de criação/início de campanha, todas as escritas auditadas.

## 2. Webhooks recebidos

### 2.1 Meta — `GET/POST /webhooks/meta`
- **GET:** verificação (`hub.mode`, `hub.verify_token`, `hub.challenge`).
- **POST:** valida `X-Hub-Signature-256`; grava em `webhook_events`; enfileira; responde 200.

Campos assinados (validados em `docs/10-meta-referencia.md` §3; `entry[].id` = WABA):

| Campo | Uso |
|---|---|
| `messages` | Status de envio (sent, delivered, read, failed, com dados de cobrança) e mensagens recebidas (opt-out, contagem de respostas) |
| `message_template_status_update` | Aprovação, rejeição, pausa, desativação |
| `message_template_quality_update` | Qualidade do template |
| `template_category_update` | Reclassificação de categoria |
| `phone_number_quality_update` | Hoje sinaliza **throughput** (`ONBOARDING`/`THROUGHPUT_UPGRADE`); legado traz `current_limit`. A qualidade vem do sync |
| `phone_number_name_update` | Aprovação do nome exibido |
| `account_update` | Restrições, violações de política, mudanças de conta |
| `account_review_update` | Revisão da WABA |
| `business_capability_update` | **Limite de mensagens do portfolio** (`max_daily_conversations_per_business`, número ou `TIER_*`) e `max_phone_numbers_per_waba` |
| `account_alerts` | Alertas da conta |
| `user_preferences` | **Opt-out oficial** de marketing pelo usuário (S4: alimenta `suppressions`) |
| `security` | Mudanças de segurança do número (PIN etc.) |

### 2.2 Provedor de números — `POST /webhooks/number-provider/:providerId`
Recebe SMS/transcrição com o código de verificação; validação por assinatura/segredo do provedor; casa o código com o número em `verifying`.

## 3. Endpoints da Meta utilizados (Graph API, versão configurável)

> ⚠️ **Todos a validar** na documentação oficial antes da implementação (D-15). Lista baseada em documentação de parceiros e conhecimento prévio.

| Uso | Chamada |
|---|---|
| Trocar código do Embedded Signup por token | `GET /oauth/access_token?client_id&client_secret&code` |
| Inspecionar token/escopos | `GET /debug_token?input_token=` |
| Dados do portfolio | `GET /{business-id}?fields=name,verification_status,...` |
| Limite de mensagens | `GET /{business-id \| waba-id \| phone-number-id}?fields=whatsapp_business_manager_messaging_limit` |
| Dados da WABA | `GET /{waba-id}?fields=name,currency,account_review_status,...` |
| Números da WABA | `GET /{waba-id}/phone_numbers` |
| Dados do número | `GET /{phone-number-id}?fields=display_phone_number,verified_name,name_status,quality_rating,throughput,code_verification_status` |
| Assinar webhooks | `POST /{waba-id}/subscribed_apps` |
| Adicionar número | `POST /{waba-id}/phone_numbers` |
| Solicitar / confirmar código | `POST /{phone-number-id}/request_code` · `POST /{phone-number-id}/verify_code` |
| Registrar / desregistrar | `POST /{phone-number-id}/register` (PIN de 2 etapas) · `POST /{phone-number-id}/deregister` |
| Templates | `GET/POST /{waba-id}/message_templates` · `DELETE /{waba-id}/message_templates?hsm_id=&name=` (só `name` apaga todos os idiomas) |
| Enviar mensagem | `POST /{phone-number-id}/messages` |
| Analytics / custos | Endpoints de analytics de preços/conversas da WABA |
| Modo BSP (futuro) | Linha de crédito: listagem de *extended credits* do portfolio e compartilhamento com a WABA |

**Boas práticas no `meta-client`:** versão da API em variável de ambiente; `appsecret_proof` em todas as chamadas; timeouts e circuit breaker; catálogo de erros tipado; registro de `x-fb-trace-id` nos logs; testes de contrato contra o **meta-sim**.

## 4. Integrações externas

| Integração | Finalidade |
|---|---|
| Meta Graph API / Cloud API | Provisionamento, templates, envio, sincronização |
| Facebook JS SDK | Embedded Signup na página `/connect` |
| Provedor de números | Contratação (se API), recebimento de código, cancelamento |
| S3 | Uploads de listas, relatórios, arquivo |
| Telegram Bot API + e-mail (SES) | Alertas ao operador |
| Grafana Cloud / Sentry | Observabilidade |

## 5. Variáveis de ambiente (principais)

| Variável | Descrição | Origem |
|---|---|---|
| `NODE_ENV`, `APP_ENV` | ambiente (`dev`/`staging`/`prod`) | config |
| `DATABASE_URL`, `DATABASE_REPORTING_URL` | Postgres (papéis app e reporting) | Secrets Manager |
| `REDIS_URL` | Redis | Secrets Manager |
| `META_APP_ID`, `META_APP_SECRET` | App Meta | Secrets Manager |
| `META_GRAPH_VERSION` | ex.: `vXX.0` (⚠️ vigente) | config |
| `META_WEBHOOK_VERIFY_TOKEN` | verificação de webhook | Secrets Manager |
| `META_ES_CONFIG_ID` | configuração do Embedded Signup | config |
| `KMS_KEY_ID` | chave para envelope encryption | config |
| `PHONE_HASH_PEPPER` | segredo base para HMAC de telefones | Secrets Manager |
| `S3_BUCKET_UPLOADS`, `S3_BUCKET_ARCHIVE` | buckets | config |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` | observabilidade | Secrets Manager |
| `TELEGRAM_BOT_TOKEN`, `ALERT_CHAT_ID`, `ALERT_EMAIL` | alertas | Secrets Manager |
| `SESSION_SECRET` | assinatura de cookies | Secrets Manager |
| `PUBLIC_BASE_URL` | URL pública (`/connect`, webhooks) | config |
