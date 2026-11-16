# Funções comuns dos scripts de staging (login de operador com TOTP). Uso: source deploy/staging-lib.sh
# shellcheck shell=bash
HOST="${VPS_HOST:-bms-vps}"
DIR=/opt/bm-platform
API_HOST="${API_HOST:-bm.179-197-76-7.sslip.io}"
BASE="https://$API_HOST"
EMAIL=owner@staging.local
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


staging_login() {
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
}
