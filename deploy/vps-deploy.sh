#!/usr/bin/env bash
# Deploy manual do PC para a VPS, sem GitHub/GHCR (o caminho normal é .github/workflows/deploy.yml).
#
#   deploy/vps-deploy.sh            # build local → envia as imagens por SSH → bm-deploy na VPS
#
# Na VPS, a pilha fica em /opt/bm-platform. Os segredos ficam em /opt/bm-platform/.env (600),
# gerados NA VPS na primeira execução e nunca exibidos. Copie MASTER_KEY e PHONE_HASH_PEPPER
# para o seu cofre de senhas: `ssh bms-vps cat /opt/bm-platform/.env`.
set -euo pipefail

HOST="${VPS_HOST:-bms-vps}"
DIR=/opt/bm-platform
API_HOST="${API_HOST:-bm.179-197-76-7.sslip.io}"
TAG="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . || echo -dirty)"
IMAGE=ghcr.io/yuurivergara/bm-api
SIM_IMAGE=ghcr.io/yuurivergara/bm-meta-sim

cd "$(git rev-parse --show-toplevel)"

echo "== build $IMAGE:$TAG e $SIM_IMAGE:$TAG"
docker build -q -f apps/api/Dockerfile -t "$IMAGE:$TAG" -t "$IMAGE:staging" .
docker build -q -f apps/meta-sim/Dockerfile -t "$SIM_IMAGE:$TAG" -t "$SIM_IMAGE:staging" .
PG_IMAGE=ghcr.io/yuurivergara/bm-postgres
PG_TAG="$(sh deploy/postgres/tag.sh)"
docker build -q -f deploy/postgres/Dockerfile -t "$PG_IMAGE:$PG_TAG" .

echo "== enviando imagens para $HOST"
docker save "$IMAGE:$TAG" "$IMAGE:staging" "$SIM_IMAGE:$TAG" "$SIM_IMAGE:staging" "$PG_IMAGE:$PG_TAG" \
  | gzip -1 | ssh "$HOST" 'gunzip | docker load -q'

echo "== script de deploy da VPS (/usr/local/sbin/bm-deploy)"
ssh "$HOST" "install -d -m 750 $DIR"
scp -q deploy/bm-deploy.sh "$HOST:/tmp/bm-deploy.sh"
ssh "$HOST" "install -o root -g root -m 755 /tmp/bm-deploy.sh /usr/local/sbin/bm-deploy && rm /tmp/bm-deploy.sh"

echo "== segredos (gerados na VPS só se ainda não existirem)"
ssh "$HOST" "API_HOST='$API_HOST' DIR='$DIR' bash -s" <<'REMOTE'
set -euo pipefail
umask 077
ENV="$DIR/.env"
touch "$ENV"
add() { grep -q "^$1=" "$ENV" || echo "$1=$2" >> "$ENV"; }
add MASTER_KEY "$(openssl rand -base64 32)"
add PHONE_HASH_PEPPER "$(openssl rand -base64 32)"
add SERVICE_PASSWORD_POSTGRES "$(openssl rand -hex 24)"
add SERVICE_PASSWORD_BMAPP "$(openssl rand -hex 24)"
add META_APP_SECRET "$(openssl rand -hex 32)"
add META_WEBHOOK_VERIFY_TOKEN "$(openssl rand -hex 24)"
add SIM_DEMO_TOKEN "EAASIM$(openssl rand -hex 24)"
add WALG_LIBSODIUM_KEY "$(openssl rand -base64 32)"
# Destino local até haver um fora da VPS (deploy/README.md, "Backup").
grep -qE "^(WALG_S3_PREFIX|WALG_SSH_PREFIX)=." "$ENV" || add WALG_FILE_PREFIX /backups
add APP_ENV staging
add PULL_POLICY never
sed -i "/^API_HOST=/d" "$ENV"; echo "API_HOST=$API_HOST" >> "$ENV"
chmod 600 "$ENV"
echo "variáveis definidas: $(cut -d= -f1 "$ENV" | tr '\n' ' ')"
REMOTE

echo "== implantando"
ssh "$HOST" "/usr/local/sbin/bm-deploy 'deploy $TAG' </dev/null"
