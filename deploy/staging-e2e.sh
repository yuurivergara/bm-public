#!/usr/bin/env bash
# Teste ponta a ponta no STAGING (critério da S2): login com TOTP → verificação do webhook →
# cadastro de ativos (meta-sim) → webhook assinado emitido pelo meta-sim pela URL pública
# (Traefik + TLS) → processamento → efeito visível na API.
#
#   deploy/staging-e2e.sh
#
# Usa uma conta owner operacional do staging (owner@staging.local). Senha e segredo TOTP ficam
# só na VPS, em /opt/bm-platform/.owner (600), e nunca são exibidos.
set -euo pipefail

# shellcheck source=deploy/staging-lib.sh
source "$(dirname "$0")/staging-lib.sh"

if ssh "$HOST" "grep -q '^USE_META_SIM=false' $DIR/.env"; then
  echo "O staging está ligado ao app real da Meta (USE_META_SIM=false): este teste usa o meta-sim." >&2
  echo "Volte ao simulador com deploy/set-meta-app.sh --sim para rodá-lo." >&2
  exit 2
fi

IDS_BIZ=506914307656634
IDS_WABA=102290129340398
staging_login

echo "== 3. verificação do webhook (GET hub.challenge)"
VERIFY="$(env_get META_WEBHOOK_VERIFY_TOKEN)"
CH="e2e$RANDOM"
[[ "$(curl -fsS "$BASE/webhooks/meta?hub.mode=subscribe&hub.verify_token=$VERIFY&hub.challenge=$CH")" == "$CH" ]] \
  || fail "desafio não ecoado"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1")" == 403 ]] \
  || fail "verify token errado deveria dar 403"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"object":"x","entry":[]}' "$BASE/webhooks/meta")" == 401 ]] \
  || fail "POST sem assinatura deveria dar 401"
ok "desafio ok; token errado → 403; POST sem assinatura → 401"

echo "== 4. cliente e ativos (meta-sim)"
TENANT="$(api "$BASE/api/v1/tenants?q=Staging%20E2E" | jq -r '.data[0].id // empty')"
if [[ -z "$TENANT" ]]; then
  TENANT="$(api -X POST "$BASE/api/v1/tenants" -d '{"name":"Staging E2E (meta-sim)"}' | jq -r .id)"
fi
TOKEN="$(env_get SIM_DEMO_TOKEN)"
ASSETS="$(api -X POST "$BASE/api/v1/tenants/$TENANT/assets/partner-share" \
  -d "$(jq -nc --arg b "$IDS_BIZ" --arg w "$IDS_WABA" --arg t "$TOKEN" '{businessId:$b,wabaId:$w,accessToken:$t}')")"
grep -qF "$TOKEN" <<<"$ASSETS" && fail "token apareceu na resposta!"
[[ "$(jq -r '.portfolios[0].wabas[0].webhooksSubscribed' <<<"$ASSETS")" == true ]] || fail "webhooks não inscritos"
ok "ativos cadastrados e app inscrito nos webhooks (cliente $TENANT)"

