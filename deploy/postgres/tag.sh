#!/bin/sh
# Tag da imagem bm-postgres = hash do conteúdo desta pasta. Assim o banco só é recriado quando a
# imagem muda de verdade (não a cada deploy do código). Uso: tag.sh [pasta]  (padrão: a do script)
set -eu
d="${1:-$(dirname "$0")}"
cd "$d"
cat Dockerfile bm-walg-env bm-wal-archive bm-backup | sha256sum | cut -c1-12 | sed 's/^/pg-/'
