# 10 — Referência Meta (WhatsApp Cloud API) validada na documentação oficial

> Levantado em **2026-11-16** direto em `developers.facebook.com` (variantes `.md` das páginas novas e HTML das
> páginas `/docs/graph-api/...`). Encerra a restrição de D-15 para os itens abaixo. Os JSONs marcados "verbatim" foram
> copiados da documentação sem alteração. Os itens que a doc **não** confirma estão marcados "⚠️ não confirmado".
> Prefixo das URLs abaixo: `WA = https://developers.facebook.com/documentation/business-messaging/whatsapp`.

## 0. Mudanças de contexto que afetam o projeto (ler primeiro)

1. **Modelo de contas novo (WAAC + Messaging account).** A WABA está sendo dividida em *WhatsApp account* (WAAC, 1 número)
   e *Messaging account* (templates, cobrança, assinaturas de webhook). **O WABA ID passa a identificar a Messaging account**
   (mesmo ID, mesmos endpoints). Fase 1: GA a partir de 23/09/2026 (todos até meados de out/2026); Fase 2 (H1 2027):
   IDs de WAAC, tópico de webhook `whatsapp_account`, `messaging_account_id` exigido em cenários com várias Messaging
   accounts; **Fase 3 (H1 2028): APIs com phone-number-ID no path passam a exigir WAAC ID.** O PIN 2FA está sendo
   depreciado para números elegíveis. Throughput continua por número; limite de mensagens continua por portfolio.
   Fonte: `WA/account-model-evolution.md`, `WA/whatsapp-business-accounts.md`.
2. **Usernames e BSUID.** Desde abr/2026 todo webhook traz `user_id` (*business-scoped user ID*, ex.: `US.13491208655302741918`,
   escopo = portfolio). Se o usuário adotar username, **`wa_id`/`from`/`recipient_id` podem vir ausentes**. Envio aceita
   `recipient` (BSUID) além de `to`. Novo erro `131062`. Fonte: `WA/business-scoped-user-ids.md`. Impacto: hoje o
   modelo identifica contato só por telefone (`normalizePhone`) — precisa aceitar BSUID.
3. **Pacing.** Templates podem ficar retidos (`message_status: held_for_quality_assessment`) por *template pacing* e
   *business portfolio pacing* (portfolios com < 500 mil templates em 365 dias). Mensagens retidas descartadas geram
   status `failed` com `132015` (template pausado) ou `135000` (portfolio pacing).
   Fontes: `WA/templates/template-pacing.md`, `WA/templates/portfolio-pacing.md`.

## 1. Versão da Graph API (V-19)

Fonte: https://developers.facebook.com/documentation/development/graph-api/changelog.md e `.../changelog/version27.0.md`

- **Vigente: v27.0** (lançada em 04/11/2026). Os exemplos da doc do WhatsApp já usam `v27.0`.

| Versão | Lançada | Disponível até |
|---|---|---|
| v27.0 | 04/11/2026 | TBD |
| v26.0 | 29/07/2026 | TBD |
| v25.0 | 18/02/2026 | 29/07/2028 |
| v24.0 | 08/10/2025 | 18/02/2028 |
| v23.0 | 29/05/2025 | 08/10/2027 |
| v22.0 | 21/01/2025 | **20/05/2027** |
| v21.0 | 02/10/2024 | **21/01/2027** (próxima remoção) |
| v20.0 | 21/05/2024 | 24/09/2026 (já removida) |

- Diferenças por versão que afetam webhooks: em **v24.0+ o objeto `conversation` é omitido** dos status (exceto janela
  de *free entry point*); `max_daily_conversation_per_phone`/`current_limit`/`old_limit` estavam marcados para remoção em
  fev/2026 (ver §3). Recomendação: fixar `META_GRAPH_VERSION=v27.0`.

## 2. Webhooks — verificação, assinatura, entrega

Fontes: `WA/webhooks/create-webhook-endpoint.md`, `WA/webhooks/overview.md`, `WA/throughput.md`,
https://developers.facebook.com/docs/graph-api/webhooks/getting-started

### 2.1 Verificação (GET)
```
GET <CALLBACK_URL>?hub.mode=subscribe&hub.challenge=<HUB.CHALLENGE>&hub.verify_token=<HUB.VERIFY_TOKEN>
```
- Comparar `hub.verify_token` com o valor guardado. Válido → **HTTP 200 com o valor de `hub.challenge` no corpo**.
  Inválido → 4xx (ou qualquer coisa ≠ 200). Enviado sempre que Callback URL ou Verify token são alterados no App Dashboard.
- A doc não exige checar `hub.mode`, mas o valor enviado é `subscribe`.
- Certificado TLS válido obrigatório (self-signed não). mTLS é opcional.

### 2.2 Assinatura (POST)
```
POST <CALLBACK_URL>
Content-Type: application/json
X-Hub-Signature-256: sha256=<SHA256_PAYLOAD_HASH>
```
- `<SHA256_PAYLOAD_HASH>` = **HMAC-SHA256 do corpo do POST, chave = App Secret**, em hex (exemplo da doc:
  `b63bb356dff0f1c24379efea2d6ef0b2e2040853339d1bcf13f9018790b1f7d2`). Comparar com tudo após `sha256=`.
- "Corpo bruto": a doc diz "post body payload"/"JSON payload as the message input". ⚠️ Não diz literalmente "bytes
  crus", mas o HMAC só bate sobre os bytes recebidos — calcular sobre o raw body antes de qualquer parse (inferência).
