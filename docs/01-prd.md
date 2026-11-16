# 01 — PRD (Product Requirements Document)

> Status: **aguardando aprovação** · Decisões de referência: `00-decisoes-discovery.md`

## 1. Visão

Uma plataforma **interna e privada** que permite a um único operador conectar, administrar e disparar campanhas de WhatsApp **oficiais (Cloud API)** para centenas — e depois milhares — de clientes, cada um com seus próprios ativos Meta, respeitando limites, qualidade e políticas da Meta, com o mínimo de trabalho manual.

## 2. Problema

Hoje a operação depende de:

- ferramenta não oficial (Evolution), sujeita a bloqueios, chips e aparelhos;
- processos de acesso às BMs heterogêneos (convite, parceria, login/senha, BM criada pelo operador);
- listas recebidas por planilha/TXT sem validação, deduplicação ou supressão;
- nenhuma visibilidade consolidada de limites, qualidade, custos e falhas.

Isso não escala para 100 novos clientes/dia e expõe o operador a riscos de bloqueio, LGPD e financeiros.

## 3. Usuários

| Persona | Descrição | Acesso |
|---|---|---|
| **Owner** (você) | Operador principal; administra tudo. | Total |
| **Operator** (futuro) | Pessoa da equipe que importa listas e dispara campanhas. | Sem acesso a tokens, custos de outros escopos ou configurações críticas |
| **Viewer** (futuro) | Acompanhamento/relatórios. | Somente leitura |
| **Cliente final** | Dono da BM. **Não acessa a plataforma**; interage apenas pela página pública de conexão (Embedded Signup) via link de uso único. | Nenhum |

## 4. Objetivos e métricas de sucesso

| Objetivo | Métrica | Meta MVP 2 |
|---|---|---|
| Onboarding automatizado | Tempo do link enviado até "pronto para disparar" (excluindo espera da Meta) | < 15 min de trabalho do operador por cliente |
| Capacidade de onboarding | Onboardings concluídos/dia suportados | ≥ 100 |
| Disparo seguro | Campanhas que excederam o limite oficial | 0 |
| Proteção de qualidade | Campanhas pausadas automaticamente antes de queda de tier | ≥ 90% dos incidentes de qualidade |
| Opt-out | Tempo de processamento do descadastro | < 60 s |
| Operação | Volume suportado comprovado por teste de carga | 1M destinatários/dia (patamar Lançamento) |
| Custo | Custo por cliente visível | 100% dos clientes com custo diário calculado |

## 5. Não-objetivos

Ver "Fora de escopo" em `00-decisoes-discovery.md`. Em especial: portal do cliente, faturamento, inbox, rodízio de números, APIs não oficiais.

## 6. Requisitos funcionais

### 6.1 Autenticação e administração (Fase 4)
- **FR-AUTH-01** Login com e-mail + senha (argon2id) + **TOTP obrigatório**.
- **FR-AUTH-02** Painel protegido também por Cloudflare Access (Zero Trust).
- **FR-AUTH-03** Papéis `owner`, `operator`, `viewer` com matriz de permissões.
- **FR-AUTH-04** Sessões com expiração por inatividade, revogação e listagem de sessões ativas.
- **FR-AUD-01** Toda ação administrativa gera registro de auditoria imutável (quem, o quê, quando, antes/depois, IP).

### 6.2 Clientes (tenants)
- **FR-TEN-01** CRUD de clientes (nome fantasia, razão social, CNPJ, contato, observações).
- **FR-TEN-02** Status do cliente: `onboarding`, `active`, `paused`, `offboarded`.
- **FR-TEN-03** Configurações por cliente: teto de custo mensal, política de ondas, margem de segurança de capacidade, frequência máxima por contato, botão de contato no template.
- **FR-TEN-04** Exclusão completa dos dados de um cliente (hot + arquivo), com confirmação dupla e registro em auditoria.

### 6.3 Provisioning Engine (Fases 5–6)
- **FR-PROV-01** Gerar **link de conexão de uso único** (expira em X dias) para o cliente executar o Embedded Signup numa página pública mínima.
- **FR-PROV-02** Ao concluir o Embedded Signup: trocar o código por token, registrar Business Portfolio, WABA e número; assinar a WABA nos webhooks do app; validar permissões; registrar histórico de cada passo.
- **FR-PROV-03** Caminho alternativo: cadastrar ativos já compartilhados com a BM do operador (parceria), com validação automática de acesso.
- **FR-PROV-04** Onboarding como **máquina de estados** com passos re-executáveis e diagnóstico de falhas (ex.: "empresa não verificada", "sem forma de pagamento", "nome exibido pendente").
- **FR-PROV-05** Checklist pós-conexão: verificação da empresa do cliente, forma de pagamento configurada na WABA, nome exibido aprovado, template aprovado.
- **FR-PROV-06** Painel de migração dos clientes atuais (quem recebeu link, quem concluiu, quem está travado).

