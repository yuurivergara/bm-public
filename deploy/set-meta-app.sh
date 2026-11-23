#!/usr/bin/env bash
# Liga o staging ao app REAL da Meta (desliga o meta-sim), ou volta ao simulador.
#
#   deploy/set-meta-app.sh          # pede App ID e App Secret (sem eco) e gera o verify token
#   deploy/set-meta-app.sh --sim    # volta ao meta-sim (gera segredos de simulação novos)
#
# O App Secret fica em App Dashboard → Configurações do app → Básico. Ele vai direto para
# /opt/bm-platform/.env na VPS (600) e não é gravado no PC nem no repositório.
set -euo pipefail

HOST="${VPS_HOST:-bms-vps}"
DIR=/opt/bm-platform
INSTANCE=staging
if [[ "${1:-}" == "--prod" ]]; then
  DIR=/opt/bm-prod
  INSTANCE=prod
  shift
fi

remote_apply() {
  # stdin: linhas CHAVE=valor
  ssh "$HOST" "DIR=$DIR bash -c '
    set -euo pipefail; umask 077; cd \"\$DIR\"
    while IFS== read -r k v; do
      [[ -n \"\$k\" ]] || continue
      if grep -q \"^\$k=\" .env; then sed -i \"s|^\$k=.*|\$k=\$v|\" .env; else printf \"%s=%s\n\" \"\$k\" \"\$v\" >> .env; fi
    done
    chmod 600 .env
    tag=\$(grep -m1 \"^IMAGE_TAG=\" .env | cut -d= -f2-)
    BM_INSTANCE=$INSTANCE /usr/local/sbin/bm-deploy \"deploy \$tag\" </dev/null'"
}

if [[ "${1:-}" == "--sim" ]]; then
  printf 'USE_META_SIM=true\nMETA_APP_ID=\nMETA_APP_SECRET=%s\nMETA_WEBHOOK_VERIFY_TOKEN=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" | remote_apply
  echo "Staging de volta ao meta-sim."
  exit 0
fi

read -rp "META_APP_ID: " APP_ID
[[ "$APP_ID" =~ ^[0-9]{5,25}$ ]] || { echo "App ID deve ser numérico" >&2; exit 1; }
read -rsp "META_APP_SECRET (não aparece na tela): " SECRET
echo
[[ "$SECRET" =~ ^[0-9a-f]{32}$ ]] || { echo "App Secret deve ter 32 caracteres hexadecimais" >&2; exit 1; }
VERIFY="$(openssl rand -hex 24)"

printf 'USE_META_SIM=false\nMETA_APP_ID=%s\nMETA_APP_SECRET=%s\nMETA_WEBHOOK_VERIFY_TOKEN=%s\n' \
  "$APP_ID" "$SECRET" "$VERIFY" | remote_apply
unset SECRET

API_HOST="$(ssh "$HOST" "grep -m1 '^API_HOST=' $DIR/.env | cut -d= -f2-")"
cat <<EOF

Staging ligado ao app $APP_ID. Agora, no App Dashboard → WhatsApp → Configuração → Webhook:
  URL de callback:      https://$API_HOST/webhooks/meta
  Token de verificação: $VERIFY
Depois assine os campos: account_update, account_review_update, account_alerts,
business_capability_update, phone_number_name_update, phone_number_quality_update,
message_template_status_update, message_template_quality_update, template_category_update,
messages, user_preferences, security.
EOF