- Não há API para buscar webhooks históricos: **guardar o payload**.

### 2.3 Resposta, retries, duplicatas, ordem
- Válido → **HTTP 200**. Qualquer outro código ou falha de entrega → a Meta **reenvia imediatamente e depois com
  frequência decrescente (backoff exponencial) por até 7 dias**; não confirmados são descartados após 7 dias.
  (A página genérica da Graph API ainda diz 36 h; a do WhatsApp diz 7 dias.)
- Retries vão a **todos os apps assinantes** da conta → **duplicatas**; deduplicar no servidor.
- Lotes de até **1000 updates** por POST (sem garantia de agrupamento). Payload até **3 MB**.
- Latência exigida (página Throughput): **mediana ≤ 250 ms; < 1% acima de 1 s**; entregas concorrentes; dimensionar para
  3× o tráfego de saída (status) + 1× o de entrada.
- ⚠️ **Timeout exato não documentado.** ⚠️ **Ordem não garantida/documentada**; a doc só avisa que, se a mensagem for lida
  na hora, o `delivered` **não é enviado** (fica implícito no `read`).
- App em modo **Dev** pode não receber alguns webhooks.
- Permissões: `whatsapp_business_messaging` (campos `messages`, `calls`); `whatsapp_business_management` (demais).

### 2.4 Envelope
```
{ "object": "whatsapp_business_account",
  "entry": [ { "id": "<WABA/Messaging account ID>", "time": <unix>,   // "time" ausente nos payloads do campo messages
               "changes": [ { "field": "<nome do campo>", "value": { ... } } ] } ] }
```
`entry[].id` é o **Messaging account ID (= WABA ID)** em todos os campos. Em `messages`, `value` traz
`messaging_product`, `metadata.display_phone_number`, `metadata.phone_number_id` e `contacts`/`messages`/`statuses`/`errors`.

## 3. Campos de webhook (V-11)

Fonte: `WA/webhooks/overview.md#fields` e `WA/webhooks/reference/<campo>.md`

| Campo | Para que serve |
|---|---|
| `account_alerts` | Mudanças de limite de mensagens (aumento negado/adiado/precisa info), OBA, foto do perfil |
| `account_review_update` | Resultado da revisão da conta contra políticas (`decision`) |
| `account_update` | Violações/restrições de política, banimento, parceiro adicionado/removido, app instalado/desinstalado, conta deletada, offboarding etc. |
| `automatic_events` | Eventos de compra/lead em conversas vindas de anúncio CTWA |
| `business_capability_update` | Mudança de capacidade do portfolio/hierarquia: **limite de mensagens**, limite de números |
| `calls` | Eventos de chamadas |
| `history` | Sincronização de histórico (coexistência com app Business) |
| `message_template_components_update` | Mudança de componentes do template |
| `message_template_quality_update` | Mudança de qualidade do template |
| `message_template_status_update` | Mudança de status do template (aprovado, rejeitado, pausado, desativado...) |
| `messages` | Mensagens recebidas e **status** de mensagens enviadas (+ erros) |
| `partner_solutions` | Status de Multi-Partner Solution |
| `payment_configuration_update` | Pagamentos Índia/Brasil |
| `phone_number_name_update` | Resultado da verificação do nome exibido |
| `phone_number_quality_update` | Mudança de **throughput** do número (e, legado, de limite) |
| `security` | Mudanças nas configurações de segurança do número |
| `smb_app_state_sync`, `smb_message_echoes` | Coexistência com app WhatsApp Business |
| `template_category_update` | Reclassificação de categoria do template |
| `user_preferences` | Usuário **parou/retomou** mensagens de marketing (opt-out oficial) |

Divergências vs. `04-endpoints.md §2.1`: todos os 10 campos supostos existem; faltavam **`user_preferences`** (essencial para
opt-out/LGPD) e `security`. `phone_number_quality_update` hoje é sobre throughput, não qualidade.

### 3.1 `messages` — status (sintaxe resumida)
`statuses[]`: `id` (wamid), `status` (`sent` | `delivered` | `read` | `failed` | `played`), `timestamp`, `recipient_id`
(telefone; omitido se enviado a BSUID sem telefone disponível), `recipient_user_id` (BSUID; omitido em `failed` enviado a
telefone), `biz_opaque_callback_data` (se enviado), `conversation` (omitido em v24+ salvo free entry point),
`pricing` (só em `sent` e em **um** de `delivered`/`read`), `errors[]` (só em falha).
`pricing`: `billable` (será depreciado), `pricing_model` (`PMP`; `CBP` só antes de 01/07/2025), `type`
(`regular` | `free_customer_service` | `free_entry_point` | `free_group_customer_service`), `category`
(`authentication`, `authentication-international`, `marketing`, `marketing_lite`, `utility`, `service`, `referral_conversion`,
`group_*`), `subtype` (`paid_exempt`). A doc diz: a partir de **01/10/2026** `regular` inclui utilidade dentro da janela
e mensagens de serviço após a franquia gratuita do número. Em `failed` o array `contacts` é omitido. `errors[]`: `code`,
`title`, `message` (= title), `error_data.details`, `href`.
Fonte: `WA/webhooks/reference/messages/status.md`

