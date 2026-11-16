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

## Arquivos

| Arquivo                                             | Função                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/provision.sh`                               | Endurecimento idempotente (usuário sem root, SSH só por chave, atualizações automáticas, ufw + DOCKER-USER, swap). Dry-run por padrão.                     |
| `deploy/docker-compose.prod.yml`                    | Pilha: `bm-postgres` → `migrate` → `api`. Nenhuma porta publicada.                                                                                         |
| `deploy/docker-compose.vps.yml`                     | Rede `coolify` + labels do Traefik (domínio `API_HOST`).                                                                                                   |
| `deploy/docker-compose.sim.yml`                     | Staging: sobe o **meta-sim** (sem porta publicada) e aponta `META_GRAPH_BASE_URL` para ele.                                                                |
| `deploy/bm-deploy.sh`                               | Script do lado da VPS (`/usr/local/sbin/bm-deploy`): implanta uma tag, fixa `IMAGE_TAG` no `.env`, smoke test. Os composes vêm de dentro da imagem da API. |
| `deploy/vps-deploy.sh`                              | Ponte manual do PC: build local → `docker load` na VPS → instala o `bm-deploy` → implanta.                                                                 |
| `deploy/staging-e2e.sh`                             | Teste ponta a ponta no staging: login+TOTP → webhook (verificação/assinatura) → cadastro de ativos → webhook do sim → sync.                                |
| `deploy/staging-lib.sh` / `staging-add-operator.sh` | Login de serviço (senha + TOTP) e criação de operadores pela API.                                                                                          |
| `deploy/set-meta-app.sh`                            | Troca o simulador pelo app real da Meta (pede o app secret sem eco e grava só na VPS).                                                                     |
| `.github/workflows/deploy.yml`                      | Caminho normal: build/push no GHCR e deploy por SSH, com smoke test.                                                                                       |

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

## Operação

- **Kernel/reboot:** as atualizações automáticas não reiniciam a máquina (há produção de terceiros
  no host). Quando existir `/var/run/reboot-required`, agende uma janela de madrugada. Todos os
  containers do host têm política de restart (`unless-stopped`/`always`); confira depois com
  `docker ps` (Vendra, bms, Coolify, bm-platform).

## Pendente antes do piloto (D-16)

- [ ] Backup contínuo do Postgres **fora** da VPS (ex.: Cloudflare R2), com restauração testada.
- [ ] Domínio próprio + Cloudflare na frente. Ao ligar o proxy da Cloudflare, revisar o `trustProxy` (IP real do cliente).
- [ ] Monitor externo com alerta (ex.: `/readyz`).
- [ ] Decidir a VPS de produção (isolamento das pilhas não oficiais).
