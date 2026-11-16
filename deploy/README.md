# Deploy na VPS (D-16)

Staging roda na **VPS BMS** (Hostinger, Campinas), que já tem **Coolify 4.7.5** com Traefik nas
portas 80/443. Fluxo:

```
push no master → CI verde → deploy.yml: build da imagem → GHCR (:sha e :staging)
               → POST /api/v1/deploy na Coolify → Coolify puxa a imagem (pull_policy: always)
               → migrate (one-shot) → api → smoke test /readyz
```

> ⚠️ **Isolamento:** a VPS BMS também roda a Vendra (com Evolution) e o `copy-whats` (Baileys).
> Por isso ela é **somente staging** (meta-sim e números de teste, sem token de cliente real).
> Antes do piloto, decidir: VPS dedicada para produção ou retirar as pilhas não oficiais do host.

## Arquivos

| Arquivo                          | Função                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/provision.sh`            | Endurecimento idempotente (usuário sem root, SSH só por chave, atualizações automáticas, ufw + DOCKER-USER, swap). Dry-run por padrão. |
| `deploy/docker-compose.prod.yml` | Pilha lida pela Coolify: `postgres` → `migrate` → `api`. Nenhuma porta publicada.                                                      |
| `.github/workflows/deploy.yml`   | Build/push no GHCR e deploy via API da Coolify, com espera do resultado e smoke test.                                                  |

## 1. Endurecer a VPS (uma vez)

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

## 2. Configurar a Coolify (uma vez, pelo painel)

1. **Registry:** Servidor → _Registries_ → `ghcr.io`, com usuário do GitHub e um _PAT classic_
   que tenha só `read:packages`.
2. **Projeto novo** `bm-platform` (separado de Comano/Vendra/Assinaturas) → ambiente `staging`.
3. **Recurso:** _Private Repository (with Deploy Key)_ → `git@github.com:yuurivergara/bm-public.git`,
   branch `master`, build pack **Docker Compose**, arquivo `/deploy/docker-compose.prod.yml`.
   Adicione a deploy key (somente leitura) ao repositório no GitHub.
4. **Domínio do serviço `api`:** `https://bm.179-197-76-7.sslip.io`. O Let's Encrypt já emite
   certificado para `*.179-197-76-7.sslip.io` nessa VPS, e os webhooks da Meta exigem HTTPS.
5. **Variáveis:** as `SERVICE_PASSWORD_*` são geradas sozinhas. Gere localmente e cadastre:

   ```bash
   openssl rand -base64 32   # MASTER_KEY
   openssl rand -base64 32   # PHONE_HASH_PEPPER
   ```

   **Guarde as duas no cofre de senhas.** Sem a `MASTER_KEY` não dá para decifrar os tokens Meta
   e os segredos TOTP. Sem o `PHONE_HASH_PEPPER`, a deduplicação e a supressão param de bater.
   Opcional: `APP_ENV` (padrão `staging`), `LOG_LEVEL`, `IMAGE_TAG` (padrão `staging`).
6. **Desligue o auto-deploy por webhook do Git** na Coolify. O deploy vem do GitHub Actions, depois do CI.
7. **Token de API:** Keys & Tokens → token com permissão `deploy` (e `read`).

## 3. Configurar o GitHub (uma vez)

Settings → Environments → `staging`:

| Tipo     | Nome                    | Valor                                                  |
| -------- | ----------------------- | ------------------------------------------------------ |
| variable | `COOLIFY_URL`           | `https://coolify.comano.tech`                          |
| variable | `COOLIFY_RESOURCE_UUID` | UUID do recurso (aparece na URL do recurso na Coolify) |
| variable | `STAGING_URL`           | `https://bm.179-197-76-7.sslip.io`                     |
| secret   | `COOLIFY_TOKEN`         | token do passo 2.7                                     |

## 4. Primeiro operador

No terminal do container `api` (pela Coolify) ou via SSH:

```bash
OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD='...' node dist/scripts/create-owner.js
```

## Operação

- **Rollback:** defina `IMAGE_TAG=<sha>` nas variáveis da Coolify e reimplante (cada build publica `:sha`).
- **Deploy manual:** Actions → _Deploy (staging)_ → _Run workflow_.
- **Kernel/reboot:** as atualizações automáticas não reiniciam a máquina (há produção de terceiros
  no host). Quando existir `/var/run/reboot-required`, agende uma janela.

## Pendente antes do piloto (D-16)

- [ ] Backup contínuo do Postgres **fora** da VPS (ex.: Cloudflare R2), com restauração testada.
- [ ] Domínio próprio + Cloudflare na frente. Ao ligar o proxy da Cloudflare, revisar o `trustProxy` (IP real do cliente).
- [ ] Monitor externo com alerta (ex.: `/readyz`).
- [ ] Decidir a VPS de produção (isolamento das pilhas não oficiais).
