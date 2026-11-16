# 09 — Pendências de Validação Meta e Checklist do Operador

> D-15: `developers.facebook.com` está bloqueado neste ambiente. Os itens abaixo foram levantados em documentação de parceiros e **devem ser validados na documentação oficial** antes de implementar a integração correspondente. Para validar a partir daqui, o domínio precisa ser liberado nas configurações de rede do ambiente.

## 1. Itens a validar

| # | Item | Usado em | Situação |
|---|---|---|---|
| V-01 | Tiers de limite (250 / 2K / 10K / 100K / ilimitado) e existência do tier 10K | Capacity | Fontes conflitam sobre o 10K |
| V-02 | Critérios de upgrade (≥ 50% do limite em 7 dias + qualidade Média/Alta; avaliação a cada ~6 h) | Capacity / painel | Fontes de parceiros |
| V-03 | Limite no nível do portfolio desde 07/10/2025 | Capacity | Consistente entre fontes |
| V-04 | Campo `whatsapp_business_manager_messaging_limit` (e depreciação de `messaging_limit_tier`) | Sync | Doc Meta via busca |
| V-05 | Throughput: 80 msg/s padrão, até 1.000; 20 msg/s em coexistência; campo `throughput` | Sender | Doc Meta via busca |
| V-06 | Verificação da empresa necessária para sair de 250 | Onboarding | Fontes de parceiros |
| V-07 | Permissões e acesso avançado: `whatsapp_business_management`, `whatsapp_business_messaging`, `public_profile`; requisitos atuais do App Review (vídeos) | Trilha Meta | Fontes de parceiros |
| V-08 | Retorno do Embedded Signup (code, WABA ID, phone number ID), tipo de token e troca | Provisioning | Fontes de parceiros |
| V-09 | Se é possível operar ativos compartilhados por parceria sem acesso avançado | R-02 | Desconhecido |
| V-10 | Fluxo de registro de número (adicionar, request_code, verify_code, register com PIN) para número fornecido pelo operador numa WABA do cliente | Number Inventory | Conhecimento prévio |
| V-11 | Lista de campos de webhook e formato dos payloads (incluindo dados de cobrança em status) | Webhooks / custos | Conhecimento prévio |
| V-12 | Catálogo de códigos de erro (130429, 131026, 131042, 131048, 131049, 131056, 132xxx, 190, 368…) | Sender | Conhecimento prévio |
| V-13 | Preços no Brasil (marketing ~US$ 0,0625; utilidade/autenticação ~US$ 0,0068) e tabela em BRL | Custos | Fontes de parceiros |
| V-14 | Cobrança de mensagens de serviço desde 01/10/2026 e franquia gratuita | Custos / opção B | Não confirmado oficialmente |
| V-15 | Limite de mensagens de marketing por usuário (erro de ecossistema) e boas práticas | Sender | Conhecimento prévio |
| V-16 | Regras de reuso de número entre WABAs (desregistro, migração, prazos) | Number Inventory | Conhecimento prévio |
| V-17 | Quantidade máxima de números por portfolio/WABA | Number Inventory | Desconhecido |
| V-18 | Compartilhamento de linha de crédito (modo BSP) por API | Pós-MVP | Conhecimento prévio |
| V-19 | Versão vigente da Graph API e calendário de depreciação | meta-client | Desconhecido |
| V-20 | Marketing Messages API: aplicabilidade e requisitos | Pós-MVP | A investigar |
| V-21 | Botão de opt-out em templates de marketing (formato e webhook) | Templates / opt-out | Conhecimento prévio |
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
