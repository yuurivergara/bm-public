#!/usr/bin/env bash
# Endurecimento idempotente de uma VPS Ubuntu 24.04 para a plataforma (D-16).
#
# Funciona tanto numa VPS nova quanto num host que já roda Coolify (caso da VPS BMS):
#   - NUNCA reinicia o Docker nem containers, NUNCA reinicia a máquina.
#   - Mantém o login de root por chave (a Coolify gerencia o próprio host via SSH root + chave).
#   - Sem --apply, só mostra o que faria (dry-run). Rode o dry-run primeiro, sempre.
#
# Uso (como root na VPS):
#   bash provision.sh                                   # plano (nada muda)
#   bash provision.sh --apply --pubkey "ssh-ed25519 AAAA... yuri@pc"
#
# Opções:
#   --apply                 aplica as mudanças
#   --user NOME             usuário administrativo sem root (padrão: deploy)
#   --pubkey "CHAVE"        chave pública do operador para esse usuário (sem ela, o usuário não é criado)
#   --close-coolify-ports   bloqueia de fora as portas 8000/8080/6001/6002 (painel/realtime da Coolify
#                           e Traefik); use só se o painel já tem domínio próprio. ⚠️ ver deploy/README.md
#   --install-docker        instala o Docker (repositório oficial) se ele não existir
#   --no-firewall           não mexe no firewall
set -euo pipefail

APPLY=0
ADMIN_USER=deploy
PUBKEY=""
CLOSE_COOLIFY_PORTS=0
INSTALL_DOCKER=0
FIREWALL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --user) ADMIN_USER="$2"; shift ;;
    --pubkey) PUBKEY="$2"; shift ;;
    --close-coolify-ports) CLOSE_COOLIFY_PORTS=1 ;;
    --install-docker) INSTALL_DOCKER=1 ;;
    --no-firewall) FIREWALL=0 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
run() {
  if [[ $APPLY -eq 1 ]]; then
    info "+ $*"
    "$@"
  else
    info "[dry-run] $*"
  fi
}
# Escreve um arquivo só se o conteúdo mudou; mostra o diff.
put_file() {
  local path="$1" mode="$2" content
  content="$(cat)"
  if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$content" ]]; then
    info "inalterado: $path"
    return 1
  fi
  info "alterar: $path"
  if [[ -f "$path" ]]; then
    diff -u "$path" <(printf '%s\n' "$content") | sed 's/^/      /' || true
  else
    printf '%s\n' "$content" | sed 's/^/      + /'
  fi
  if [[ $APPLY -eq 1 ]]; then
    local tmp
    tmp="$(mktemp)"
    printf '%s\n' "$content" > "$tmp"
    install -m "$mode" "$tmp" "$path"
    rm -f "$tmp"
  fi
  return 0
}

# ---------------------------------------------------------------- pré-checagens
say "Pré-checagens"
[[ $EUID -eq 0 ]] || { echo "rode como root" >&2; exit 1; }
. /etc/os-release
info "sistema: $PRETTY_NAME"
[[ "$ID" == "ubuntu" ]] || { echo "script feito para Ubuntu" >&2; exit 1; }
[[ "$VERSION_ID" == "24.04" ]] || info "⚠️  testado em 24.04; você está em $VERSION_ID"
HAS_DOCKER=0; command -v docker >/dev/null && HAS_DOCKER=1
HAS_COOLIFY=0
[[ $HAS_DOCKER -eq 1 ]] && docker ps --format '{{.Names}}' | grep -qx coolify && HAS_COOLIFY=1
EXT_IF="$(ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
info "docker: $([[ $HAS_DOCKER -eq 1 ]] && docker version --format '{{.Server.Version}}' || echo ausente)"
info "coolify: $([[ $HAS_COOLIFY -eq 1 ]] && echo presente || echo ausente)"
info "interface externa: $EXT_IF"
SSH_FROM="${SSH_CLIENT:-}"; SSH_FROM="${SSH_FROM%% *}"
info "sessão SSH atual vinda de: ${SSH_FROM:-(não é SSH)}"
[[ $APPLY -eq 1 ]] && info "MODO: APLICAR" || info "MODO: dry-run (nada será alterado; use --apply)"

