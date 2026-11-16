#!/usr/bin/env bash
# Implanta uma versão da plataforma na VPS. Instalado como /usr/local/sbin/bm-deploy (root:root 0755).
#
#   bm-deploy "deploy <tag>"
#
# Chamado de dois jeitos:
#  - GitHub Actions: chave SSH dedicada do usuário `deploy`, com comando forçado no authorized_keys
#      command="sudo -n /usr/local/sbin/bm-deploy \"$SSH_ORIGINAL_COMMAND\"",restrict ssh-ed25519 ...
#    A chave só consegue rodar isto. Usuário e token do GHCR chegam pelo stdin (duas linhas; o
#    GITHUB_TOKEN do job, que expira ao fim dele) e as imagens são baixadas do GHCR.
#  - Ponte manual (deploy/vps-deploy.sh), como root, com stdin vazio: usa imagens já carregadas.
set -euo pipefail

DIR=/opt/bm-platform
PROJECT=bm-platform
REGISTRY=ghcr.io
COMPOSE=(docker compose -p "$PROJECT" --env-file .env
  -f docker-compose.prod.yml -f docker-compose.vps.yml)

# shellcheck disable=SC2086
set -- ${1:-}
if [[ $# -ne 2 || "$1" != deploy || ! "$2" =~ ^[0-9a-f]{7,40}(-dirty)?$ ]]; then
  echo "uso: deploy <sha>" >&2
  exit 2
fi
TAG="$2"

cd "$DIR"
umask 077

USER_LINE=""
TOKEN_LINE=""
if [[ ! -t 0 ]]; then
  IFS= read -r USER_LINE || true
  IFS= read -r TOKEN_LINE || true
fi

if [[ -n "$TOKEN_LINE" ]]; then
  # Credencial do registry só para este deploy, fora do ~/.docker do root.
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  printf '%s' "$TOKEN_LINE" | docker login "$REGISTRY" -u "$USER_LINE" --password-stdin >/dev/null
  PULL=always
else
  PULL=never
fi

# Fixa a versão no .env: reinícios manuais e reboot sobem a mesma tag.
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi
}
set_env IMAGE_TAG "$TAG"
set_env PULL_POLICY never

# meta-sim ligado até o app real da Meta ser configurado (deploy/set-meta-app.sh).
if ! grep -q '^USE_META_SIM=false' .env; then
  COMPOSE+=(-f docker-compose.sim.yml)
fi

API_IMAGE="$REGISTRY/yuurivergara/bm-api:$TAG"
SIM_IMAGE="$REGISTRY/yuurivergara/bm-meta-sim:$TAG"
echo "== $PROJECT: implantando $TAG (pull=$PULL)"
if [[ "$PULL" == always ]]; then
  docker pull -q "$API_IMAGE" >/dev/null
  docker pull -q "$SIM_IMAGE" >/dev/null
fi

# Os arquivos de compose vêm dentro da imagem da API (mesma versão do código).
cid="$(docker create "$API_IMAGE")"
docker cp "$cid:/app/deploy/." "$DIR/" >/dev/null
docker rm -f "$cid" >/dev/null
chmod 640 "$DIR"/docker-compose.*.yml
"${COMPOSE[@]}" up -d --wait --remove-orphans 2>&1 | tail -5

API_HOST="$(grep -m1 '^API_HOST=' .env | cut -d= -f2-)"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$API_HOST/readyz" >/dev/null 2>&1; then
    echo "ok: https://$API_HOST ($TAG)"
    exit 0
  fi
  sleep 2
done
echo "falha: https://$API_HOST/readyz não respondeu" >&2
exit 1
