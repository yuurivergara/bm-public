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

echo
echo "STAGING OK — $BASE"
