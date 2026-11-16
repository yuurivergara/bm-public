#!/usr/bin/env bash
# Deploy manual do PC para a VPS, sem GitHub/GHCR (ponte até o fluxo Actions → Coolify).
#
#   deploy/vps-deploy.sh            # build local → envia a imagem por SSH → compose up
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

cd "$(git rev-parse --show-toplevel)"

echo "== build $IMAGE:$TAG"
docker build -q -f apps/api/Dockerfile -t "$IMAGE:$TAG" -t "$IMAGE:staging" .

echo "== enviando imagem para $HOST"
docker save "$IMAGE:$TAG" "$IMAGE:staging" | gzip -1 | ssh "$HOST" 'gunzip | docker load -q'

echo "== arquivos de compose"
ssh "$HOST" "install -d -m 750 $DIR"
scp -q deploy/docker-compose.prod.yml deploy/docker-compose.vps.yml "$HOST:$DIR/"

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
add APP_ENV staging
add PULL_POLICY never
sed -i "/^API_HOST=/d" "$ENV"; echo "API_HOST=$API_HOST" >> "$ENV"
chmod 600 "$ENV"
echo "variáveis definidas: $(cut -d= -f1 "$ENV" | tr '\n' ' ')"
REMOTE

echo "== subindo"
ssh "$HOST" "cd $DIR && docker compose -p bm-platform --env-file .env -f docker-compose.prod.yml -f docker-compose.vps.yml up -d --wait --remove-orphans 2>&1 | tail -5"

echo "== smoke test"
for _ in $(seq 1 24); do
  if curl -fsS "https://$API_HOST/readyz" 2>/dev/null; then echo; echo "ok: https://$API_HOST ($TAG)"; exit 0; fi
  sleep 5
done
echo "readyz não respondeu em https://$API_HOST" >&2
exit 1
