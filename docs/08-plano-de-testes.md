# 08 — Plano de Testes

> Status: **aguardando aprovação** · Regra do prompt (item 16): **nenhuma capacidade é afirmada sem teste de carga**.

## 1. Níveis de teste

| Nível | Ferramentas | Escopo | Quando |
|---|---|---|---|
| Unitário | Vitest | Regras puras: normalização E.164, cálculo de capacidade, portões de onda, mapeamento de erros, custo | Todo commit (CI) |
| Integração | Vitest + **Testcontainers** (Postgres, Redis, MinIO) | Repositórios, RLS, scripts Lua de capacidade, filas BullMQ, importação | Todo commit (CI) |
| Contrato | **meta-sim** (simulador da Graph API em Fastify) | `meta-client` contra respostas, erros e webhooks documentados | Todo commit; atualizado quando a documentação muda |
| E2E | Playwright (trace desligado por padrão) | Fluxos do painel: login TOTP, criar cliente, importar lista, criar/pausar campanha | PR para `main` |
| Staging real | App Meta de teste + número de teste | Envio real, webhooks reais, templates reais | Antes de cada release |
| Carga | **k6** + meta-sim | Patamares de volume | S11 e antes de cada mudança de patamar |
| Resiliência | Scripts de caos | Falhas de worker, Redis, banco, Meta | S11 |
| Segurança | OWASP ZAP baseline, CodeQL, Trivy, testes de autorização | Painel, `/connect`, webhooks | S12 e trimestral |
| Aceite | Piloto com clientes reais | Critérios do MVP | Fim de S6 e S12 |

## 2. meta-sim (simulador da Meta)

Servidor local que emula, com base na documentação (⚠️ validada):
- envio de mensagens com latência configurável, `wamid`, e **injeção de erros** (throughput, limite de pares, ecossistema, spam, pagamento, token inválido, 5xx, timeout);
- emissão de webhooks assinados (status sent/delivered/read/failed, qualidade, template, conta) com atrasos, duplicatas e fora de ordem;
- limites por portfolio (rejeita acima do tier);
- endpoints de provisionamento (troca de código, números, registro, templates).

Usado em dev, CI, E2E e carga — sem gastar dinheiro nem arriscar contas reais.

## 3. Casos críticos obrigatórios

### 3.1 Isolamento e segurança
- Para **toda** tabela com `tenant_id`: consulta sem `app.tenant_id` retorna 0 linhas; com outro tenant retorna 0 linhas (teste gerado automaticamente a partir do schema).
- Campanha do cliente A **não pode** usar lista, template ou número do cliente B (validação de aplicação + FK compostas).
- Token Meta nunca aparece em logs, respostas de API ou erros (teste com token-sentinela).
- Webhook com assinatura inválida é rejeitado e registrado.
- Link `/connect` expirado ou já usado é rejeitado; tentativa de força bruta é bloqueada por rate limit.
- Operador `viewer` não executa escrita; `operator` não vê tokens nem configurações críticas.

### 3.2 Capacidade
- Com limite 250 e margem 90%, **nunca** mais de 225 destinatários novos em 24h por portfolio, com 50 workers concorrentes reservando (teste de propriedade/concorrência).
- Dois números no mesmo portfolio compartilham a mesma janela.
- Destinatário já contatado na janela não consome slot novo.
- Reconstrução da janela após perda do Redis produz a mesma contagem.
- Mudança de tier via webhook atualiza a capacidade em < 1 min.

### 3.3 Mensageria
- 10.000 envios com 5% de falhas transitórias e 1% de timeouts injetados: **0 duplicadas**, transitórias recuperadas, timeouts em `uncertain`.
- Erro de pagamento pausa todas as campanhas do cliente; erro de spam pausa a campanha; token inválido marca conexão `broken`.
- Portão de onda reprovado pausa a campanha com motivo.
- Webhooks duplicados/fora de ordem não regridem status (ex.: `read` não volta para `delivered`).
- Opt-out por palavra-chave e por botão: suprimido em < 60 s; envios pendentes cancelados.
- Contato suprimido nunca recebe, mesmo reimportado.

### 3.4 Importação
- CSV/XLSX/TXT com codificações diferentes (UTF-8, Latin-1), separadores variados, números com/sem DDI, com/sem nono dígito, duplicados e lixo.
- 1M linhas em < 10 min, memória constante (streaming).

### 3.5 Provisioning
- Máquina de estados: falha em cada passo é recuperável via retry sem duplicar ativos.
- Atribuição de número: duas atribuições concorrentes ao mesmo número → uma falha (índice único).
- Número em quarentena não é atribuível.

## 4. Testes de carga (k6 + meta-sim)

| Cenário | Alvo (patamar Lançamento) | Critério de aprovação |
|---|---|---|
| C1 Disparo sustentado | 1M destinatários em 24h distribuídos em 500 portfolios | 0 excedentes de capacidade; fila sem crescimento contínuo; erro interno < 0,1% |
| C2 Pico | 300 msg/s agregados por 30 min (50 números × 6 msg/s) | p95 enfileiramento→envio < 5 s |
| C3 Webhooks | 3× o volume de envios (sent+delivered+read), rajadas de 1.500 req/s por 5 min | p99 resposta < 500 ms; lag de processamento p95 < 60 s; 0 perdas |
| C4 Importação concorrente | 10 arquivos de 500k linhas simultâneos | Todos concluídos < 15 min; API do painel p95 < 500 ms durante |
| C5 Onboarding | 100 onboardings simulados em 1 h | 0 falhas não recuperáveis |
| C6 Painel | 5 usuários simultâneos com dashboards durante C1 | p95 < 1 s |

Resultados documentados em `docs/load-tests/AAAA-MM-DD.md` com configuração da infraestrutura usada. O patamar só é declarado "suportado" após aprovação de C1–C6.

## 5. Resiliência (caos)

| Experimento | Esperado |
|---|---|
| Matar 50% dos workers durante campanha | Jobs retomados; 0 duplicadas |
| Failover do Redis | Janela reconstruída; envio pausa e retoma sozinho |
| Failover do RDS (Multi-AZ) | Indisponibilidade < 2 min; nenhum dado perdido |
| Meta retornando 5xx por 10 min | Circuit breaker abre; campanhas aguardam; retomada automática |
| Ingestão de webhooks fora por 10 min | Meta reenvia; reconciliação cobre lacunas |

## 6. Aceite dos MVPs

**MVP 1:** campanha real do piloto concluída dentro do limite; opt-out funcionando com número real; alerta de qualidade recebido no Telegram; backup restaurado; nenhum token/telefone em logs.

**MVP 2:** onboarding real via Embedded Signup concluído por um cliente sem ajuda manual; template da biblioteca aprovado em 10+ clientes; testes de carga C1–C6 aprovados; DR com RTO ≤ 4 h medido.
