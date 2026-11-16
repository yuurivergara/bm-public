# bm-public — Plataforma de Mensageria Oficial Meta (WhatsApp Cloud API)

Plataforma **interna** para um operador conectar, administrar e disparar campanhas de WhatsApp **oficiais** para centenas de clientes, cada um com seus próprios ativos Meta (Business Portfolio, WABA, número), respeitando limites, qualidade, opt-out, LGPD e políticas da Meta.

> **Status:** Fase 2 — pacote de planejamento **aguardando aprovação**. Nenhum código de produção foi escrito.

## Pacote de planejamento

| # | Documento | Conteúdo |
|---|---|---|
| 00 | [Registro de decisões](docs/00-decisoes-discovery.md) | Decisões do discovery (D-01 a D-15), fora de escopo, premissas |
| 01 | [PRD](docs/01-prd.md) | Visão, usuários, objetivos, requisitos funcionais e não funcionais |
| 02 | [Arquitetura](docs/02-arquitetura.md) | Stack comparada, diagramas de componentes e infraestrutura, fluxos, capacidade, segurança, observabilidade, DR |
| 03 | [Modelo de dados](docs/03-modelo-de-dados.md) | ER, DDL, índices, RLS, particionamento, retenção, backup, migrações |
| 04 | [Endpoints e integrações](docs/04-endpoints.md) | API interna, webhooks, chamadas Meta, variáveis de ambiente |
| 05 | [Roadmap](docs/05-roadmap.md) | Trilha Meta, MVP 1 (6 semanas), MVP 2 (+6 semanas), critérios de conclusão |
| 06 | [Custos](docs/06-custos.md) | Mensagens Meta, números, infraestrutura |
| 07 | [Riscos](docs/07-riscos.md) | Matriz de riscos e procedimento para contas restritas |
| 08 | [Plano de testes](docs/08-plano-de-testes.md) | Níveis, casos críticos, carga, caos, aceite |
| 09 | [Pendências Meta](docs/09-pendencias-meta.md) | Itens a validar na documentação oficial + checklist do operador |

## Stack proposta (resumo)

NestJS (Fastify) + TypeScript · Next.js + Tailwind + shadcn/ui · PostgreSQL 16 (RLS, partições) · Redis + BullMQ · AWS sa-east-1 (ECS Fargate, RDS, ElastiCache, S3, KMS) · Terraform · Cloudflare · OpenTelemetry + Grafana Cloud + Sentry.

## Princípios

- Somente APIs oficiais da Meta; ativos pertencem aos clientes.
- Isolamento rígido de dados por cliente.
- Nenhum mecanismo de evasão (rodízio de números, multi-login, proxies rotativos, mascaramento de identidade).
- Simplicidade operacional para um desenvolvedor; escala comprovada por teste de carga.