**`sent` com pricing — verbatim:**
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Pablo M."
                },
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918"
              }
            ],
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "status": "sent",
                "timestamp": "1750030073",
                "recipient_id": "16505551234",
                "recipient_user_id": "US.13491208655302741918",
                "conversation": {
                  "id": "72b14d6bd5407799e66f64d1b338e567",
                  "expiration_timestamp": "1750116480",
                  "origin": {
                    "type": "marketing"
                  }
                },
                "pricing": {
                  "billable": true,
                  "pricing_model": "PMP",
                  "type": "regular",
                  "category": "marketing"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**`sent` em v24.0 (sem `conversation` nem `pricing`) — verbatim:**
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "status": "sent",
                "timestamp": "1750030073",
                "recipient_id": "16505551234"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**`delivered` — verbatim** (exemplo da página `messages`, ainda com `pricing_model: "CBP"` antigo):
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918"
              }
            ],
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA",
                "status": "delivered",
                "timestamp": "1750263773",
                "recipient_id": "16505551234",
                "recipient_user_id": "US.13491208655302741918",
                "conversation": {
                  "id": "6ceb9d929c9bdc4f90e967a32f8639b4",
                  "origin": {
                    "type": "service"
                  }
                },
                "pricing": {
                  "billable": true,
                  "pricing_model": "CBP",
                  "category": "service"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**`read`** — ⚠️ não há exemplo verbatim na doc; a sintaxe é a mesma de `delivered` com `"status": "read"`
(`contacts.profile.username` só aparece em `delivered`/`read`).

**`failed` com `errors` — verbatim:**
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "statuses": [
              {
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA",
                "status": "failed",
                "timestamp": "1751142888",
                "recipient_id": "16505551234",
                "errors": [
                  {
                    "code": 131049,
                    "title": "This message was not delivered to maintain healthy ecosystem engagement.",
                    "message": "This message was not delivered to maintain healthy ecosystem engagement.",
                    "error_data": {
                      "details": "In order to maintain a healthy ecosystem engagement, the message failed to be delivered."
                    },
                    "href": "/documentation/business-messaging/whatsapp/support/error-codes"
                  }
                ]
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**Erro em nível de sistema/app/conta (`value.errors`) — verbatim** (`WA/webhooks/reference/messages/errors.md`):
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "errors": [
              {
                "code": 130429,
                "title": "Rate limit hit",
                "message": "Rate limit hit",
                "error_data": {
                  "details": "Message failed to send because there were too many messages sent from this phone number in a short period of time"
                },
                "href": "/documentation/business-messaging/whatsapp/support/error-codes"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### 3.2 `messages` — mensagem recebida
**Texto — verbatim** (`WA/webhooks/reference/messages.md`):
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918"
              }
            ],
            "messages": [
              {
                "from": "16505551234",
                "from_user_id": "US.13491208655302741918",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                "timestamp": "1749416383",
                "type": "text",
                "text": {
                  "body": "Does it come in another color?"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**Botão de resposta rápida de template (`type: button`) — verbatim** (`WA/webhooks/reference/messages/button.md`;
gatilho: "A WhatsApp user taps a quick-reply button in a template message"). Botões de mensagens interativas chegam como
`type: interactive` / `interactive.type: button_reply` (`WA/webhooks/reference/messages/interactive.md`).
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Sheena Nelson"
                },
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918"
              }
            ],
            "messages": [
              {
                "context": {
                  "from": "15550783881",
                  "id": "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA="
                },
                "from": "16505551234",
                "from_user_id": "US.13491208655302741918",
                "id": "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                "timestamp": "1750091045",
                "type": "button",
                "button": {
                  "payload": "Unsubscribe",
                  "text": "Unsubscribe"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### 3.3 `user_preferences` — verbatim
`category: marketing_messages`. Não dispara para feedback "Interested/Not interested".
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15550783881",
              "phone_number_id": "106540352242922"
            },
            "contacts": [
              {
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918",
                "parent_user_id": "US.ENT.506847293015824"
              }
            ],
            "user_preferences": [
              {
                "wa_id": "16505551234",
                "user_id": "US.13491208655302741918",
                "parent_user_id": "US.ENT.506847293015824",
                "detail": "User requested to resume marketing messages",
                "category": "marketing_messages",
                "value": "resume",
                "timestamp": 1731705721
              }
            ]
          },
          "field": "user_preferences"
        }
      ]
    }
  ]
}
```
Valores de `value`: `stop` | `resume`; `detail`: `User requested to stop marketing messages` |
`User requested to resume marketing messages`.

### 3.4 `phone_number_quality_update` — verbatim
`value`: `display_phone_number`, `event` (`ONBOARDING` | `THROUGHPUT_UPGRADE`), `max_daily_conversations_per_business`
(`TIER_50`, `TIER_250`, `TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_NOT_SET`, `TIER_UNLIMITED`), legado `current_limit`/`old_limit`
("removidos em fev/2026" — mas o exemplo oficial ainda usa `current_limit`).
```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1748454394,
      "changes": [
        {
          "value": {
            "display_phone_number": "15550783881",
            "event": "THROUGHPUT_UPGRADE",
            "current_limit": "TIER_UNLIMITED"
          },
          "field": "phone_number_quality_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

### 3.5 `business_capability_update` (limite de mensagens) — verbatim
`value`: `max_daily_conversations_per_business` (doc lista `TIER_250`/`TIER_2K`/`TIER_10K`/`TIER_100K`/`TIER_UNLIMITED`,
tipo "Integer", **mas o exemplo traz `2000`** — tratar os dois formatos), legado `max_daily_conversation_per_phone`
(`250`, `2000`, `10000`, `100000`, `-1` = ilimitado), `max_phone_numbers_per_business` (só quando limite = 250),
`max_phone_numbers_per_waba`. Também dispara na criação da Messaging account.
```json
{
  "entry": [
    {
      "id": "524126980791429",
      "time": 1739321024,
      "changes": [
        {
          "value": {
            "max_daily_conversations_per_business": 2000,
            "max_phone_numbers_per_waba": 25
          },
          "field": "business_capability_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

### 3.6 `account_alerts` — verbatim
`alert_type`: `INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED` | `..._FAILED` | `..._NEED_MORE_INFO` | `OBA_APPROVED` |
`OBA_REJECTED` | `PROFILE_PICTURE_LOST`; `alert_severity`: `CRITICAL` | `WARNING` | `INFORMATIONAL`;
`entity_type`: `BUSINESS` | `PHONE_NUMBER` | `CURRENT_STATUS_ID`.
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "time": 1745612159,
      "changes": [
        {
          "field": "account_alerts",
          "value": {
            "entity_type": "BUSINESS",
            "entity_id": "506914307656634",
            "alert_info": {
              "alert_severity": "WARNING",
              "alert_status": "ACTIVE",
              "alert_type": "INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED",
              "alert_description": "Limits cannot be increased for your business <BUSINESS_PORTFOLIO_NAME>. Use WhatsApp Business platform actively for several days and follow our messaging policies."
            }
          }
        }
      ]
    }
  ]
}
```

### 3.7 `account_update` — verbatim
`event` (principais): `ACCOUNT_RESTRICTION` (+ `restriction_info[]`: `restriction_type`, `expiration`, `remediation`),
`ACCOUNT_VIOLATION` (+ `violation_info.violation_type`), `DISABLED_UPDATE` (+ `ban_info.waba_ban_state`:
`DISABLE` | `REINSTATE` | `SCHEDULE_FOR_DISABLE`), `ACCOUNT_DELETED`, `PARTNER_ADDED`/`PARTNER_REMOVED`,
`PARTNER_APP_INSTALLED`/`PARTNER_APP_UNINSTALLED`, `ACCOUNT_OFFBOARDED`/`ACCOUNT_RECONNECTED`,
`VOLUME_BASED_PRICING_TIER_UPDATE`, `BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE`, `AUTH_INTL_PRICE_ELIGIBILITY_UPDATE`,
`AD_ACCOUNT_LINKED`, `MM_LITE_TERMS_SIGNED`, `PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE`, `CALLING_TIER_UPDATE`.
`restriction_type` inclui `RESTRICTED_BIZ_INITIATED_MESSAGING`, `RESTRICTED_CUSTOMER_INITIATED_MESSAGING`,
`RESTRICTED_ADD_PHONE_NUMBER_ACTION`, `RESTRICTED_UTILITY_TEMPLATES`, entre outros.
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "time": 1641330498,
      "changes": [
        {
          "value": {
            "event": "ACCOUNT_RESTRICTION",
            "restriction_info": [
              {
                "restriction_type": "RESTRICTED_BIZ_INITIATED_MESSAGING",
                "expiration": 1641330498
              },
              {
                "restriction_type": "RESTRICTED_ADD_PHONE_NUMBER_ACTION",
                "expiration": 1641330498
              }
            ]
          },
          "field": "account_update"
        }
      ]
    }
  ]
}
```
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "102290129340398",
      "time": 1743451903,
      "changes": [
        {
          "value": {
            "event": "DISABLED_UPDATE",
            "ban_info": {
              "waba_ban_state": "REINSTATE",
              "waba_ban_date": "April 17, 2025"
            }
          },
          "field": "account_update"
        }
      ]
    }
  ]
}
```