### 6.4 Number Inventory
- **FR-NUM-01** Cadastro de provedores de números e do estoque de números (E.164, custo mensal, status).
- **FR-NUM-02** Status: `available`, `verifying`, `active`, `quarantine`, `cancelled`.
- **FR-NUM-03** Atribuição de número a cliente, registro na WABA (adicionar número, solicitar código, verificar, registrar).
- **FR-NUM-04** Captura automática do código de verificação via API/webhook do provedor (SMS ou transcrição de chamada); fallback manual.
- **FR-NUM-05** **Um número ativo por cliente/WABA por vez**; liberação apenas com saída do cliente; quarentena configurável (padrão 90 dias) antes do reuso.
- **FR-NUM-06** Custo mensal do número somado ao custo do cliente.

### 6.5 Account Manager (Fase 7)
- **FR-ACC-01** Lista de todas as estruturas com: cliente, Business Portfolio ID, WABA ID, Phone Number ID, status de conexão, verificação da empresa, limite oficial, qualidade do número, qualidade dos templates, volume (24h/7d/30d), erros, restrições, última sincronização.
- **FR-ACC-02** Sincronização periódica (limites, qualidade, nome exibido, templates) e reativa (webhooks).
- **FR-ACC-03** Alertas automáticos: queda de qualidade, número sinalizado, template pausado/reclassificado, token inválido, falha de pagamento, restrição de conta, webhook atrasado.
- **FR-ACC-04** Histórico de saúde por ativo.

### 6.6 Contatos e consentimento
- **FR-CON-01** Importação de CSV, XLSX e TXT (até 1M linhas por arquivo) com mapeamento de colunas.
- **FR-CON-02** Normalização para E.164 (incluindo nono dígito brasileiro), validação, deduplicação.
- **FR-CON-03** **Declaração de origem obrigatória** por importação (origem, base legal, usuário, data).
- **FR-CON-04** Relatório pré-confirmação: linhas, válidas, inválidas, duplicadas, suprimidas.
- **FR-CON-05** Listas por cliente; contatos de um cliente **nunca** acessíveis a outro.
- **FR-CON-06** Lista de supressão (opt-out) por cliente, permanente, aplicada em toda importação e em todo disparo.

### 6.7 Template Manager
- **FR-TPL-01** Biblioteca de modelos (objetivo, idioma, categoria sugerida, componentes, variáveis, botões, mídia).
- **FR-TPL-02** Aplicação em lote: escolher modelo + clientes → gerar versão por cliente com variáveis preenchidas → submeter à WABA de cada um.
- **FR-TPL-03** Acompanhar status (pendente, aprovado, rejeitado, pausado, desativado), motivo de rejeição, categoria (incluindo reclassificação pela Meta) e qualidade.
- **FR-TPL-04** Taxa de aprovação por modelo da biblioteca.
- **FR-TPL-05** Botão de opt-out (quick reply) em templates de marketing; botão opcional de contato com o cliente.

### 6.8 Messaging Engine (Fase 8)
- **FR-MSG-01** Campanha = cliente + número + template aprovado + lista + agendamento + política de ondas.
- **FR-MSG-02** Validações pré-disparo: template aprovado, número conectado, qualidade aceitável, forma de pagamento ok, teto de custo, capacidade disponível.
- **FR-MSG-03** Congelamento da audiência no início (aplica supressão, deduplicação, frequência máxima).
- **FR-MSG-04** Processamento assíncrono com filas, isolamento por cliente (um cliente não atrasa outro), rate limiting por número.
- **FR-MSG-05** Idempotência: cada destinatário de campanha gera no máximo uma mensagem.
- **FR-MSG-06** Retry com backoff exponencial apenas para erros transitórios; DLQ com inspeção e reenvio manual.
- **FR-MSG-07** Envio em **ondas** com portão de qualidade entre ondas.
- **FR-MSG-08** Pausa automática por: queda de qualidade, template pausado, limite de spam/erro de ecossistema acima do limiar, falha de pagamento, token inválido, teto de custo.
- **FR-MSG-09** Processamento de webhooks de status (enviado, entregue, lido, falhou) e mensagens recebidas.
- **FR-MSG-10** Opt-out automático por palavra-chave e por botão; cancela envios pendentes daquele contato para o cliente.
- **FR-MSG-11** Respostas recebidas registradas e contabilizadas por campanha (sem atendimento — D-07).

