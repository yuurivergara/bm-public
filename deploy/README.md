# Deploy na VPS (D-16, D-16a, D-16b)

Staging roda na **VPS BMS** (Hostinger, Campinas), que já tem **Coolify 4.7.5** com Traefik nas
portas 80/443. A Coolify entra só como **proxy/TLS** (Traefik + Let's Encrypt, domínio sslip). O
deploy é por SSH com comando forçado (D-16b):

```
push no master → CI verde → deploy.yml: build das imagens (API + meta-sim) → GHCR (:sha7 e :staging)
   → ssh deploy@VPS "deploy <sha7>"   (a chave só executa /usr/local/sbin/bm-deploy)
   → bm-deploy: login GHCR com o GITHUB_TOKEN do job → pull → extrai os composes da imagem
   → migrate (one-shot) → api + meta-sim → smoke test /readyz
```

> ⚠️ **Isolamento:** a VPS BMS também roda a Vendra (com Evolution) e o `copy-whats` (Baileys).
> Por isso ela é **somente staging** (meta-sim e números de teste, sem token de cliente real).
> Antes do piloto, decidir: VPS dedicada para produção ou retirar as pilhas não oficiais do host.

## Produção (decisão de 16/11)

Segunda instância na mesma VPS, isolada do staging: pilha **`bm-prod`** em `/opt/bm-prod`, domínio
**https://painel.179-197-76-7.sslip.io**, Graph API **real** (nunca meta-sim), banco, segredos e backup próprios.

- Criar/promover: `OWNER_EMAIL=… deploy/prod-init.sh [sha7]` (padrão: a tag que está no staging, já testada).
  O Actions **só** implanta o staging: `BM_INSTANCE=prod` só chega quando o root chama o `bm-deploy` direto.
- App da plataforma (BM do Yuri): `deploy/set-meta-app.sh --prod`. Até lá o `META_APP_SECRET` é provisório e só
  funcionam clientes com **app próprio** (ID + chave secreta do app informados na conexão, pelo painel).
- Backup no R2: `deploy/set-backup-r2.sh --prod`.
- ⚠️ Condição da decisão: Vendra (Evolution), bms e copy-whats **parados** antes de tokens reais de clientes.

## Arquivos

| Arquivo                                             | Função                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/provision.sh`                               | Endurecimento idempotente (usuário sem root, SSH só por chave, atualizações automáticas, ufw + DOCKER-USER, swap). Dry-run por padrão.                                                  |
| `deploy/docker-compose.prod.yml`                    | Pilha: `bm-postgres` (+ `bm-backup`) → `migrate` → `api`. Nenhuma porta publicada.                                                                                                      |
| `deploy/docker-compose.vps.yml`                     | Rede `coolify` + labels do Traefik (domínio `API_HOST`).                                                                                                                                |
| `deploy/docker-compose.sim.yml`                     | Staging: sobe o **meta-sim** (sem porta publicada) e aponta `META_GRAPH_BASE_URL` para ele.                                                                                             |
| `deploy/bm-deploy.sh`                               | Script do lado da VPS (`/usr/local/sbin/bm-deploy`): implanta uma tag, fixa `IMAGE_TAG` no `.env`, smoke test. Os composes vêm de dentro da imagem da API.                              |
| `deploy/vps-deploy.sh`                              | Ponte manual do PC: build local → `docker load` na VPS → instala o `bm-deploy` → implanta.                                                                                              |
| `deploy/staging-e2e.sh`                             | Teste ponta a ponta no staging: login+TOTP → webhook (verificação/assinatura) → cadastro de ativos → webhook do sim → sync.                                                             |
| `deploy/set-backup-r2.sh`                           | Liga o backup no Cloudflare R2 (pede Account ID, bucket e chaves sem eco; grava só no `.env` da VPS), opcionalmente o ping do healthchecks.io, reimplanta e confere base + restauração. |
| `deploy/staging-import-load.sh`                     | Teste de carga do S4: CSV sintético de 1M linhas → prévia → confirmação, mede e limpa.                                                                                                  |
| `deploy/staging-lib.sh` / `staging-add-operator.sh` | Login de serviço (senha + TOTP) e criação de operadores pela API.                                                                                                                       |
| `deploy/set-meta-app.sh`                            | Troca o simulador pelo app real da Meta (pede o app secret sem eco e grava só na VPS). `--prod`: app da plataforma na produção.                                                        |
| `deploy/prod-init.sh`                               | Cria/atualiza a produção (`bm-prod`): segredos na VPS, deploy da tag testada no staging, conta do dono.                                                                                 |
| `deploy/postgres/`                                  | Imagem `bm-postgres` (Postgres + WAL-G), scripts `bm-backup`/`bm-wal-archive`, `tag.sh` e o teste `test-backup.sh`.                                                                     |
| `.github/workflows/deploy.yml`                      | Caminho normal: build/push no GHCR e deploy por SSH, com smoke test.                                                                                                                    |

## Estado atual (2026-11-16)

- ✅ VPS endurecida com `provision.sh` (sem `--close-coolify-ports`): ufw (22, 80, 443) + DOCKER-USER,
  SSH só por chave, usuário `deploy`, atualizações automáticas sem reboot.
- ✅ Staging no ar em **https://bm.179-197-76-7.sslip.io** (pilha `bm-platform` em `/opt/bm-platform`,
  roteada pelo Traefik da Coolify).
- ✅ S2 no staging: migration 0002 aplicada, meta-sim na rede interna, `deploy/staging-e2e.sh` passando.
- ✅ GitHub (environment `staging`) configurado: `VPS_SSH_KEY`, `VPS_HOST`, `VPS_KNOWN_HOSTS`,
  `STAGING_URL`. Chave `github-actions-bm-deploy` instalada com comando forçado.
- ⏳ Primeiro deploy pelo Actions: depende do push com escopo `workflow`
  (`gh auth refresh -h github.com -s workflow`) e do merge no `master`.
- ⏳ Reboot pendente do kernel (ver Operação).

## Segredos

Gerados **na VPS** na primeira execução da ponte, em `/opt/bm-platform/.env` (600), nunca exibidos
pelos scripts. Copie para o cofre de senhas: `ssh bms-vps cat /opt/bm-platform/.env`.

- `MASTER_KEY`: sem ela não dá para decifrar tokens Meta e segredos TOTP.
- `PHONE_HASH_PEPPER`: sem ele a deduplicação e a supressão param de bater.
- `WALG_LIBSODIUM_KEY`: chave dos backups. **Sem ela nenhum backup pode ser restaurado** — guarde no
  cofre fora da VPS (se a VPS sumir, é a única coisa que falta para restaurar do destino remoto).
- `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` / `SIM_DEMO_TOKEN`: **do simulador** até rodar
  `deploy/set-meta-app.sh`.

Contas no staging: `owner@staging.local` é a conta de teste do e2e (credenciais em
`/opt/bm-platform/.owner`). Operadores são criados com `deploy/staging-add-operator.sh <email> <nome> [papel]`
(pela API, auditado); a senha inicial fica em `/opt/bm-platform/.operator-<email>` e o TOTP é cadastrado
no primeiro login.

## Deploy

- **Normal:** merge no `master` → CI → _Deploy (staging)_. Manual: Actions → _Deploy (staging)_ → _Run workflow_.
- **Ponte (sem GitHub):** `deploy/vps-deploy.sh`.
- **Rollback:** `ssh bms-vps "/usr/local/sbin/bm-deploy 'deploy <sha7>' </dev/null"` (a imagem precisa
  estar na VPS; as do GHCR ficam lá depois do primeiro pull) ou rode o workflow no commit antigo.
- **Teste ponta a ponta:** `deploy/staging-e2e.sh`.

Para criar outro operador:

```bash
ssh bms-vps "docker exec -it -e OWNER_EMAIL=... -e OWNER_NAME=... -e OWNER_PASSWORD='...' \
  bm-platform-api-1 node dist/scripts/create-owner.js"
```

> ⚠️ Na rede `coolify`, o nome `postgres` é alias do **banco interno da Coolify**. Por isso o
> serviço se chama `bm-postgres`. Nunca use nomes genéricos (`postgres`, `redis`, `db`) em
> serviços que entram nessa rede.

## Endurecer uma VPS (uma vez)

```bash
scp deploy/provision.sh bms-vps:/root/provision.sh
ssh bms-vps 'bash /root/provision.sh'                                   # plano, nada muda
ssh bms-vps "bash /root/provision.sh --apply --pubkey '$(cat ~/.ssh/bms_vps.pub)'"
ssh deploy@179.197.76.7 'sudo -n true && echo ok'                        # testar ANTES de sair
```

O script não reinicia o Docker, os containers nem a máquina. Ele mantém o root com login por chave,
porque a Coolify administra o host assim.

**Portas da Coolify** (`--close-coolify-ports`): bloqueia de fora as portas 8000 (painel por HTTP),
8080 (Traefik), 6001 e 6002 (realtime/terminal). O painel já responde em `coolify.comano.tech`.
⚠️ A validar: depois de aplicar, conferir se o realtime e o terminal da Coolify continuam funcionando
pelo domínio. Para desfazer, remova o bloco `bm-platform DOCKER-USER` de `/etc/ufw/after.rules` e rode `ufw reload`.

Observação: portas publicadas pelo Docker não passam pelas regras do `ufw`. Por isso o bloqueio
fica na chain `DOCKER-USER`.

**Chave do GitHub Actions** (já instalada na VPS BMS). Para outra VPS:

```bash
ssh-keygen -t ed25519 -N "" -C github-actions-bm-deploy -f /tmp/k
gh secret set VPS_SSH_KEY --env staging < /tmp/k && shred -u /tmp/k
printf 'command="sudo -n /usr/local/sbin/bm-deploy \\"$SSH_ORIGINAL_COMMAND\\"",restrict %s\n' "$(cat /tmp/k.pub)" \
  | ssh <vps> 'cat >> ~deploy/.ssh/authorized_keys'
gh variable set VPS_KNOWN_HOSTS --env staging < <(ssh-keyscan -t ed25519 <ip>)
```

## Backup (WAL-G)

O `bm-postgres` usa a imagem `bm-postgres` (Postgres 16.14 + WAL-G v3.0.9, `deploy/postgres/`), com tag pelo
hash do conteúdo da pasta: o banco só é recriado quando essa imagem muda.

- **Contínuo:** cada segmento de WAL vai **cifrado** (libsodium) e comprimido (zstd) para o destino;
  `archive_timeout=300` → perda máxima de ~5 min (RPO, docs/02).
- **Base diária** às `BACKUP_TIME` (03:15), retenção de `BACKUP_RETAIN_FULL` bases (7) — serviço `bm-backup`.
- **Restauração testada automaticamente** toda semana (`BACKUP_VERIFY_WEEKDAY`, 7 = domingo): baixa a última
  base + WAL, sobe um Postgres isolado (sem rede e sem arquivar), confere migrations/clientes e apaga.
  No CI, `deploy/postgres/test-backup.sh` prova a cada push que dados gravados depois da base voltam pelo WAL
  e que nada fica em texto puro no destino.
- **Alerta:** `BACKUP_PING_URL` (ex.: healthchecks.io) recebe ping no sucesso e `/fail` na falha;
  a checagem do arquivamento roda a cada 5 min.

**Destino.** Hoje: `WALG_FILE_PREFIX=/backups` (volume na **mesma VPS** — protege contra erro humano/corrupção,
não contra perda do servidor). Para mandar para fora, troque no `/opt/bm-platform/.env` e reimplante:

```bash
# Cloudflare R2 (S3 compatível) — bucket privado + token de API com acesso só a ele
WALG_S3_PREFIX=s3://bm-backups/staging
AWS_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_REGION=auto
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# e remova WALG_FILE_PREFIX
```

Depois de trocar o destino, rode uma base na hora (a próxima restauração depende dela):

```bash
ssh bms-vps 'cd /opt/bm-platform && docker compose -p bm-platform exec bm-backup bm-backup base \
  && docker compose -p bm-platform exec bm-backup bm-backup verify'
```

Comandos: `bm-backup base | verify | archiver | list` (dentro do serviço `bm-backup`); logs em
`docker logs bm-platform-bm-backup-1`.

**Restaurar de verdade (desastre):** numa VPS nova, com o mesmo `.env` (inclusive `WALG_LIBSODIUM_KEY` e o
destino), suba só a imagem e restaure no volume vazio antes de iniciar o banco:

```bash
docker compose -p bm-platform run --rm --no-deps --user postgres --entrypoint bash bm-postgres -c \
  'source bm-walg-env && wal-g backup-fetch "$PGDATA" LATEST && touch "$PGDATA/recovery.signal" \
   && echo "restore_command = '"'"'wal-g wal-fetch \"%f\" \"%p\"'"'"'" >> "$PGDATA/postgresql.auto.conf"'
# depois: bm-deploy normal; o Postgres aplica o WAL até o fim e promove. Confira /readyz e os dados.
```

## Operação

- **Kernel/reboot:** as atualizações automáticas não reiniciam a máquina (há produção de terceiros
  no host). Quando existir `/var/run/reboot-required`, agende uma janela de madrugada. Todos os
  containers do host têm política de restart (`unless-stopped`/`always`); confira depois com
  `docker ps` (Vendra, bms, Coolify, bm-platform).

## Pendente antes do piloto (D-16)

- [ ] Backup contínuo do Postgres **fora** da VPS: mecanismo pronto e restauração testada (WAL-G, seção Backup); falta o destino remoto (R2/B2) e o `BACKUP_PING_URL`.
- [ ] Domínio próprio + Cloudflare na frente. Ao ligar o proxy da Cloudflare, revisar o `trustProxy` (IP real do cliente).
- [ ] Monitor externo com alerta (ex.: `/readyz`).
- [ ] Decidir a VPS de produção (isolamento das pilhas não oficiais).