# ---------------------------------------------------------------- pacotes
say "Pacotes"
NEED_PKGS=()
for p in ufw unattended-upgrades; do
  dpkg -s "$p" >/dev/null 2>&1 || NEED_PKGS+=("$p")
done
if [[ ${#NEED_PKGS[@]} -gt 0 ]]; then
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -yq "${NEED_PKGS[@]}"
else
  info "ufw e unattended-upgrades já instalados"
fi

# ---------------------------------------------------------------- Docker (opcional)
if [[ $HAS_DOCKER -eq 0 ]]; then
  say "Docker"
  if [[ $INSTALL_DOCKER -eq 1 ]]; then
    run install -m 0755 -d /etc/apt/keyrings
    run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    put_file /etc/apt/sources.list.d/docker.list 0644 <<EOF || true
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF
    run apt-get update -q
    run env DEBIAN_FRONTEND=noninteractive apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    # Rotação de logs só em instalação nova (alterar daemon.json num host existente exige reiniciar o Docker).
    put_file /etc/docker/daemon.json 0644 <<'EOF' || true
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
  else
    info "Docker ausente; rode com --install-docker (ou instale a Coolify, que instala o Docker)"
  fi
fi

# ---------------------------------------------------------------- swap
say "Swap"
if swapon --show --noheadings | grep -q .; then
  info "swap já configurada: $(swapon --show --noheadings | awk '{print $1, $3}' | tr '\n' ' ')"
else
  run fallocate -l 2G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || run sh -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'
fi

# ---------------------------------------------------------------- usuário administrativo
say "Usuário administrativo sem root ($ADMIN_USER)"
if [[ -z "$PUBKEY" ]]; then
  info "sem --pubkey: usuário não será criado/alterado"
else
  [[ "$PUBKEY" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)\  ]] || { echo "--pubkey não parece uma chave pública" >&2; exit 2; }
  if id "$ADMIN_USER" >/dev/null 2>&1; then
    info "usuário já existe"
  else
    run adduser --disabled-password --gecos "" "$ADMIN_USER"
  fi
  run usermod -aG sudo "$ADMIN_USER"
  [[ $HAS_DOCKER -eq 1 ]] && run usermod -aG docker "$ADMIN_USER" \
    && info "obs.: grupo docker equivale a root; o usuário é administrativo, não de aplicação"
  run install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
  AK="/home/$ADMIN_USER/.ssh/authorized_keys"
  if [[ -f "$AK" ]] && grep -qF "$PUBKEY" "$AK"; then
    info "chave já autorizada"
  else
    run sh -c "printf '%s\n' '$PUBKEY' >> '$AK'"
    run chown "$ADMIN_USER:$ADMIN_USER" "$AK"
    run chmod 600 "$AK"
  fi
  # Sem senha (login só por chave) → sudo precisa de NOPASSWD.
  SUDOERS="/etc/sudoers.d/90-$ADMIN_USER"
  if put_file "$SUDOERS" 0440 <<<"$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" && [[ $APPLY -eq 1 ]]; then
    visudo -cf "$SUDOERS" >/dev/null || { rm -f "$SUDOERS"; echo "sudoers inválido; revertido" >&2; exit 1; }
  fi
fi

# ---------------------------------------------------------------- SSH
say "SSH (somente chave)"
# "00-" para vencer drop-ins de cloud-init (no sshd vale a primeira ocorrência).
if put_file /etc/ssh/sshd_config.d/00-bm-hardening.conf 0644 <<'EOF'
# Gerenciado por deploy/provision.sh (bm-platform)
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
# Root só por chave: a Coolify administra o host via SSH root + chave.
PermitRootLogin prohibit-password
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
then
  if [[ $APPLY -eq 1 ]]; then
    if sshd -t; then
      run systemctl reload ssh
    else
      rm -f /etc/ssh/sshd_config.d/00-bm-hardening.conf
      echo "configuração SSH inválida; arquivo removido, nada recarregado" >&2
      exit 1
    fi
  fi
fi
info "efetivo agora: $(sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) ' | tr '\n' ' ')"

# ---------------------------------------------------------------- atualizações automáticas
say "Atualizações automáticas de segurança"
put_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Sem reboot automático: há serviços de produção de terceiros no mesmo host (ex.: Vendra).
# Reinícios para kernel novo são manuais (o script avisa abaixo).
put_file /etc/apt/apt.conf.d/52bm-unattended 0644 <<'EOF' || true
// Gerenciado por deploy/provision.sh (bm-platform)
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
[[ -f /var/run/reboot-required ]] && info "⚠️  há reboot pendente (kernel/libs). Agende uma janela manualmente."

# ---------------------------------------------------------------- firewall
if [[ $FIREWALL -eq 1 ]]; then
  say "Firewall (ufw)"
  info "atenção: portas publicadas pelo Docker NÃO passam pelas regras do ufw;"
  info "elas são filtradas na chain DOCKER-USER (bloco gerenciado em /etc/ufw/after.rules)."
  # A porta 22 é liberada ANTES de ligar o ufw, para não derrubar esta sessão.
  run ufw allow 22/tcp comment 'ssh'
  run ufw allow 80/tcp comment 'http (proxy)'
  run ufw allow 443/tcp comment 'https (proxy)'
  run ufw allow 443/udp comment 'http3 (proxy)'
  run ufw default deny incoming
  run ufw default allow outgoing

  BEGIN='# BEGIN bm-platform DOCKER-USER'
  END='# END bm-platform DOCKER-USER'
  RULES="$BEGIN
*filter
:DOCKER-USER - [0:0]"
  if [[ $CLOSE_COOLIFY_PORTS -eq 1 ]]; then
    # --ctorigdstport casa a porta original do host (antes do DNAT do Docker).
    for port in 8000 8080 6001 6002; do
      RULES+="
-A DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctorigdstport $port --ctdir ORIGINAL -j DROP"
    done
  fi
  RULES+="
-A DOCKER-USER -j RETURN
COMMIT
$END"
  # Mesmo bloco para IPv4 (after.rules) e IPv6 (after6.rules): o Docker publica nas duas pilhas.
  for rules_file in /etc/ufw/after.rules /etc/ufw/after6.rules; do
    [[ -f "$rules_file" ]] || continue
    CURRENT="$(sed -n "/^$BEGIN\$/,/^$END\$/p" "$rules_file")"
    if [[ "$CURRENT" == "$RULES" ]]; then
      info "bloco DOCKER-USER inalterado em $rules_file"
      continue
    fi
    info "bloco DOCKER-USER em $rules_file:"
    printf '%s\n' "$RULES" | sed 's/^/      /'
    if [[ $APPLY -eq 1 ]]; then
      cp "$rules_file" "$rules_file.bak.$(date +%s)"
      sed -i "/^$BEGIN\$/,/^$END\$/d" "$rules_file"
      printf '%s\n' "$RULES" >> "$rules_file"
    fi
  done
  if ufw status | grep -q 'Status: active'; then
    run ufw reload
  else
    run ufw --force enable
  fi
  [[ $CLOSE_COOLIFY_PORTS -eq 0 ]] && \
    info "portas da Coolify (8000/8080/6001/6002) continuam abertas; use --close-coolify-ports para fechar"
fi

# ---------------------------------------------------------------- resumo
say "Resumo"
if [[ $APPLY -eq 1 ]]; then
  ufw status verbose | sed 's/^/   /' || true
  iptables -S DOCKER-USER 2>/dev/null | sed 's/^/   /' || true
  ip6tables -S DOCKER-USER 2>/dev/null | sed 's/^/   /' || true
  info "Teste AGORA, em outro terminal, antes de fechar esta sessão: ssh <usuário>@<host>"
else
  info "Nada foi alterado. Revise o plano acima e rode com --apply."
fi