echo "== 5. webhook assinado pela internet → processamento"
NAME="Lucky Shrub $(date +%H%M%S)"
ssh "$HOST" "docker exec bm-platform-meta-sim-1 node -e '
  fetch(\"http://127.0.0.1:4010/_sim/webhooks\", { method: \"POST\", headers: { \"content-type\": \"application/json\" },
    body: JSON.stringify({ entryId: \"$IDS_WABA\", field: \"phone_number_name_update\",
      value: { display_phone_number: \"15550783881\", decision: \"APPROVED\", requested_verified_name: \"$NAME\", rejection_reason: null } }) })
  .then(r => r.json()).then(j => { if (JSON.stringify(j.statuses) !== \"[200]\") { console.error(j); process.exit(1); } })'" \
  || fail "o meta-sim não conseguiu entregar o webhook"
ok "webhook entregue (HTTP 200 pela URL pública)"
for _ in $(seq 1 20); do
  GOT="$(api "$BASE/api/v1/tenants/$TENANT/assets" | jq -r '.portfolios[0].wabas[0].phoneNumbers[0].verifiedName')"
  [[ "$GOT" == "$NAME" ]] && break
  sleep 1
done
[[ "$GOT" == "$NAME" ]] || fail "webhook não processado (verifiedName=$GOT)"
ok "processado: nome exibido atualizado para \"$NAME\""

echo "== 6. sincronização (limites/qualidade)"
SYNC="$(api -X POST "$BASE/api/v1/tenants/$TENANT/assets/sync" -d "{}")"
[[ "$(jq -r '.syncErrors | length' <<<"$SYNC")" == 0 ]] || fail "erros no sync: $(jq -c .syncErrors <<<"$SYNC")"
ok "sync ok (limite do portfolio: $(jq -r '.portfolios[0].messagingLimitTier' <<<"$SYNC"))"

# ---------------------------------------------------------------- S3
sim() { # sim <método> <caminho> [json] — rota de controle do meta-sim (só na rede interna)
  local js
  js="fetch('http://127.0.0.1:4010$2', { method: '$1', headers: { 'content-type': 'application/json' }, body: process.argv[2] || undefined })
    .then(async (r) => { const t = await r.text(); if (!r.ok) { console.error(r.status, t); process.exit(1); } console.log(t); })"
  ssh "$HOST" "echo $(base64 -w0 <<<"$js") | base64 -d > /tmp/bm-sim.js && docker cp /tmp/bm-sim.js bm-platform-meta-sim-1:/tmp/bm-sim.js >/dev/null && docker exec bm-platform-meta-sim-1 node /tmp/bm-sim.js '${3:-}'"
}

echo "== 7. número do estoque: atribuir → código → verificar → registrar"
TENANT2="$(api "$BASE/api/v1/tenants?q=Staging%20S3" | jq -r '.data[0].id // empty')"
if [[ -z "$TENANT2" ]]; then
  TENANT2="$(api -X POST "$BASE/api/v1/tenants" -d '{"name":"Staging S3 (meta-sim)"}' | jq -r .id)"
fi
A2="$(api -X POST "$BASE/api/v1/tenants/$TENANT2/assets/partner-share" \
  -d "$(jq -nc --arg t "$TOKEN" '{businessId:"506914307656699",wabaId:"102290129340499",accessToken:$t}')")"
WABA2="$(jq -r '.portfolios[0].wabas[0].id' <<<"$A2")"
PROVIDER="$(api "$BASE/api/v1/number-providers" | jq -r '.data[] | select(.name=="Staging (manual)") | .id')"
[[ -n "$PROVIDER" ]] || PROVIDER="$(api -X POST "$BASE/api/v1/number-providers" -d '{"name":"Staging (manual)"}' | jq -r .id)"
api "$BASE/api/v1/number-inventory" | jq -e '.data[] | select(.phoneE164=="+5511999990001")' >/dev/null \
  || api -X POST "$BASE/api/v1/number-inventory" \
    -d "$(jq -nc --arg p "$PROVIDER" '{providerId:$p,phone:"+5511999990001",monthlyCostBrl:0}')" >/dev/null
NUM="$(api "$BASE/api/v1/tenants/$TENANT2/number")"
if [[ "$(jq -r '.phoneNumber.registrationStatus // empty' <<<"$NUM")" != registered ]]; then
  NUM="$(api -X POST "$BASE/api/v1/tenants/$TENANT2/number/assign" \
    -d "$(jq -nc --arg w "$WABA2" '{wabaId:$w,verifiedName:"Lucky Shrub 2"}')")"
  PID="$(jq -r .phoneNumber.id <<<"$NUM")"
  MPID="$(jq -r .phoneNumber.metaPhoneNumberId <<<"$NUM")"
  P="$BASE/api/v1/tenants/$TENANT2/phone-numbers/$PID"
  STEP="$(api -X POST "$P/verification/request" -d '{"method":"SMS"}' | jq -r .phoneNumber.registrationStatus)"
  if [[ "$STEP" == code_requested ]]; then
    CODE="$(sim GET "/_sim/verification-codes/$MPID" | jq -r .code)"
    api -X POST "$P/verification/verify" -d "$(jq -nc --arg c "$CODE" '{code:$c}')" >/dev/null
  fi
  NUM="$(api -X POST "$P/register" -d '{}')"
fi
[[ "$(jq -r .phoneNumber.registrationStatus <<<"$NUM")" == registered ]] || fail "número não registrado: $NUM"
# o meta-sim perde o estado a cada deploy: garante que o número registrado existe lá (mesmo ID)
sim POST /_sim/phones "$(jq -nc --arg w "102290129340499" --arg id "$(jq -r .phoneNumber.metaPhoneNumberId <<<"$NUM")" \
  --arg p "$(jq -r .assignment.phoneE164 <<<"$NUM")" '{wabaId:$w,id:$id,phone:$p,verifiedName:"Lucky Shrub 2"}')" >/dev/null
ok "número $(jq -r .assignment.phoneE164 <<<"$NUM") registrado (estoque: $(jq -r .assignment.inventoryStatus <<<"$NUM"))"

echo "== 8. template: criar → revisão (webhook pela URL pública) → APPROVED"
TPL="e2e_$(date +%Y%m%d%H%M%S)"
CREATED="$(api -X POST "$BASE/api/v1/tenants/$TENANT2/templates" -d "$(jq -nc --arg w "$WABA2" --arg n "$TPL" '{
  wabaId:$w, name:$n, category:"UTILITY", parameterFormat:"NAMED",
  components:[{type:"BODY", text:"Olá, {{nome}}! Seu pedido {{pedido}} foi confirmado.",
    example:{body_text_named_params:[{param_name:"nome",example:"Ana"},{param_name:"pedido",example:"123"}]}}]}')")"
TID="$(jq -r .id <<<"$CREATED")"
MTID="$(jq -r .metaTemplateId <<<"$CREATED")"
[[ "$(jq -r .status <<<"$CREATED")" == PENDING ]] || fail "template não ficou PENDING: $CREATED"
sim POST "/_sim/templates/$MTID/review" '{"event":"APPROVED"}' | jq -e '.webhook.statuses == [200]' >/dev/null \
  || fail "o meta-sim não entregou o webhook de aprovação"
for _ in $(seq 1 20); do
  ST="$(api "$BASE/api/v1/tenants/$TENANT2/templates" | jq -r --arg id "$TID" '.data[] | select(.id==$id) | .status')"
  [[ "$ST" == APPROVED ]] && break
  sleep 1
done
[[ "$ST" == APPROVED ]] || fail "template não foi aprovado via webhook (status=$ST)"
ok "template $TPL aprovado via webhook message_template_status_update"

echo "== 9. campanha: lista → criar → iniciar → envio → status por webhook (sim)"
CSV="$(mktemp)"; trap 'rm -f "$JAR" "$CSV"' EXIT
printf 'telefone,nome\n+5511988880001,Ana\n+5511988880002,\n+5511988880999,Bruno\n' >"$CSV"
IMP="$(curl -fsS -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/tenants/$TENANT2/imports" \
  --form-string listName="e2e $TPL" --form-string originDeclaration=customers \
  --form-string legalBasis=legitimo_interesse --form-string declarationAccepted=true \
  --form-string mapping='{"phone":"telefone","name":"nome"}' \
  -F "file=@$CSV;filename=e2e.csv" | jq -r .id)"
imp_wait() { local st; for _ in $(seq 1 30); do
  st="$(api "$BASE/api/v1/tenants/$TENANT2/imports/$IMP" | jq -r .status)"; [[ "$st" == "$1" ]] && return 0
  [[ "$st" == failed ]] && fail "importação falhou"; sleep 1; done; fail "importação parada em $st"; }
imp_wait preview
api -X POST "$BASE/api/v1/tenants/$TENANT2/imports/$IMP/confirm" -d '{}' >/dev/null
imp_wait confirmed
LIST="$(api "$BASE/api/v1/tenants/$TENANT2/imports/$IMP" | jq -r .listId)"
PHONE_ID="$(jq -r .phoneNumber.id <<<"$NUM")"
CAMP="$(api -X POST "$BASE/api/v1/tenants/$TENANT2/campaigns" -d "$(jq -nc --arg l "$LIST" --arg t "$TID" --arg p "$PHONE_ID" --arg n "e2e $TPL" '{
  name:$n, listId:$l, templateId:$t, phoneNumberId:$p,
  variables:{nome:{source:"name",fallback:"cliente"}, pedido:{source:"fixed",value:"123"}}}')" | jq -r .id)"
C="$BASE/api/v1/tenants/$TENANT2/campaigns/$CAMP"
api "$C/preview" | jq -e '.body | test("Olá, Ana! Seu pedido 123")' >/dev/null || fail "prévia errada: $(api "$C/preview")"
api -X POST "$C/start" -d '{}' >/dev/null
for _ in $(seq 1 30); do
  R="$(api "$C")"
  [[ "$(jq -r .status <<<"$R")" == completed && "$(jq -r '.counts.read + .counts.failed' <<<"$R")" == 3 ]] && break
  sleep 1
done
jq -e '.status == "completed" and .counts.read == 2 and .counts.failed == 1' <<<"$R" >/dev/null \
  || fail "campanha não concluiu como esperado: $(jq -c '{status, counts}' <<<"$R")"
ok "campanha enviada: $(jq -c .counts <<<"$R")"
api "$BASE/api/v1/tenants/$TENANT2/capacity" | jq -e '.used24h >= 2' >/dev/null || fail "capacidade não contou os envios"
ok "capacidade de 24 h contabilizada"

api -X DELETE "$BASE/api/v1/tenants/$TENANT2/templates/$TID" -d "{}" >/dev/null
ok "template de teste apagado (Meta + local)"

echo
echo "STAGING OK — $BASE"
