# 00 — Registro de Decisões (Discovery)

> Status: **aguardando aprovação** · Fonte: entrevista de discovery (perguntas 1–14)
> Convenção: cada decisão tem um ID (`D-xx`) referenciado nos demais documentos.

| ID | Tema | Decisão | Consequência principal |
|---|---|---|---|
| D-01 | Modelo de negócio | **BSP (Solution Partner) como destino; entrada como Tech Provider.** | Plataforma nasce preparada para linha de crédito, mas opera inicialmente com pagamento por WABA. Troca de modo é configuração. |
| D-02 | Propriedade dos ativos | **Business Portfolios e WABAs pertencem aos clientes.** O operador (você) acessa por mecanismos oficiais. | Sem BMs próprias para disparo em nome de terceiros. |
| D-03 | Origem dos contatos | **Base própria de cada cliente**, enviada em planilha/TXT. Importação com validação, deduplicação, supressão e **declaração de origem obrigatória**. | Cliente = controlador (LGPD); você = operador. |
| D-04 | Usuários da plataforma | **Uso exclusivo do operador.** Clientes não acessam a plataforma. | Sem portal do cliente (seção 13 e Fase 11 do prompt original removidas). RBAC mínimo para operadores futuros. |
| D-05 | Conexão das BMs | **Embedded Signup como padrão**, compartilhamento por parceria como alternativa. **Proibido armazenar login/senha do Facebook** ou automatizar login. Clientes sem BM criam a sua dentro do Embedded Signup. | Provisioning Engine com dois caminhos; campanha de migração dos ~200 clientes atuais. |
| D-06 | Escala | Arquitetura em 3 patamares: **Lançamento (≤500 clientes, ≤1M destinatários/dia)**, Crescimento (≤3.000 / ≤6M), Grande escala. Cada patamar comprovado por teste de carga. | Escala horizontal por workers sem estado; tabelas de mensagens particionadas desde o dia 1. |
| D-07 | Respostas dos contatos | **Não são atendidas (opção A).** Opt-out automático, respostas registradas e contabilizadas, botão opcional de contato no template. Opção B (auto-resposta) fica disponível como flag futura. | Sem módulo de inbox. Sem custo de mensagens de serviço. |
| D-08 | Templates | **Biblioteca de modelos com variáveis** + submissão em lote para a WABA de cada cliente + acompanhamento de status/categoria/qualidade. Texto personalizado como exceção. | Módulo Template Manager. |
| D-09 | Cobrança | **Fora da plataforma.** Meta é paga com **cartão da empresa do operador**, configurado no billing da Meta de cada WABA (não na plataforma). Plataforma registra **custo por cliente**, com **teto opcional** e alertas de falha de pagamento. | Tabelas `subscriptions`/`billing_events` removidas; entram `pricing_rates` e `cost_daily`. Nenhum dado de cartão armazenado. |
| D-10 | Equipe | **1 desenvolvedor (operador) + Claude.** | Simplicidade operacional máxima: monólito modular + workers, serviços gerenciados, sem Kubernetes no início. |
| D-11 | Prazo | **O quanto antes.** MVP 1 (4–6 semanas) para cliente urgente e piloto; MVP 2 (+4–6 semanas) para migração em escala. | Trilha de aprovação Meta começa na semana 1, em paralelo ao código. |
| D-12 | Estado atual | Hoje usa ferramenta não oficial (Evolution). **Não há empresa verificada nem app Meta.** Migração para API oficial (Cloud API). | Verificação da empresa + criação do app + App Review são caminho crítico. |
| D-13 | Números | **Operador fornece números virtuais**, **um número ativo por cliente** (um número só pode estar em uma WABA por vez). Contratação sob demanda; reuso apenas após saída do cliente e **quarentena**. **Rodízio de números entre BMs: fora de escopo.** | Módulo Number Inventory; provedor precisa entregar código de verificação por API. |
| D-14 | Retenção | **Dados mantidos até o operador excluir.** Isolamento rígido por cliente (dados de um cliente nunca usados por outro). Exclusão por cliente/campanha/período sob demanda. Histórico antigo vai para arquivamento barato e consultável. | Arquivamento particionado por cliente para permitir exclusão; recomendação de contrato de tratamento de dados (DPA) com cada cliente. |
| D-16 | Hospedagem do MVP | **VPS (docker compose) no MVP e piloto**, em vez de AWS. Condições: backup contínuo fora da VPS com restauração testada, servidor endurecido atrás da Cloudflare, monitor externo com alerta; plataforma isolada da Evolution. AWS/serviços gerenciados ficam como evolução (primeiro passo: banco gerenciado). | Custo inicial ~US$ 30–80/mês; Terraform AWS substituído por script de provisionamento + deploy via GitHub Actions (SSH, GHCR); sem KMS no início (chave mestra fora do banco). |
| D-15 | Documentação Meta | `developers.facebook.com` indisponível neste ambiente. **Autorizado** seguir com fontes de parceiros, marcando itens como **⚠️ a validar**. | Lista de validação em `09-pendencias-meta.md`, a fechar antes da implementação de cada integração. |

## Fora de escopo (decisões explícitas)

- Portal/dashboard para clientes (D-04).
- Faturamento, cobrança, saldo, Pix/boleto (D-09).
- Caixa de entrada / atendimento de respostas (D-07).
- Rodízio de números entre BMs, "aquecimento" artificial, variação de texto para evadir detecção, proxies rotativos, multi-login (D-13 e itens 9/11 do prompt).
- APIs não oficiais (WhatsApp Web, Baileys, Evolution) (D-12).
- Armazenamento de credenciais de contas Facebook (D-05).
- Uso de contatos de um cliente em campanhas de outro (D-14).

## Premissas a confirmar

- P-01: Clientes são empresas brasileiras com CNPJ, enviando para destinatários no Brasil.
- P-02: Cada cliente terá, no lançamento, 1 Business Portfolio, 1 WABA e 1 número.
- P-03: Templates majoritariamente de categoria **Marketing**.
- P-04: O operador conseguirá a verificação da própria empresa na Meta.
