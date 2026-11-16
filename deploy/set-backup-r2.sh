#!/usr/bin/env bash
# Liga o backup do Postgres no Cloudflare R2 (decisão "destino-backup = r2") e, opcionalmente, o ping
# do monitor (healthchecks.io). Pede tudo no terminal — o secret sem eco —, grava só no .env da VPS
# (enviado por stdin, nunca na linha de comando), reimplanta e faz uma base + teste de restauração.
#
# Antes, no painel da Cloudflare: R2 → criar bucket privado (ex.: bm-backups) → "Manage API tokens" →
# token com "Object Read & Write" só nesse bucket. Anote Account ID, Access Key ID e Secret Access Key.
#
# Uso: deploy/set-backup-r2.sh            (pergunta tudo)
#      deploy/set-backup-r2.sh --ping-only (só a URL do healthchecks.io)
set -euo pipefail
HOST="${VPS_HOST:-bms-vps}"
DIR=/opt/bm-platform

ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }
lines=()

if [[ "${1:-}" != --ping-only ]]; then
  ACCOUNT="$(ask 'Account ID da Cloudflare (32 hex)')"
  [[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo "Account ID inválido" >&2; exit 2; }
  BUCKET="$(ask 'Bucket [bm-backups]')"; BUCKET="${BUCKET:-bm-backups}"
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "nome de bucket inválido" >&2; exit 2; }
  PREFIX="$(ask 'Pasta dentro do bucket [staging]')"; PREFIX="${PREFIX:-staging}"
  [[ "$PREFIX" =~ ^[a-z0-9][a-z0-9/_-]*$ ]] || { echo "pasta inválida" >&2; exit 2; }
  KEY_ID="$(ask 'Access Key ID')"
  [[ "$KEY_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "Access Key ID inválido (32 hex)" >&2; exit 2; }
  read -r -s -p 'Secret Access Key (não aparece): ' SECRET; echo
  [[ "$SECRET" =~ ^[0-9a-f]{64}$ ]] || { echo "Secret inválido (64 hex)" >&2; exit 2; }
  lines+=(
    "WALG_S3_PREFIX=s3://$BUCKET/$PREFIX"
    "AWS_ENDPOINT=https://$ACCOUNT.r2.cloudflarestorage.com"
    "AWS_REGION=auto"
    "AWS_S3_FORCE_PATH_STYLE=true"
    "AWS_ACCESS_KEY_ID=$KEY_ID"
    "AWS_SECRET_ACCESS_KEY=$SECRET"
    "-WALG_FILE_PREFIX"
  )
fi

PING="$(ask 'URL de ping do healthchecks.io (Enter para pular)')"
if [[ -n "$PING" ]]; then
  [[ "$PING" =~ ^https://hc-ping\.com/[A-Za-z0-9/_-]+$ ]] || { echo "URL de ping inválida" >&2; exit 2; }
  lines+=("BACKUP_PING_URL=$PING")
fi
((${#lines[@]})) || { echo "nada a fazer"; exit 0; }

echo "== gravando no $DIR/.env da VPS"
printf '%s\n' "${lines[@]}" | ssh "$HOST" "DIR='$DIR' bash -c '
  set -euo pipefail; umask 077; ENV=\"\$DIR/.env\"
  while IFS= read -r line; do
    if [[ \"\$line\" == -* ]]; then sed -i \"/^\${line#-}=/d\" \"\$ENV\"; continue; fi
    k=\"\${line%%=*}\"; sed -i \"/^\$k=/d\" \"\$ENV\"; printf \"%s\n\" \"\$line\" >> \"\$ENV\"
  done
  chmod 600 \"\$ENV\"; echo \"variáveis: \$(cut -d= -f1 \"\$ENV\" | tr \"\n\" \" \")\"'"

echo "== reimplantando a versão atual"
TAG="$(ssh "$HOST" "grep -m1 '^IMAGE_TAG=' $DIR/.env | cut -d= -f2")"
ssh "$HOST" "/usr/local/sbin/bm-deploy 'deploy $TAG' </dev/null"

echo "== base + teste de restauração no destino novo (feitos pelo bm-backup ao subir)"
ssh "$HOST" 'set -u; C=bm-platform-bm-backup-1
  since=$(docker inspect -f "{{.State.StartedAt}}" $C)
  logs() { docker logs --since "$since" $C 2>&1 | grep "backup:"; }
  for _ in $(seq 1 30); do logs | grep -q "base: iniciando" && break; sleep 2; done
  if logs | grep -q "base: iniciando"; then
    for _ in $(seq 1 600); do logs | grep -qE "verify: (ok|FALHOU)|FALHOU" && break; sleep 2; done
    out=$(logs)
  else
    # o destino já tinha base: faz uma nova e testa a restauração
    out=$(docker exec $C bm-backup base 2>&1; docker exec $C bm-backup verify 2>&1)
  fi
  echo "$out"
  grep -q "verify: ok" <<<"$out"' || { echo "o backup remoto falhou: veja as linhas acima" >&2; exit 1; }
echo "BACKUP REMOTO OK"
