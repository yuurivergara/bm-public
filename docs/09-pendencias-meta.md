# 09 — Pendências de Validação Meta e Checklist do Operador

> D-15: `developers.facebook.com` está bloqueado neste ambiente. Os itens abaixo foram levantados em documentação de parceiros e **devem ser validados na documentação oficial** antes de implementar a integração correspondente. Para validar a partir daqui, o domínio precisa ser liberado nas configurações de rede do ambiente.

## 1. Itens a validar

| # | Item | Usado em | Situação |
|---|---|---|---|
| V-01 | Tiers de limite (250 / 2K / 10K / 100K / ilimitado) e existência do tier 10K | Capacity | ✅ validado em 2026-11-16 — 250 / 2K / 10K / 100K / ilimitado; o 10K existe (10-meta-referencia.md §5) |
| V-02 | Critérios de upgrade (≥ 50% do limite em 7 dias + qualidade Média/Alta; avaliação a cada ~6 h) | Capacity / painel | ⚠️ diverge (2026-11-16): 250→2K só por *scaling path* (verificação, verificação pelo parceiro ou 2.000 entregas em 30 dias com templates de alta qualidade); a partir de 2K: alta qualidade + ≥ 50% do limite em 7 dias → sobe 1 nível em até 6 h (10-meta-referencia.md §5) |
| V-03 | Limite no nível do portfolio desde 07/10/2025 | Capacity | ✅ validado em 2026-11-16 — limite no nível do portfolio, compartilhado entre números; a data 07/10/2025 não aparece na doc atual (10-meta-referencia.md §5) |
| V-04 | Campo `whatsapp_business_manager_messaging_limit` (e depreciação de `messaging_limit_tier`) | Sync | ✅ validado em 2026-11-16 — `whatsapp_business_manager_messaging_limit` no número (Phone Number API) e no nó Business; `messaging_limit_tier` depreciado; no nó WABA não está documentado (10-meta-referencia.md §4.6) |
| V-05 | Throughput: 80 msg/s padrão, até 1.000; 20 msg/s em coexistência; campo `throughput` | Sender | ✅ validado em 2026-11-16 — 80 msg/s padrão, até 1.000 automático, 20 msg/s em coexistência; campo `throughput` existe, mas o formato da resposta não está documentado (10-meta-referencia.md §5, §4.3) |
| V-06 | Verificação da empresa necessária para sair de 250 | Onboarding | ⚠️ diverge (2026-11-16): verificação **não** é obrigatória; é um dos três caminhos para sair de 250 (10-meta-referencia.md §5) |
| V-07 | Permissões e acesso avançado: `whatsapp_business_management`, `whatsapp_business_messaging`, `public_profile`; requisitos atuais do App Review (vídeos) | Trilha Meta | Fontes de parceiros |
| V-08 | Retorno do Embedded Signup (code, WABA ID, phone number ID), tipo de token e troca | Provisioning | Fontes de parceiros |
| V-09 | Se é possível operar ativos compartilhados por parceria sem acesso avançado | R-02 | Desconhecido |
| V-10 | Fluxo de registro de número (adicionar, request_code, verify_code, register com PIN) para número fornecido pelo operador numa WABA do cliente | Number Inventory | Conhecimento prévio |
| V-11 | Lista de campos de webhook e formato dos payloads (incluindo dados de cobrança em status) | Webhooks / custos | ✅ validado em 2026-11-16 — lista de campos + payloads verbatim; faltavam `user_preferences` e `security`; BSUID/`user_id` em todos os webhooks (10-meta-referencia.md §2–3) |
| V-12 | Catálogo de códigos de erro (130429, 131026, 131042, 131048, 131049, 131056, 132xxx, 190, 368…) | Sender | ✅ validado em 2026-11-16 — todos os códigos supostos existem; novos relevantes: 131050, 131064, 130497, 135000, 131057, 131062; 133001–133003/133007 não constam (10-meta-referencia.md §6) |
| V-13 | Preços no Brasil (marketing ~US$ 0,0625; utilidade/autenticação ~US$ 0,0068) e tabela em BRL | Custos | Fontes de parceiros |
| V-14 | Cobrança de mensagens de serviço desde 01/10/2026 e franquia gratuita | Custos / opção B | ⚠️ parcial (2026-11-16): a ref. de status diz que desde 01/10/2026 `pricing.type=regular` inclui serviço após a franquia gratuita do número; valores e franquia não verificados (10-meta-referencia.md §3.1) |
| V-15 | Limite de mensagens de marketing por usuário (erro de ecossistema) e boas práticas | Sender | ⚠️ parcial (2026-11-16): erro 131049 confirmado (esperar ≥ 24 h); a página de limites por usuário não foi lida (10-meta-referencia.md §6) |
| V-16 | Regras de reuso de número entre WABAs (desregistro, migração, prazos) | Number Inventory | Conhecimento prévio |
| V-17 | Quantidade máxima de números por portfolio/WABA | Number Inventory | ⚠️ parcial (2026-11-16): 2 números registrados por portfolio novo → 20 após verificação ou tier 2K; até 20 hierarquias de WhatsApp account; exemplo de `max_phone_numbers_per_waba` = 25 (10-meta-referencia.md §5) |
| V-18 | Compartilhamento de linha de crédito (modo BSP) por API | Pós-MVP | Conhecimento prévio |
| V-19 | Versão vigente da Graph API e calendário de depreciação | meta-client | ✅ validado em 2026-11-16 — v27.0 (04/11/2026); próximas remoções: v21.0 em 21/01/2027, v22.0 em 20/05/2027 (10-meta-referencia.md §1) |
| V-20 | Marketing Messages API: aplicabilidade e requisitos | Pós-MVP | A investigar |
| V-21 | Botão de opt-out em templates de marketing (formato e webhook) | Templates / opt-out | ⚠️ parcial (2026-11-16): o webhook do botão de resposta rápida (`type: button`, payload "Unsubscribe") e o `user_preferences` (stop/resume) foram confirmados; o formato do botão de opt-out no template não foi verificado (10-meta-referencia.md §3.2–3.3) |
| V-22 | Restrição temporária de mensagens entre países envolvendo o Brasil (citada por uma fonte) | Premissa P-01 | Não verificado; provavelmente não se aplica (BR→BR) |

