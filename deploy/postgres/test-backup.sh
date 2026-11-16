#!/usr/bin/env bash
# Teste de integração do backup (roda no CI e localmente): sobe o Postgres com arquivamento, faz a
# base, grava dados DEPOIS dela, restaura num Postgres isolado e exige que esses dados voltem (prova
# que o WAL arquivado é aplicado). Também confere que nada fica em texto puro no destino.
# Uso: deploy/postgres/test-backup.sh [imagem]   (padrão: bm-postgres:ci)
set -euo pipefail
IMG="${1:-bm-postgres:ci}"
N="bmbk-test-$$"
KEY="$(openssl rand -base64 32)"
MARKER="texto-claro-$(openssl rand -hex 8)"

cleanup() {
  docker rm -f "$N-db" >/dev/null 2>&1 || true
  docker volume rm "$N-data" "$N-backups" >/dev/null 2>&1 || true
  docker network rm "$N" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$N" >/dev/null

COMMON=(-e WALG_LIBSODIUM_KEY="$KEY" -e WALG_FILE_PREFIX=/backups -v "$N-backups:/backups")
docker run -d --name "$N-db" --network "$N" --network-alias bm-postgres \
  -e POSTGRES_USER=bm_owner -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=bm "${COMMON[@]}" \
  -v "$N-data:/var/lib/postgresql/data" "$IMG" \
  postgres -c wal_level=replica -c archive_mode=on -c 'archive_command=bm-wal-archive %p' \
  -c archive_timeout=300 >/dev/null

sql() { docker exec -i "$N-db" psql -X -qAt -v ON_ERROR_STOP=1 -U bm_owner -d bm "$@"; }
bk() {
  docker run --rm --network "$N" --user postgres -e PGHOST=bm-postgres -e PGUSER=bm_owner \
    -e PGPASSWORD=pw -e PGDATABASE=bm "${COMMON[@]}" \
    -v "$N-data:/var/lib/postgresql/data:ro" "$IMG" bm-backup "$@"
}

# O entrypoint inicializa, para e sobe de novo: espera o servidor definitivo (escuta TCP).
for _ in $(seq 1 60); do
  docker exec "$N-db" pg_isready -q -h 127.0.0.1 -U bm_owner -d bm && break
  sleep 1
done

sql <<SQL
create table schema_migrations (name text primary key);
insert into schema_migrations values ('0001'), ('0002'), ('0003');
create table tenants (id serial primary key, name text);
insert into tenants (name) values ('a'), ('b');
create table audit_logs (created_at timestamptz not null default now(), note text);
insert into audit_logs (note) values ('$MARKER');
SQL

echo "== base"
bk base

echo "== dados depois da base (só voltam pelo WAL)"
sql -c "insert into schema_migrations values ('0004'); insert into tenants (name) values ('c');"
before="$(sql -c "select archived_count from pg_stat_archiver")"
sql -c "select pg_switch_wal()" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(sql -c "select archived_count from pg_stat_archiver")" -gt "$before" ]] && break
  sleep 1
done
bk archiver

echo "== restauração"
out="$(bk verify 2>&1)" || { echo "$out"; echo "FALHOU: verify" >&2; exit 1; }
echo "$out"
grep -q "migrations 4/4, clientes 3/3" <<<"$out" || { echo "FALHOU: restauração sem os dados do WAL" >&2; exit 1; }
grep -q "verify: ok" <<<"$out" || { echo "FALHOU: verify" >&2; exit 1; }

echo "== destino cifrado"
if docker run --rm -v "$N-backups:/b:ro" "$IMG" grep -rqa "$MARKER" /b; then
  echo "FALHOU: dado em texto puro no destino do backup" >&2
  exit 1
fi
echo "BACKUP OK"
