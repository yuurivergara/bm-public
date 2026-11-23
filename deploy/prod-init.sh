#!/usr/bin/env bash
# Cria (ou atualiza) a instância de PRODUÇÃO na VPS BMS, ao lado do staging (decisão de 16/11).
#
#   deploy/prod-init.sh [tag]     # tag padrão: a mesma que está no staging (já testada lá)
#
# - Pilha `bm-prod` em /opt/bm-prod, domínio PROD_HOST, sem meta-sim, Graph API real da Meta.
# - Segredos gerados NA VPS (só na 1ª vez) em /opt/bm-prod/.env (600); nunca exibidos.
#   META_APP_SECRET começa com um valor provisório: rode `deploy/set-meta-app.sh --prod` com o app
#   da plataforma. Clientes com app próprio funcionam antes disso (o secret vai na conexão).
# - Conta do dono criada na 1ª vez; a senha inicial fica em /opt/bm-prod/.owner (600):
#   `ssh bms-vps cat /opt/bm-prod/.owner`. O TOTP é cadastrado no primeiro login.
# - Versões novas em produção: `deploy/prod-init.sh <sha7>` (promove a imagem que passou no staging).
set -euo pipefail

HOST="${VPS_HOST:-bms-vps}"
PROD_HOST="${PROD_HOST:-painel.179-197-76-7.sslip.io}"
OWNER_EMAIL="${OWNER_EMAIL:?defina OWNER_EMAIL (e-mail do dono da conta de produção)}"
OWNER_NAME="${OWNER_NAME:-Yuri}"
DIR=/opt/bm-prod

cd "$(dirname "$0")/.."

echo "== script de deploy da VPS (/usr/local/sbin/bm-deploy)"
scp -q deploy/bm-deploy.sh "$HOST:/tmp/bm-deploy.sh"
ssh "$HOST" "install -o root -g root -m 755 /tmp/bm-deploy.sh /usr/local/sbin/bm-deploy && rm /tmp/bm-deploy.sh"

TAG="${1:-$(ssh "$HOST" "grep -m1 '^IMAGE_TAG=' /opt/bm-platform/.env | cut -d= -f2-")}"
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "tag inválida: $TAG" >&2; exit 1; }

echo "== segredos de produção (gerados na VPS só se ainda não existirem)"
ssh "$HOST" "PROD_HOST='$PROD_HOST' DIR='$DIR' bash -s" <<'REMOTE'
set -euo pipefail
umask 077
install -d -m 750 "$DIR"
ENV="$DIR/.env"
touch "$ENV"
add() { grep -q "^$1=" "$ENV" || echo "$1=$2" >> "$ENV"; }
add MASTER_KEY "$(openssl rand -base64 32)"
add PHONE_HASH_PEPPER "$(openssl rand -base64 32)"
add SERVICE_PASSWORD_POSTGRES "$(openssl rand -hex 24)"
add SERVICE_PASSWORD_BMAPP "$(openssl rand -hex 24)"
# provisório até deploy/set-meta-app.sh --prod (app da plataforma)
add META_APP_SECRET "$(openssl rand -hex 32)"
add META_WEBHOOK_VERIFY_TOKEN "$(openssl rand -hex 24)"
add WALG_LIBSODIUM_KEY "$(openssl rand -base64 32)"
grep -qE "^(WALG_S3_PREFIX|WALG_SSH_PREFIX)=." "$ENV" || add WALG_FILE_PREFIX /backups
add APP_ENV prod
add PULL_POLICY never
add USE_META_SIM false
add ROUTER_NAME bmprod
sed -i "/^API_HOST=/d" "$ENV"; echo "API_HOST=$PROD_HOST" >> "$ENV"
chmod 600 "$ENV"
echo "variáveis definidas: $(cut -d= -f1 "$ENV" | tr '\n' ' ')"
REMOTE

echo "== implantando $TAG em produção"
ssh "$HOST" "BM_INSTANCE=prod /usr/local/sbin/bm-deploy 'deploy $TAG' </dev/null"

echo "== conta do dono"
ssh "$HOST" "OWNER_EMAIL='$OWNER_EMAIL' OWNER_NAME='$OWNER_NAME' DIR='$DIR' bash -s" <<'REMOTE'
set -euo pipefail
umask 077
if [[ -s "$DIR/.owner" ]]; then echo "já existe ($DIR/.owner)"; exit 0; fi
PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
docker exec -e OWNER_EMAIL="$OWNER_EMAIL" -e OWNER_NAME="$OWNER_NAME" -e OWNER_PASSWORD="$PASS" \
  bm-prod-api-1 node dist/scripts/create-owner.js >/dev/null
printf 'email=%s\nsenha=%s\n' "$OWNER_EMAIL" "$PASS" > "$DIR/.owner"
echo "criada; senha inicial em $DIR/.owner"
REMOTE

cat <<EOF

Produção no ar: https://$PROD_HOST
  1. Senha inicial do dono:   ssh $HOST cat $DIR/.owner   (troque depois; TOTP no 1º login)
  2. Copie $DIR/.env para o cofre (MASTER_KEY, PHONE_HASH_PEPPER, WALG_LIBSODIUM_KEY).
  3. App da plataforma (seu BM):  deploy/set-meta-app.sh --prod
  4. Backup fora da VPS:          deploy/set-backup-r2.sh --prod
EOF