## 2. Checklist do operador (Trilha Meta)

- [ ] Business Manager da sua empresa criado, com 2+ administradores (evitar perda de acesso).
- [ ] Verificação da empresa enviada (documentos do CNPJ, domínio/site, telefone).
- [ ] Domínio próprio com e-mail corporativo.
- [ ] Política de privacidade e termos de uso publicados (podemos redigir juntos).
- [ ] App criado no Meta for Developers (tipo Business), vinculado ao Business Manager verificado.
- [ ] Produto WhatsApp adicionado; número de teste funcionando (envio para seu próprio número).
- [ ] Webhook do app apontando para o staging.
- [ ] Vídeos de demonstração para o App Review gravados (roteiro fornecido na S2).
- [ ] App Review enviado.
- [ ] Requisitos de Tech Provider concluídos e Embedded Signup configurado.
- [ ] Cartão da empresa com limite compatível com a fatura prevista (ver `06-custos.md`).
- [ ] Provedor de números escolhido (critério: código de verificação por API).
- [ ] Modelo de DPA revisado juridicamente.

## 3. Fontes consultadas (parceiros e documentação Meta indexada)

- [Meta — Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md)
- [Meta — Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput)
- [Meta — Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [Meta — Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md)
- [360dialog — Messaging Limits & Quality Rating](https://docs.360dialog.com/partner/messaging/messaging-health-and-troubleshooting/messaging-limits-and-quality-rating)
- [Twilio — Tech Provider program integration guide](https://static1.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)
- [Telnyx — Tech Provider](https://developers.telnyx.com/docs/messaging/whatsapp/embedded-signup/tech-provider)
- [InsiderOne — Messaging Limits for WhatsApp](https://academy.insiderone.com/docs/messaging-limits-for-whatsapp)
- [respond.io — WhatsApp pricing change 2026](https://respond.io/blog/whatsapp-pricing-change-2026)
- [ChatArchitect — Upcoming messaging limits changes](https://support.chatarchitect.com/books/meta-whatsapp/chapter/upcoming-messaging-limits-changes/export/plaintext)
