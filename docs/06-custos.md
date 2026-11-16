# 06 — Estimativa de Custos

> Status: **aguardando aprovação** · Valores **aproximados**, a confirmar com calculadoras oficiais e cotações.
> Câmbio ilustrativo: **US$ 1 = R$ 5,50**.

## 1. Visão geral: onde está o dinheiro

| Componente | Ordem de grandeza mensal (200 clientes a 250/dia) | Peso |
|---|---|---|
| **Mensagens Meta** | ~US$ 94 mil | **~99%** |
| Números virtuais | ~R$ 4–12 mil | < 1% |
| Infraestrutura + ferramentas | ~US$ 0,6–0,9 mil | < 1% |

**Conclusão:** o controle de custo por cliente (D-09) é o recurso financeiro mais importante da plataforma. Infraestrutura é irrelevante perto das mensagens.

## 2. Mensagens na Meta

### 2.1 Preços de referência (Brasil)

| Categoria | Preço por mensagem entregue | Fonte |
|---|---|---|
| Marketing | **~US$ 0,0625** (≈ R$ 0,34–0,39) | Fontes de parceiros (TalkAll, Monty Mobile, Message Central, Hyperleap) — ⚠️ a validar na tabela oficial |
| Utilidade | ~US$ 0,0068 (grátis dentro da janela de atendimento, segundo a documentação vigente até set/2026) | idem |
| Autenticação | ~US$ 0,0068 | idem |
| Serviço (respostas livres) | Gratuito até 30/09/2026; **possível cobrança a partir de 01/10/2026** (não confirmado pela Meta nas fontes consultadas) | respond.io, Chakra, fórum de desenvolvedores Meta |

- Desde 01/07/2025 a cobrança é **por mensagem de template entregue**, pelo país do destinatário.
- A Meta informou que publicaria preços em **BRL** a partir de 2026 — ⚠️ confirmar a tabela vigente.
- **D-07 (não responder) elimina o custo de mensagens de serviço.**

### 2.2 Cenários (uso total do limite todos os dias — pior caso)

| Cenário | Destinatários/dia | Mensagens/mês | Custo/mês (marketing) |
|---|---|---|---|
| 1 cliente a 250/dia | 250 | 7.500 | US$ 469 (≈ R$ 2,6 mil) |
| 1 cliente a 2.000/dia | 2.000 | 60.000 | US$ 3.750 (≈ R$ 20,6 mil) |
| **200 clientes a 250/dia** | 50.000 | 1,5 milhão | **US$ 93.750 (≈ R$ 516 mil)** |
| 200 clientes a 2.000/dia | 400.000 | 12 milhões | US$ 750.000 (≈ R$ 4,1 milhões) |
| 500 clientes (300 a 250 + 200 a 2.000) | 475.000 | 14,25 milhões | US$ 890.625 (≈ R$ 4,9 milhões) |

**Implicações para o seu negócio (cobrança fora da plataforma):**
- O cartão da empresa precisa de **limite compatível** com a fatura mensal da Meta — ou dividir entre cartões/WABAs. A plataforma prevê a fatura para evitar estouro (FR-COST-04).
- O seu "valor X" por cliente precisa cobrir, no mínimo, **custo de mensagens + número + margem**. O relatório de custo por cliente mostra isso mensalmente.
- Como você paga antes de receber, recomendo **teto mensal por cliente** e receber adiantado. Ver R-05.
- No modo BSP (futuro), a linha de crédito da Meta muda o fluxo de caixa (pós-pago com limite de crédito) — avaliar na época.

## 3. Números virtuais (D-13)

| Item | Estimativa |
|---|---|
| Mensalidade por número | R$ 20–60 (⚠️ cotar provedores; critério obrigatório: entrega do código de verificação por API) |
| 200 clientes | R$ 4–12 mil/mês |
| 500 clientes | R$ 10–30 mil/mês |
| Quarentena | Números em quarentena continuam pagos (custo do reuso seguro) |

## 4. Infraestrutura AWS sa-east-1 (estimativa)

### 4.1 Patamar Lançamento (≤ 500 clientes, ≤ 1M destinatários/dia)

| Recurso | Configuração | US$/mês |
|---|---|---|
| ECS Fargate | web 1× (0,5 vCPU/1 GB), api 2× (0,5/1), webhooks 2× (0,25/0,5), workers 2–4× (1/2) | 130–200 |
| RDS PostgreSQL | `db.t4g.medium` Multi-AZ, 200 GB gp3, PITR | 160–220 |
| ElastiCache Redis | `cache.t4g.small` primário + réplica | 50–70 |
| ALB | 1 | 25–35 |
| NAT Gateway + Elastic IP | 1 (IP fixo de saída) + tráfego | 45–70 |
| S3 + transferência | uploads, arquivo, exports | 10–30 |
| KMS, Secrets Manager, ECR, CloudWatch mínimo | — | 15–30 |
| **Subtotal produção** | | **~435–655** |
| Staging (dimensionamento mínimo, desligável fora de horário) | | 100–180 |
| Conta de backup (snapshots + réplica S3) | | 20–50 |

### 4.2 Ferramentas

| Ferramenta | US$/mês |
|---|---|
| Cloudflare (DNS, WAF, Access até 50 usuários) | 0–25 |
| Grafana Cloud (free tier → pago conforme volume de logs) | 0–100 |
| Sentry | 0–30 |
| GitHub (repositório privado/Actions) | 0–20 |
| Provedor de e-mail transacional (SES) | < 5 |

**Total infraestrutura + ferramentas (Lançamento): ~US$ 560–1.000/mês (≈ R$ 3–5,5 mil).**

### 4.3 Patamares seguintes (projeção)

| Patamar | US$/mês |
|---|---|
| Crescimento (≤ 3.000 clientes, ≤ 6M/dia) | 1.500–3.500 |
| Grande escala | 4.000+ (depende de arquitetura de dados escolhida) |

## 5. Custos únicos

| Item | Custo |
|---|---|
| Verificação de empresa, app e App Review da Meta | Sem custo direto |
| Revisão jurídica do DPA e termos (recomendado) | A cotar |
| Desenvolvimento | Seu tempo (1 dev) |

## 6. Alavancas de redução de custo

1. **Verificação das empresas dos clientes** — não reduz preço, mas evita desperdiçar números/infra em clientes presos em 250.
2. **Qualidade** — mensagens bloqueadas/denunciadas reduzem o limite e, portanto, a receita por número.
3. **Categoria correta** — conteúdo transacional legítimo como Utilidade custa ~9× menos que Marketing (a Meta reclassifica abusos; não usar como truque).
4. **Desligar staging fora do horário** e usar Savings Plans quando o uso estabilizar.
5. **Arquivamento** de partições antigas em S3 (Parquet) em vez de crescer o RDS.

## Fontes consultadas
- [Meta — Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md)
- [TalkAll — Tarifas WhatsApp 2026](https://talkall.com.br/en/novidades/tarifas-whatsapp-2026)
- [Monty Mobile — WhatsApp Business API Pricing 2026](https://montymobile.com/newsroom/whatsapp-business-api-pricing-the-complete-2026-cost-guide-for-enterprise-teams/)
- [Message Central — WhatsApp Business API pricing Brazil](https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil)
- [Hyperleap — Pricing calculator Brazil](https://hyperleap.ai/whatsapp-pricing-calculator-brazil)
- [respond.io — WhatsApp pricing change 2026](https://respond.io/blog/whatsapp-pricing-change-2026)
- [Chakra — Service messages charged from October 2026](https://articles.chakrahq.com/article/whatsapp-api-pricing-update-service-messages-october-2026/)
