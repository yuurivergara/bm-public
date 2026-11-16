#!/usr/bin/env bash
# Cria um operador no staging pela API (POST /api/v1/users, auditado), autenticando com a conta
# de serviço owner@staging.local. A senha inicial é gerada aqui, enviada só para a API e para
# /opt/bm-platform/.operator-<email> (600) na VPS; nunca é exibida.
#
#   deploy/staging-add-operator.sh <email> <nome> [owner|operator|viewer]
#   ssh bms-vps cat /opt/bm-platform/.operator-<email>     # para ler a senha inicial
set -euo pipefail

NEW_EMAIL="${1:?uso: $0 <email> <nome> [papel]}"
NEW_NAME="${2:?uso: $0 <email> <nome> [papel]}"
ROLE="${3:-owner}"

# shellcheck source=deploy/staging-lib.sh
source "$(dirname "$0")/staging-lib.sh"
staging_login

if api "$BASE/api/v1/users" | jq -e --arg e "${NEW_EMAIL,,}" '.data[] | select(.email == $e)' >/dev/null; then
  ok "$NEW_EMAIL já existe"
  exit 0
fi

PW="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-24)"
api -X POST "$BASE/api/v1/users" \
  -d "$(jq -nc --arg e "$NEW_EMAIL" --arg n "$NEW_NAME" --arg r "$ROLE" --arg p "$PW" \
    '{email:$e,name:$n,role:$r,password:$p}')" >/dev/null
printf 'EMAIL=%s\nSENHA_INICIAL=%s\n' "$NEW_EMAIL" "$PW" \
  | ssh "$HOST" "umask 077; cat > '$DIR/.operator-${NEW_EMAIL,,}'"
unset PW
ok "operador $NEW_EMAIL ($ROLE) criado; senha inicial: ssh $HOST cat $DIR/.operator-${NEW_EMAIL,,}"
echo "  O TOTP é cadastrado no primeiro login (a resposta traz o otpauthUri para o app autenticador)."
