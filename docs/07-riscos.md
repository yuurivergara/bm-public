# 07 — Análise de Riscos

> Status: **aguardando aprovação** · Escala: Probabilidade (P) e Impacto (I) em Baixo/Médio/Alto

| ID | Risco | P | I | Mitigação | Gatilho / resposta |
|---|---|---|---|---|---|
| **R-01** | **App Review demora ou é rejeitado** (sem acesso avançado não há envio pelas BMs dos clientes) | M | **A** | Iniciar T1–T4 na semana 1; política de privacidade e termos prontos; vídeos de demonstração caprichados; uso descrito com precisão (Tech Provider, opt-in, opt-out) | Rejeição → ajustar conforme o motivo e reenviar em ≤ 48 h |
| **R-02** | **Cliente urgente antes da aprovação** | A | M | (1) ⚠️ Verificar se, com acesso padrão, é possível operar ativos compartilhados por parceria (provavelmente não); (2) ponte: o cliente urgente contrata temporariamente um BSP existente e migra para sua plataforma depois, sem perder a WABA; (3) não usar a Evolution como ponte para esse cliente (risco de bloqueio do número que depois vai para a API) | Decisão sua na semana 1 |
| **R-03** | **Qualidade das listas dos clientes** derruba limites/números e afeta a reputação do app | A | **A** | Declaração de origem, supressão, ondas com portões, pausa automática, isolamento por cliente, frequência máxima por contato, painel de saúde, possibilidade de bloquear cliente problemático | Queda de qualidade → pausa + revisão com o cliente antes de retomar |
| **R-04** | **Cartão único** recusado/estourado → todos os clientes param | M | **A** | Previsão de fatura, alerta de erro de pagamento, opção de dividir clientes entre cartões, cartão reserva cadastrado | Erro de pagamento → pausa automática dos clientes afetados + alerta crítico |
| **R-05** | **Exposição financeira**: você paga a Meta antes de receber dos clientes | A | A | Teto mensal por cliente, relatório de custo, recomendação de cobrança antecipada (fora da plataforma) | Teto atingido → bloqueio de novas campanhas |
| **R-06** | **Mudanças da Meta** (preços, limites, campos de API, versões, cobrança de serviço desde out/2026) | **A** | M | Preços em tabela com vigência; versão da Graph API configurável; catálogo de erros centralizado; acompanhar changelog; testes de contrato | Mudança anunciada → avaliação e ajuste dentro do prazo de depreciação |
| **R-07** | **Provedor de números não entrega o código por API** → onboarding manual | M | M | Critério eliminatório na escolha; segundo provedor homologado; fallback manual na plataforma | Falha recorrente → troca de provedor |
| **R-08** | **LGPD**: retenção indefinida (D-14), operador com dados de milhões de pessoas | M | **A** | DPA com clientes, isolamento rígido, criptografia, exclusão por cliente, auditoria, minimização em logs, plano de resposta a incidentes, região Brasil | Incidente → plano de resposta (notificação à ANPD/clientes conforme a lei) |
| **R-09** | **Bus factor = 1** (único desenvolvedor) | A | A | Infra como código, documentação viva, testes automatizados, runbooks, serviços gerenciados, alertas acionáveis | — |
| **R-10** | **Vazamento de tokens** dá acesso às WABAs dos clientes | B | **A** | Envelope encryption KMS, sem exibição/log, acesso restrito, rotação, auditoria de uso, `appsecret_proof` | Suspeita → revogar tokens (debug/descadastro do app), reconectar clientes |
| **R-11** | **Perda de webhooks** (indisponibilidade da ingestão) | B | M | Ingestão mínima e redundante (2+ tarefas), retries da Meta, reconciliação periódica via API | Lag > 5 min → alerta |
| **R-12** | **Mensagens duplicadas** (timeouts ambíguos) | M | M | Idempotência por destinatário, política `uncertain` sem reenvio automático | Taxa de `uncertain` > 0,5% → investigar |
| **R-13** | **Clientes não verificados** ficam presos em 250 | A | M | Checklist de verificação no onboarding, painel e lembretes | — |
| **R-14** | **Escopo cresce** e o prazo escorrega | A | M | MVP 1/MVP 2 com escopo fechado; backlog pós-MVP explícito; revisão semanal | Desvio > 1 semana → repriorizar |
| **R-15** | **Pressão por práticas de evasão** (rodízio de números, aquecimento artificial, BMs de terceiros) | M | **A** | Fora de escopo por decisão (D-13 e itens 9/11 do prompt); essas práticas colocam o app inteiro e o credenciamento BSP em risco | — |
| **R-16** | **Bloqueio de conta de cliente por política** | M | M | Procedimento de revisão (abaixo), pausa automática, histórico de saúde | Restrição → procedimento |
| **R-17** | **Custo da AWS acima do previsto** | B | B | Budgets e alertas de custo da AWS, revisão mensal | Alerta de orçamento |

## Procedimento de recuperação e revisão de contas restritas (item 17 do prompt)

1. **Detecção:** webhook (`account_update`, qualidade) ou erro de política → pausa automática do cliente + alerta crítico.
2. **Diagnóstico:** a plataforma reúne o motivo informado pela Meta, as últimas campanhas, os templates, as taxas de bloqueio/opt-out e a origem declarada das listas.
3. **Contenção:** nenhuma campanha do cliente é retomada até a revisão; não migrar o número nem trocar de BM para "fugir" da restrição.
4. **Correção:** ajustar lista (limpeza, recorte por clientes recentes), template e frequência junto ao cliente.
5. **Recurso oficial:** se a restrição for indevida, solicitar revisão pelos canais oficiais da Meta (Business Support / Gerenciador do WhatsApp).
6. **Retomada gradual:** reiniciar com ondas pequenas e portões mais rígidos; monitorar 7 dias.
7. **Registro:** tudo documentado no histórico do cliente e na auditoria.