### 3.8 `account_review_update` — verbatim
`decision`: `APPROVED` | `REJECTED` | `PENDING` | `DEFERRED`.
```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1739321024,
      "changes": [
        {
          "value": {
            "decision": "APPROVED"
          },
          "field": "account_review_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

### 3.9 `message_template_status_update` — verbatim
`event`: `APPROVED`, `REJECTED`, `PENDING`, `PAUSED`, `DISABLED`, `FLAGGED`, `REINSTATED`, `ARCHIVED`, `UNARCHIVED`,
`DELETED`, `PENDING_DELETION`, `IN_APPEAL`, `LIMIT_EXCEEDED`, `LOCKED`. `reason`: `ABUSIVE_CONTENT`, `INCORRECT_CATEGORY`,
`INVALID_FORMAT`, `NONE`, `PROMOTIONAL`, `SCAM`, `TAG_CONTENT_MISMATCH`, `CATEGORY_NOT_AVAILABLE` (depreciado) ou `null`.
Opcionais: `disable_info.disable_date`, `other_info.title` (`FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`,
`UNPAUSE`, `DISABLED`), `rejection_info`.
```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1751247548,
      "changes": [
        {
          "value": {
            "event": "APPROVED",
            "message_template_id": 1689556908129832,
            "message_template_name": "order_confirmation",
            "message_template_language": "en-US",
            "reason": "NONE",
            "message_template_category": "UTILITY"
          },
          "field": "message_template_status_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

### 3.10 `message_template_quality_update` — verbatim
Scores: `GREEN` | `YELLOW` | `RED` | `UNKNOWN`.
```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1674864290,
      "changes": [
        {
          "value": {
            "previous_quality_score": "GREEN",
            "new_quality_score": "YELLOW",
            "message_template_id": 806312974732579,
            "message_template_name": "welcome_template",
            "message_template_language": "en-US"
          },
          "field": "message_template_quality_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

### 3.11 `template_category_update` — verbatim
Dois formatos: aviso prévio (24 h antes; `new_category` = categoria **atual**, `correct_category`, `category_update_timestamp`)
e efetivação (`previous_category`, `new_category`).
```json
{
 "entry": [
   {
     "id": "102290129340398",
     "time": 1746169200,
     "changes": [
       {
         "field": "template_category_update",
         "value": {
           "message_template_id": 278077987957091,
           "message_template_name": "welcome_template",
           "message_template_language": "en-US",
           "previous_category": "UTILITY",
           "new_category": "MARKETING"
         }
       }
     ]
   }
 ],
 "object": "whatsapp_business_account"
}
```

### 3.12 `phone_number_name_update` — verbatim
`decision`: `APPROVED` | `DEFERRED` | `PENDING` | `REJECTED`; `rejection_reason`: `NAME_EMPLOYEE_ISSUE`,
`NAME_ENDCLIENT_NOTRELATED`, `NAME_FORMAT_UNACCEPTABLE`, `NAME_INDIVIDUAL_ISSUE`, `NAME_NOT_CONSISTENT`, `UNKNOWN`, `null`.
```json
{
  "entry": [
    {
      "id": "102290129340398",
      "time": 1739321024,
      "changes": [
        {
          "value": {
            "display_phone_number": "15550783881",
            "decision": "APPROVED",
            "requested_verified_name": "Lucky Shrub",
            "rejection_reason": null
          },
          "field": "phone_number_name_update"
        }
      ]
    }
  ],
  "object": "whatsapp_business_account"
}
```

## 4. Endpoints de ativos

### 4.1 `GET /{waba-id}` (Messaging account)
Fonte: `WA/reference/whatsapp-business-account/whatsapp-business-account-api.md`, `WA/whatsapp-business-accounts.md`
- Campos (referência): `id`, `name` (padrão), `timezone_id`, `message_template_namespace`, `account_review_status`
  (`APPROVED` | `DEFERRED` | `PENDING` | `REJECTED`), `business_verification_status` (`EXPIRED`, `FAILED`, `INELIGIBLE`,
  `NOT_VERIFIED`, `PENDING`, `PENDING_NEED_MORE_INFO`, `PENDING_SUBMISSION`, `REJECTED`, `REVOKED`, `VERIFIED`), `country`,
  `ownership_type` (`CLIENT_OWNED` | `ON_BEHALF_OF` | `SELF`), `primary_business_location`.
- O guia também usa `status` e `currency` (não constam na lista da referência). Exemplo **verbatim**:
```json
{
  "name": "Lucky Shrub",
  "status": "ACTIVE",
  "currency": "USD",
  "country": "US",
  "business_verification_status": "verified",
  "id": "102290129340398"
}
```
(Note o valor minúsculo `verified` no exemplo vs. enum maiúsculo na referência — normalizar.)

### 4.2 `GET /{waba-id}/phone_numbers`
Fonte: `WA/reference/whatsapp-business-account/phone-number-management-api.md`, `WA/business-phone-numbers/phone-numbers.md`
- Campos: `id`, `display_phone_number`, `verified_name`, `status` (`BANNED`, `CONNECTED`, `DELETED`, `DISCONNECTED`,
  `FLAGGED`, `MIGRATED`, `PENDING`, `RATE_LIMITED`, `RESTRICTED`), `quality_rating` (`GREEN`, `YELLOW`, `RED`, `UNKNOWN`/`NA`),
  `country_code`, `country_dial_code`, `code_verification_status` (`EXPIRED`, `NOT_VERIFIED`, `VERIFIED`), `unified_cert_status`,
  `account_mode` (`LIVE` | `SANDBOX`), `host_platform` (`CLOUD_API`, `ON_PREMISE`, `NOT_APPLICABLE`),
  `messaging_limit_tier` (**depreciado**, ver §4.6), `is_official_business_account`. Paginação por cursor (`paging.cursors`).
  Parâmetros `filtering` (beta) e `sort` (`creation_time.*`, `last_onboarded_time.*`).
- Exemplo **verbatim**:
```json
{
  "data": [
    {
      "verified_name": "Jasper's Market",
      "display_phone_number": "+1 631-555-5555",
      "id": "1906385232743451",
      "quality_rating": "GREEN"

    },
    {
      "verified_name": "Jasper's Ice Cream",
      "display_phone_number": "+1 631-555-5556",
      "id": "1913623884432103",
      "quality_rating": "NA"
    }
  ]
}
```
- Rate limit dos endpoints de gestão da WABA (`GET /{waba}`, `/phone_numbers`, `/message_templates`, `/subscribed_apps`):
  **200 req/h por app por WABA**; **5000 req/h** se a WABA estiver ativa com ≥ 1 número registrado (`WA/about-the-platform.md`).

### 4.3 `GET /{phone-number-id}`
Fonte: `WA/reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api.md` + guias.
- Padrão: `id`, `display_phone_number`, `verified_name`, `quality_rating` (`GREEN` | `YELLOW` | `RED` | `NA`).
- Sob demanda: `name_status` (`APPROVED`, `AVAILABLE_WITHOUT_REVIEW`, `DECLINED`, `EXPIRED`, `PENDING_REVIEW`, `NONE`),
  `code_verification_status` (`VERIFIED` | `UNVERIFIED` nesta página; a de listagem usa `EXPIRED`/`NOT_VERIFIED`/`VERIFIED`),
  `status` (ex.: `{"status": "CONNECTED", "id": "106540352242922"}` — número precisa estar `CONNECTED` para enviar),
  `throughput` (guia Throughput: `GET /<PHONE_NUMBER_ID>?fields=throughput`), `whatsapp_business_manager_messaging_limit`.
- ⚠️ **Formato da resposta de `throughput` não documentado** (nenhum exemplo; campo ausente da referência).
- Exemplo **verbatim**:
```json
{
  "code_verification_status" : "VERIFIED",
  "display_phone_number" : "15555555555",
  "id" : "105954558954427",
  "quality_rating" : "GREEN",
  "verified_name" : "Support Number"
}
```

### 4.4 `GET /{business-id}` (portfolio)
Fonte: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/business.md e
`WA/reference/business/business-account-api.md`
- Campos úteis: `id`, `name` (padrão), `created_time`, `link`, `primary_page`, `timezone_id`, `two_factor_type`,
  `verification_status` (`expired`, `failed`, `ineligible`, `not_verified`, `pending`, `pending_need_more_info`,
  `pending_submission`, `rejected`, `revoked`, `verified`), `vertical`,
  **`whatsapp_business_manager_messaging_limit`** (`TIER_250`, `TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`, `UNTIERED`).
- ⚠️ Sem exemplo de resposta verbatim na doc.

### 4.5 `POST/GET/DELETE /{waba-id}/subscribed_apps`
Fonte: `WA/reference/whatsapp-business-account/subscribed-apps-api.md`, `WA/embedded-signup/onboarding-customers-as-a-tech-provider.md`
- `POST` (corpo opcional: `override_callback_uri`, `verify_token`). Resposta **verbatim** do guia:
```json
{
  "success": true
}
```
- `GET` → `{ "data": [ { "whatsapp_business_api_data": { "id", "name", "link" }, "override_callback_uri"? } ] }`
  (schema da referência; ⚠️ sem exemplo verbatim).
- Assinatura continua no tópico `whatsapp_business_account` com o WABA/Messaging account ID.

### 4.6 Limite de mensagens: qual campo (V-04)
- **`whatsapp_business_manager_messaging_limit`** é o campo atual. A página Messaging Limits manda pedi-lo na
  **Phone Number API** (`GET /{phone-number-id}?fields=whatsapp_business_manager_messaging_limit`) e ele também é campo do nó
  **Business** (portfolio). Como o limite é do **portfolio**, o valor é o mesmo para todos os números do portfolio.
  Exemplo **verbatim** (`WA/messaging-limits.md`):
```json
{
  "whatsapp_business_manager_messaging_limit": "TIER_250",
  "id": "106540352242922"
}
```
- Valores: `TIER_250`, `TIER_2K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED` (+ `UNTIERED` no nó Business).
- **`messaging_limit_tier` está depreciado** (aviso no topo de Messaging Limits), embora ainda apareça na referência de
  `/phone_numbers` com enum `TIER_50`, `TIER_250`, `TIER_1K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`. Não usar.
- ⚠️ `GET /{waba-id}?fields=whatsapp_business_manager_messaging_limit` **não** é documentado (o `04-endpoints.md` supunha
  os três nós).

### 4.7 `GET /debug_token`
Fonte: https://developers.facebook.com/docs/graph-api/reference/debug_token
- `GET /v27.0/debug_token?input_token={input-token}` com **token de app** ou token de usuário desenvolvedor do app.
- Campos em `data`: `app_id`, `application`, `error {code, message, subcode}`, `expires_at`, `data_access_expires_at`,
  `is_valid`, `issued_at`, `metadata`, `profile_id`, `scopes`, `granular_scopes` (`[{scope, target_ids}]` — permite ver
  quais WABAs o token alcança), `user_id`.
- ⚠️ Sem exemplo de resposta verbatim na página.

## 5. Limites de mensagens e throughput (V-01, V-02, V-03, V-05)

Fontes: `WA/messaging-limits.md`, `WA/throughput.md`, `WA/about-the-platform.md`, `WA/business-phone-numbers/phone-numbers.md`

- **Definição:** nº máximo de **usuários únicos** para os quais o negócio pode **entregar** mensagens **fora da janela de
  atendimento**, em **24 h móveis**. Calculado e aplicado **no nível do portfolio**, compartilhado por todos os números.
  ⚠️ A data "07/10/2025" de início não aparece na doc atual.
- **Tiers:** 250 (portfolio novo) → **2.000** (por *scaling path*) → **10.000** → **100.000** → **ilimitado** (por
  *automatic scaling*). O tier 10K existe.
- **Sair de 250 → 2.000 (scaling paths, qualquer um):** verificar a empresa; verificação pelo parceiro; **ou** entregar
  2.000 mensagens fora da janela a usuários únicos em 30 dias móveis com templates de qualidade alta. Depois a Meta
  analisa a qualidade e aprova (webhook `business_capability_update`) ou nega (`account_alerts`).
- **Automatic scaling (a partir de 2.000):** mensagens de alta qualidade em todos os números/templates **e** uso de
  **≥ metade do limite atual nos últimos 7 dias** → sobe **um nível em até 6 h**.
  (A doc não fala em "qualidade Média/Alta"; fala em "high-quality messages".)
- **Throughput:** **80 msg/s por número** por padrão; **até 1.000 msg/s** por upgrade automático e gratuito. Inclui entrada e
  saída. Elegibilidade: portfolio com limite ilimitado + número usado para ≥ 100 mil usuários únicos fora da janela em 24 h +
  qualidade ≥ `YELLOW`. Durante o upgrade (até 1 min) o número retorna `131057`. Upgrade gera `phone_number_quality_update`
  com `THROUGHPUT_UPGRADE`. Números em **coexistência** (app Business + Cloud API): **fixo em 20 msg/s**. Excesso → `130429`.
- **Pair rate limit:** 1 mensagem a cada 6 s para o mesmo usuário (~10/min, 600/h); rajada de até 45 em 6 s "empresta" da
  cota. Excesso → `131056`. A doc recomenda retry após **4^X s** (X = 0, 1, 2…).
- **Limite de números:** portfolio novo = **2 números registrados**; sobe para **20** ao verificar a empresa ou chegar a
  2.000 (`max_phone_numbers_per_business` no webhook). Até 20 hierarquias de WhatsApp account por portfolio.

## 6. Catálogo de erros (V-12)

Fonte: `WA/support/error-codes.md`; complementos: https://developers.facebook.com/docs/graph-api/guides/error-handling,
referências da Phone Number API (exemplos HTTP).

### 6.1 Objeto de erro (síncrono)
```json
{
  "error": {
    "message": "(#130429) Rate limit hit",
    "type": "OAuthException",
    "code": 130429,
    "error_data": {
        "messaging_product": "whatsapp",
        "details": "Cloud API message throughput has been reached."
    },
    "error_subcode": 2494055,
    "fbtrace_id": "Az8or2yhqkZfEZ-_4Qn_Bam"
  }
}
```
- `message` = "(#código) título"; `type` (ex.: `OAuthException`, `GraphMethodException`); `code` — **basear a lógica em
  `code` + `error_data.details`**, não em títulos (serão depreciados) nem em HTTP status; `error_subcode` — **"Deprecated.
  Will not be returned in v16.0+"** (mas os exemplos ainda o mostram); `fbtrace_id` para suporte.
- Os schemas das referências incluem também `is_transient` (boolean: "should be retried"), `error_user_title`,
  `error_user_msg`. Exemplos: código `4` → HTTP **429** com `is_transient: true`; código `2` → HTTP **500** com
  `is_transient: true`; `190` → 401; `200` → 403; `100` → 400/422.
- Erros podem vir **síncronos**, **assíncronos via webhook** (`value.errors`, `messages[].errors`, `statuses[].errors`) ou ambos.

### 6.2 Tabela
Legenda "Retry": **T** = a doc indica temporário/tentar de novo; **N** = não reenviar/corrigir causa; **—** = não indicado.
HTTP status por código não é informado na tabela principal (só na tabela da Marketing Messages API).

| Código | Descrição (doc) | Retry |
|---|---|---|
| 0 | Não foi possível autenticar o usuário do app (token expirado/invalidado) | N (novo token) |
| 1 | Requisição inválida ou possível erro de servidor (Graph: "possivelmente temporário") | T? |
| 2 | Temporário por indisponibilidade ou sobrecarga | T |
| 3 | Problema de capability/permissão | N |
| 4 | App atingiu o rate limit de chamadas (HTTP 429, `is_transient`) | T |
| 10 | Permissão não concedida ou removida | N |
| 33 | Número comercial foi excluído | N |
| 100 | Parâmetro não suportado/grafado errado (também "Invalid parameter") | N |
| 190 | Token de acesso expirado | N (novo token) |
| 200 | Nenhum token informado ("Provide valid app ID"); sem acesso avançado em ativo compartilhado → 200 | N |
| 200–299 | Permissão não concedida ou removida | N |
| 368 | WABA restrita/desativada por violar política (Graph genérico: "bloqueado temporariamente") | N |
| 80007 | WABA atingiu seu rate limit | T (mais tarde) |
| 130403 | Negócio bloqueou o usuário | N |
| 130429 | Throughput da Cloud API atingido | T |
| 130472 | Não enviada por fazer parte de um experimento (marketing) | N |
| 130497 | WABA restrita para enviar a usuários de certos países | N |
| 131000 | Erro desconhecido | T ("Try again") |
| 131005 | Permissão não concedida ou removida | N |
| 131008 | Parâmetro obrigatório ausente | N |
| 131009 | Valor de parâmetro inválido | N |
| 131016 | Serviço temporariamente indisponível | T |
| 131021 | Remetente e destinatário iguais | N |
| 131026 | Mensagem não entregável (não é WhatsApp, não aceitou termos, versão antiga) | N |
| 131031 | Conta restrita/desativada por política, ou dado não confere (ex.: PIN 2 etapas errado) | N |
| 131037 | Número 555 sem nome exibido aprovado | N |
| 131042 | Erro relacionado ao método de pagamento | N |
| 131045 | Erro de registro do número | N |
| 131047 | Passaram > 24 h desde a última resposta (use template) | N |
| 131048 | Restrição de quantas mensagens o número pode enviar (bloqueios/spam) | N |
| 131049 | Não entregue "para manter engajamento saudável" (limite por usuário de marketing) | N (esperar ≥ 24 h) |
| 131050 | Usuário optou por não receber marketing do negócio | **N — nunca reenviar** |
| 131051 | Tipo de mensagem não suportado | N |
| 131052 | Não foi possível baixar a mídia enviada pelo usuário | N |
| 131053 | Não foi possível subir a mídia usada na mensagem | N |
| 131056 | Muitas mensagens ao mesmo destinatário em pouco tempo (par) | T (esperar; 4^X s) |
| 131057 | Conta em modo de manutenção (ex.: upgrade de throughput) | T |
| 131062 | Destinatário BSUID não suportado para esta mensagem | N |
| 131063 | Template de marketing desativado na Cloud API (`disable_marketing_messages_on_cloud_api`) | N |
| 131064 | Limite atingido por violações de classificação de template | N (até fim da punição) |
| 132000 | Nº de parâmetros não confere com o template | N |
| 132001 | Template não existe no idioma ou não aprovado | N |
| 132005 | Texto traduzido longo demais | N |
| 132007 | Conteúdo do template viola política | N |
| 132012 | Parâmetros com formato incorreto | N |
| 132015 | Template pausado por baixa qualidade | N |
| 132016 | Template desativado permanentemente | N |
| 132068 / 132069 | Flow bloqueado / Flow em throttling | N |
| 133000 | Tentativa anterior de desregistro falhou | N (desregistrar de novo) |
| 133001–133003 | ⚠️ não constam na doc atual | — |
| 133004 | Servidor temporariamente indisponível | T |
| 133005 | PIN de 2 etapas incorreto | N |
| 133006 | Número precisa ser verificado antes de registrar | N |
| 133007 | ⚠️ não consta na doc atual | — |
| 133008 | Muitas tentativas de PIN | T (após tempo em `details`) |
| 133009 | PIN digitado rápido demais | T (ver `details`) |
| 133010 | Número não registrado na plataforma | N |
| 133015 | Número excluído recentemente, exclusão em andamento | T (esperar 5 min) |
| 133016 | Muitas tentativas de registro/desregistro | T (após desbloqueio) |
| 134011 | Termos do WhatsApp Payments pendentes | N |
| 135000 | Erro desconhecido nos parâmetros (também usado para mensagens descartadas por *portfolio pacing*) | N |
| 2494100 | Conta em modo de manutenção | T |

Divergências vs. `02-arquitetura.md §6.3`: todos os códigos supostos existem com o significado suposto. Acrescentar:
**131050** (opt-out de marketing → supressão), **131064** e **130497** (pausar), **135000**/**132015** vindos de pacing,
**131057** (transitório), **80007**/**4** (rate limit de API, transitório), **131062** (BSUID). `368` na doc do WhatsApp é
restrição de conta, não bloqueio temporário.

## 7. `appsecret_proof`
Fonte: https://developers.facebook.com/docs/graph-api/guides/secure-requests
- "sha256 hash of your access token, using your app secret as the key" — PHP da doc:
  `hash_hmac('sha256', $access_token, $app_secret)` → **HMAC-SHA256, chave = app secret, mensagem = access token,
  saída hex minúscula** (padrão do `hash_hmac`).
- Enviar como parâmetro **`appsecret_proof`** em cada chamada (exemplo da doc usa form field junto de `access_token`; em
  GET vai na query string). Com **"Require App Secret"** (App Settings > Advanced) ligado, chamadas sem a prova falham.
- ⚠️ A doc não diz explicitamente se o proof funciona com token no header `Authorization: Bearer` (exemplos usam
  `access_token` como parâmetro); usar o mesmo token em ambos.

## 8. Resposta de envio (`POST /{phone-number-id}/messages`) e `wamid`
Fontes: `WA/messages/send-messages.md`, `WA/business-scoped-user-ids.md#send-message-response`
- Sucesso = **requisição aceita**, não entrega (entrega vem por webhook). Exemplo **verbatim**:
```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "input": "+16505551234",
      "wa_id": "16505551234"
    }
  ],
  "messages": [
    {
      "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA"
    }
  ]
}
```
- `messages[].message_status`: `accepted` | `held_for_quality_assessment` (pacing). Divergência na doc: template-pacing
  diz "always included"; send-messages diz "only included if sending a template" (que está sob pacing). Tratar como opcional.
- `contacts[].input` = o que foi enviado (telefone, BSUID ou group ID); `wa_id` pode ser omitido (envio por BSUID);
  `user_id`/`parent_user_id` aparecem em envio por BSUID.
- Novo parâmetro de envio `messaging_account_id` quando o token tiver acesso a mais de uma Messaging account no número.
- **`wamid`**: string opaca com prefixo `wamid.` (base64); é o `statuses[].id` dos webhooks. ⚠️ Não há especificação formal
  de formato/tamanho — armazenar como `text` e não parsear.
- Erro de envio: mesmo objeto do §6.1.

## 9. Resumo das divergências com o que estava suposto

| Supunha (docs 02/04/09) | Doc oficial |
|---|---|
| Limite via `whatsapp_business_manager_messaging_limit` em portfolio, WABA ou número | Documentado no **número** (Phone Number API) e no **Business**; WABA não documentado |
| Upgrade: ≥ 50% em 7 dias + qualidade Média/Alta, a cada ~6 h | Correto a partir de 2.000 ("high-quality"; sobe 1 nível em até 6 h); de 250→2.000 é por *scaling path* |
| Verificação da empresa necessária para sair de 250 (V-06) | **Não obrigatória**: é um de três caminhos (verificação, verificação pelo parceiro, 2.000 entregas em 30 dias) |
| Throughput 80 / 1.000 / 20 (coexistência) | Confirmado; formato da resposta do campo `throughput` não documentado |
| Webhook: responder 200 em < 500 ms | Meta pede mediana ≤ 250 ms e < 1% > 1 s; retries por **7 dias** |
| `phone_number_quality_update` = qualidade/limite | Hoje = **throughput**; limite vem de `business_capability_update` |
| Contato identificado por telefone | Telefone pode faltar; usar **BSUID (`user_id`)** |
| WABA = conta única | WABA ID = **Messaging account**; números migram para WAAC; Fase 3 (H1 2028) troca phone-number-ID por WAAC ID |
| `error_subcode` útil | Depreciado desde v16.0; usar `code` + `error_data.details` (+ `is_transient`) |
