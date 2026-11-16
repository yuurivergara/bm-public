# Postgres da plataforma com WAL-G (backup contínuo: WAL arquivado + base diária, cifrados).
# Mesma base usada antes (postgres:16.14-bookworm), então o volume de dados existente continua válido.
FROM postgres:16.14-bookworm

# WAL-G v3.0.9 (2026-08-20), build "pg" para glibc 2.35 (bookworm tem 2.36).
# SHA-256 publicado pelo GitHub para o asset wal-g-pg-22.04-amd64.
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl; \
  rm -rf /var/lib/apt/lists/*; \
  curl -fsSL -o /usr/local/bin/wal-g \
    "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-amd64"; \
  echo "${WALG_SHA256}  /usr/local/bin/wal-g" | sha256sum -c -; \
  chmod 755 /usr/local/bin/wal-g; \
  wal-g --version; \
  install -d -o postgres -g postgres -m 700 /backups

# Os scripts já são executáveis no git (COPY preserva o modo; --chmod exige BuildKit).
COPY deploy/postgres/bm-walg-env deploy/postgres/bm-wal-archive deploy/postgres/bm-backup /usr/local/bin/
