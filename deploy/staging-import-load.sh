#!/usr/bin/env bash
# Teste de carga do S4 (critério de aceite: 1M linhas importadas em < 10 min no staging).
# Gera um CSV sintético (telefones fictícios, com inválidos e duplicados), envia pela URL pública,
# espera a prévia, confirma e mede. No fim apaga os contatos do cliente de carga (use --keep para manter).
#
# Uso: deploy/staging-import-load.sh [linhas] [--keep]
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=deploy/staging-lib.sh
source ./staging-lib.sh

ROWS="${1:-1000000}"
KEEP="${2:-}"
LIMIT_S=600
staging_login

echo "== cliente de carga"
TENANT="$(api "$BASE/api/v1/tenants?q=Staging%20carga" | jq -r '.data[0].id // empty')"
[[ -n "$TENANT" ]] || TENANT="$(api -X POST "$BASE/api/v1/tenants" -d '{"name":"Staging carga (contatos)"}' | jq -r .id)"
ok "cliente $TENANT"

echo "== gerando CSV com $ROWS linhas"
CSV="$(mktemp --suffix=.csv)"
trap 'rm -f "$CSV" "$JAR"' EXIT
python3 - "$ROWS" "$CSV" <<'PY'
import random, sys
n, path = int(sys.argv[1]), sys.argv[2]
random.seed(42)
ddds = [11, 21, 31, 41, 47, 48, 51, 61, 71, 81, 85, 91]
cidades = ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Florianópolis']
with open(path, 'w', encoding='utf-8') as f:
    f.write('nome;celular;cidade\n')
    prev = None
    for i in range(n):
        ddd = ddds[i % len(ddds)]
        if i % 100 == 99:
            phone = '12345'                           # 1% inválido
        elif i % 100 == 98 and prev:
            phone = '+55 ' + prev                     # 1% duplicado do anterior (outro formato)
        else:
            phone = f'{ddd} 9{i:08d}'
        prev = phone if phone != '12345' and not phone.startswith('+') else prev
        f.write(f'Contato {i};{phone};{cidades[i % len(cidades)]}\n')
PY
ok "$(du -h "$CSV" | cut -f1) em $CSV"

echo "== upload"
T0=$(date +%s)
UP="$(curl -fsS -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/tenants/$TENANT/imports" \
  --form-string listName="Carga $ROWS" --form-string originDeclaration=other \
  --form-string legalBasis=legitimo_interesse --form-string declarationAccepted=true \
  --form-string declarationNotes="teste de carga sintético" \
  --form-string mapping='{"phone":"celular","name":"nome","attributes":{"cidade":"cidade"}}' \
  -F "file=@$CSV;filename=carga.csv")"
ID="$(jq -r .id <<<"$UP")"
T1=$(date +%s)
ok "enviado em $((T1 - T0)) s (importação $ID)"

wait_status() { # wait_status <status esperado>
  local st
  for _ in $(seq 1 $LIMIT_S); do
    st="$(api "$BASE/api/v1/tenants/$TENANT/imports/$ID" | jq -r .status)"
    [[ "$st" == "$1" ]] && return 0
    [[ "$st" == failed ]] && fail "importação falhou: $(api "$BASE/api/v1/tenants/$TENANT/imports/$ID" | jq -r .error)"
    sleep 1
  done
  fail "tempo esgotado esperando $1 (status $st)"
}

echo "== análise (prévia)"
wait_status preview
T2=$(date +%s)
api "$BASE/api/v1/tenants/$TENANT/imports/$ID" |
  jq -r '"  linhas \(.rowCount) · válidas \(.validCount) · inválidas \(.invalidCount) · duplicadas \(.duplicateCount) · suprimidas \(.suppressedCount)"'
ok "prévia em $((T2 - T1)) s"

echo "== confirmação"
api -X POST "$BASE/api/v1/tenants/$TENANT/imports/$ID/confirm" -d '{}' >/dev/null
wait_status confirmed
T3=$(date +%s)
LIST="$(api "$BASE/api/v1/tenants/$TENANT/imports/$ID" | jq -r .listId)"
SIZE="$(api "$BASE/api/v1/tenants/$TENANT/lists/$LIST" | jq -r .size)"
ok "lista com $SIZE contatos em $((T3 - T2)) s"

TOTAL=$((T3 - T0))
echo
echo "TOTAL: ${TOTAL} s para $ROWS linhas (upload $((T1 - T0)) s · prévia $((T2 - T1)) s · confirmação $((T3 - T2)) s)"
((TOTAL < LIMIT_S)) || fail "acima de $LIMIT_S s"

if [[ "$KEEP" != --keep ]]; then
  echo "== limpeza (contatos do cliente de carga)"
  ssh "$HOST" "docker exec bm-platform-bm-postgres-1 psql -U bm_owner -d bm -qAt -c \"
    delete from contact_lists where tenant_id = '$TENANT';
    delete from contacts where tenant_id = '$TENANT';
    vacuum analyze contacts, contact_list_members, consent_records;\""
  ok "removidos"
fi
echo "CARGA OK"