### 6.9 Capacity Manager (Fase 9)
- **FR-CAP-01** Ler limite oficial por Business Portfolio (sincronização periódica + webhooks).
- **FR-CAP-02** Contabilizar destinatários únicos em janela móvel de 24h **por portfolio** (compartilhado por todos os números).
- **FR-CAP-03** Reservar capacidade de forma atômica antes de enfileirar; nunca exceder `limite × margem` (padrão 90%).
- **FR-CAP-04** Exibir capacidade disponível, reservada e usada por cliente; previsão de quando a campanha termina.
- **FR-CAP-05** Histórico de limites e mudanças de tier; alerta de clientes não verificados (presos em 250).

### 6.10 Custos
- **FR-COST-01** Tabela de preços por país/categoria com vigência (configurável; atualizada quando a Meta mudar).
- **FR-COST-02** Custo estimado antes da campanha e custo real por mensagem (via dados de cobrança dos webhooks/analytics — ⚠️ a validar).
- **FR-COST-03** Custo diário/mensal por cliente (mensagens + número), teto mensal opcional com bloqueio.
- **FR-COST-04** Previsão da fatura total do cartão do operador.

### 6.11 Dashboard administrativo (Fase 10)
- **FR-DASH-01** KPIs: clientes, estruturas conectadas, números, campanhas ativas, mensagens processadas/entregues, taxa de falha, restrições, qualidade média, capacidade total/disponível, status de workers e filas, custo do dia/mês.
- **FR-DASH-02** Tabelas com filtros, ordenação, busca e exportação.
- **FR-DASH-03** Gráficos de volume, entregas, falhas e custo.
- **FR-DASH-04** Dark mode, responsivo, padrão visual estilo Linear/Vercel/Stripe.

### 6.12 Relatórios para clientes
- **FR-REP-01** Exportar relatório de campanha (PDF/XLSX): enviadas, entregues, lidas, falhas, respostas, descadastros.

## 7. Requisitos não funcionais

| ID | Requisito |
|---|---|
| NFR-01 | Disponibilidade do painel e da API: 99,5% (MVP); ingestão de webhooks: 99,9%. |
| NFR-02 | RPO ≤ 5 min (PITR do banco); RTO ≤ 4 h. |
| NFR-03 | Webhook respondido em < 500 ms p99; processado em < 60 s p95. |
| NFR-04 | Capacidade comprovada por teste de carga: 1M destinatários/dia com picos de 300 msg/s agregados. |
| NFR-05 | Importação de 1M linhas em < 10 min. |
| NFR-06 | Tokens criptografados (envelope encryption com KMS); nunca exibidos nem logados. |
| NFR-07 | Isolamento de dados por cliente em aplicação **e** banco (RLS). |
| NFR-08 | Dados hospedados no Brasil (região São Paulo). |
| NFR-09 | Infraestrutura 100% como código; ambientes dev/staging/prod separados. |
| NFR-10 | Observabilidade: logs estruturados, métricas, tracing, alertas. |
| NFR-11 | LGPD: exclusão por cliente, auditoria, DPA, minimização em logs. |

## 8. Fluxos principais (resumo)

1. **Onboarding:** criar cliente → gerar link → cliente executa Embedded Signup → plataforma registra ativos → atribui número do estoque → verifica número → checklist (verificação da empresa, pagamento, nome exibido) → aplica templates da biblioteca → cliente `active`.
2. **Campanha:** receber planilha → importar com declaração → escolher template aprovado → criar campanha → validações → congelar audiência → ondas → disparo dentro da capacidade → webhooks → relatório.
3. **Incidente:** webhook de qualidade/erro → pausa automática → alerta → operador avalia → retoma ou encerra.

## 9. Dependências externas

- Meta: verificação da empresa do operador, app aprovado (acesso avançado), Tech Provider, webhooks.
- Provedor de números virtuais com API.
- AWS (região sa-east-1), Cloudflare, Grafana Cloud, Sentry.

## 10. Questões em aberto

- Escolha do provedor de números (critério: código de verificação por API + custo).
- Valores oficiais de preço em BRL publicados pela Meta (⚠️ a validar).
- Regra de cobrança de mensagens de serviço a partir de 01/10/2026 (não afeta D-07, mas afeta opção B futura).
- Ponte para o cliente urgente enquanto o App Review não sai (ver `07-riscos.md`, R-02).
