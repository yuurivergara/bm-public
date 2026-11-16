# bm-public — Plataforma de Mensageria Oficial Meta (WhatsApp Cloud API)

Plataforma **interna** para um operador conectar, administrar e disparar campanhas de WhatsApp **oficiais** para centenas de clientes, cada um com seus próprios ativos Meta (Business Portfolio, WABA, número), respeitando limites, qualidade, opt-out, LGPD e políticas da Meta.

> **Status:** planejamento aprovado · **Semana 1 (Fundação) em andamento** — ver [progresso](docs/05-roadmap.md#7-progresso).

## Pacote de planejamento

| #   | Documento                                             | Conteúdo                                                                                                       |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 00  | [Registro de decisões](docs/00-decisoes-discovery.md) | Decisões do discovery (D-01 a D-15), fora de escopo, premissas                                                 |
| 01  | [PRD](docs/01-prd.md)                                 | Visão, usuários, objetivos, requisitos funcionais e não funcionais                                             |
| 02  | [Arquitetura](docs/02-arquitetura.md)                 | Stack comparada, diagramas de componentes e infraestrutura, fluxos, capacidade, segurança, observabilidade, DR |
| 03  | [Modelo de dados](docs/03-modelo-de-dados.md)         | ER, DDL, índices, RLS, particionamento, retenção, backup, migrações                                            |
| 04  | [Endpoints e integrações](docs/04-endpoints.md)       | API interna, webhooks, chamadas Meta, variáveis de ambiente                                                    |
| 05  | [Roadmap](docs/05-roadmap.md)                         | Trilha Meta, MVP 1 (6 semanas), MVP 2 (+6 semanas), critérios de conclusão                                     |
| 06  | [Custos](docs/06-custos.md)                           | Mensagens Meta, números, infraestrutura                                                                        |
| 07  | [Riscos](docs/07-riscos.md)                           | Matriz de riscos e procedimento para contas restritas                                                          |
| 08  | [Plano de testes](docs/08-plano-de-testes.md)         | Níveis, casos críticos, carga, caos, aceite                                                                    |
| 09  | [Pendências Meta](docs/09-pendencias-meta.md)         | Itens a validar na documentação oficial + checklist do operador                                                |

## Desenvolvimento local

Pré-requisitos: Node 22+, pnpm 10 (`corepack enable`), Docker (ou PostgreSQL 16 e Redis 7 locais).

```bash
docker compose up -d                 # Postgres, Redis, MinIO
cp .env.example .env                 # preencha LOCAL_MASTER_KEY e PHONE_HASH_PEPPER:
                                     #   openssl rand -base64 32
pnpm install
pnpm build
set -a; source .env; set +a
DATABASE_APP_PASSWORD=bm_app_dev pnpm db:migrate
OWNER_EMAIL=voce@empresa.com OWNER_NAME="Seu Nome" OWNER_PASSWORD='senha-com-12+-caracteres' \
  pnpm --filter @bm/api create-owner
pnpm dev:api                         # http://localhost:3000/healthz
```

Primeiro login: `POST /api/v1/auth/login` devolve `otpauthUri` (cadastre no app autenticador) e
`challengeToken`; depois `POST /api/v1/auth/totp` com o código de 6 dígitos cria a sessão.

| Comando          | O que faz                                                         |
| ---------------- | ----------------------------------------------------------------- |
| `pnpm lint`      | Biome (lint + formatação)                                         |
| `pnpm typecheck` | TypeScript em todos os pacotes                                    |
| `pnpm test`      | Testes (unitários, banco/RLS e e2e da API; exigem Postgres local) |
| `pnpm build`     | Build de todos os pacotes                                         |

### Estrutura

```
apps/api           NestJS (Fastify): auth + TOTP, sessões, RBAC, auditoria, clientes, health
packages/db        migrations SQL (fonte da verdade), schema Drizzle, RLS, migrador
packages/shared    telefones E.164 (nono dígito), CNPJ (inclusive alfanumérico), criptografia, RBAC
packages/config    tsconfig base
docs/              pacote de planejamento
```

## Stack (resumo)

NestJS (Fastify) + TypeScript · Next.js + Tailwind + shadcn/ui · PostgreSQL 16 (RLS, partições) · Redis + BullMQ · AWS sa-east-1 (ECS Fargate, RDS, ElastiCache, S3, KMS) · Terraform · Cloudflare · OpenTelemetry + Grafana Cloud + Sentry.

## Princípios

- Somente APIs oficiais da Meta; ativos pertencem aos clientes.
- Isolamento rígido de dados por cliente.
- Nenhum mecanismo de evasão (rodízio de números, multi-login, proxies rotativos, mascaramento de identidade).
- Simplicidade operacional para um desenvolvedor; escala comprovada por teste de carga.
