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

HOST="${VPS_HOST:-bms-vps}"
DIR=/opt/bm-platform
API_HOST="${API_HOST:-bm.179-197-76-7.sslip.io}"
BASE="https://$API_HOST"
EMAIL=owner@staging.local
IDS_BIZ=506914307656634
IDS_WABA=102290129340398
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

ok() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
env_get() { ssh "$HOST" "grep -m1 '^$1=' $DIR/.env | cut -d= -f2-"; }
totp() {
  python3 - "$1" <<'PY'
import base64, hashlib, hmac, struct, sys, time
s = sys.argv[1].strip().upper(); s += '=' * (-len(s) % 8)
c = struct.pack('>Q', int(time.time()) // 30)
h = hmac.new(base64.b32decode(s), c, hashlib.sha1).digest()
o = h[-1] & 15
print('%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 1000000))
PY
}
api() { curl -fsS -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

echo "== 1. conta operacional"
if ! ssh "$HOST" "test -f $DIR/.owner"; then
  ssh "$HOST" "DIR=$DIR EMAIL=$EMAIL bash -s" <<'REMOTE'
set -euo pipefail
umask 077
PW="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
docker exec -e OWNER_EMAIL="$EMAIL" -e OWNER_NAME="Operador Staging" -e OWNER_PASSWORD="$PW" \
  bm-platform-api-1 node dist/scripts/create-owner.js >/dev/null
printf 'OWNER_PASSWORD=%s\n' "$PW" > "$DIR/.owner"
REMOTE
  ok "owner criado ($EMAIL); credenciais em $DIR/.owner"
else
  ok "owner já existe"
fi
PASSWORD="$(ssh "$HOST" "grep -m1 '^OWNER_PASSWORD=' $DIR/.owner | cut -d= -f2-")"
SECRET="$(ssh "$HOST" "grep -m1 '^TOTP_SECRET=' $DIR/.owner | cut -d= -f2- || true")"

echo "== 2. login (senha + TOTP)"
LOGIN="$(api -X POST "$BASE/api/v1/auth/login" -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')")"
CHALLENGE="$(jq -r .challengeToken <<<"$LOGIN")"
if [[ "$(jq -r .totpEnrolled <<<"$LOGIN")" == "false" ]]; then
  SECRET="$(jq -r .otpauthUri <<<"$LOGIN" | sed -E 's/.*[?&]secret=([A-Z2-7]+).*/\1/')"
  ssh "$HOST" "umask 077; sed -i '/^TOTP_SECRET=/d' $DIR/.owner; echo TOTP_SECRET=$SECRET >> $DIR/.owner"
  ok "TOTP cadastrado (segredo guardado na VPS)"
fi
[[ -n "$SECRET" ]] || fail "segredo TOTP ausente em $DIR/.owner"
api -X POST "$BASE/api/v1/auth/totp" -d "$(jq -nc --arg t "$CHALLENGE" --arg c "$(totp "$SECRET")" '{challengeToken:$t,code:$c}')" >/dev/null \
  || fail "TOTP recusado (código já usado neste intervalo? aguarde 30 s)"
ok "sessão aberta"

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
