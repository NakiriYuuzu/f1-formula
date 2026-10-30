#!/usr/bin/env bash
# FORMULA NOVA 25 — TURN relay (coturn) on a cloud VM (Oracle Cloud Ubuntu / Oracle Linux; other apt / dnf systems too).
# Run as root:  sudo bash install-coturn.sh            (rerunning keeps the secret already in the config)
# Optional:     TURN_SECRET=... PUBLIC_IP=... sudo -E bash install-coturn.sh
# Afterwards: open the ports in the cloud firewall (Oracle: the VCN security list) and give the matchmaking Worker
# the secret and the URLs (printed at the end; server/turn/README.md).
set -euo pipefail

PORT=3478
MIN_PORT=49160
MAX_PORT=49359
REALM=formula-nova

[ "$(id -u)" -eq 0 ] || { echo "請用 root 執行：sudo bash $0" >&2; exit 1; }

# ── install ──────────────────────────────────────────────────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y coturn curl openssl
  CONF=/etc/turnserver.conf
  # Debian / Ubuntu ship the service disabled
  [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
elif command -v dnf >/dev/null 2>&1; then
  if ! dnf -q list coturn >/dev/null 2>&1; then
    # Oracle Linux: coturn is in EPEL
    major=$(rpm -E %rhel)
    dnf install -y "oracle-epel-release-el${major}" || dnf install -y epel-release
  fi
  dnf install -y coturn curl openssl
  CONF=/etc/coturn/turnserver.conf
  mkdir -p /etc/coturn
else
  echo "找不到 apt-get 或 dnf，請手動安裝 coturn" >&2
  exit 1
fi

# ── addresses: the VM's private address and the public one it is reached at (1:1 NAT on Oracle Cloud) ──────────────
PRIVATE_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n1)
PUBLIC_IP=${PUBLIC_IP:-$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)}
[ -n "$PRIVATE_IP" ] && [ -n "$PUBLIC_IP" ] || { echo "無法取得 IP（PRIVATE=$PRIVATE_IP PUBLIC=$PUBLIC_IP）；可用 PUBLIC_IP=... 指定" >&2; exit 1; }

# ── secret shared with the Worker: given, else the one already configured, else a new one ──────────────────────────
if [ -z "${TURN_SECRET:-}" ] && [ -f "$CONF" ]; then
  TURN_SECRET=$(sed -n 's/^static-auth-secret=//p' "$CONF" | head -n1)
fi
TURN_SECRET=${TURN_SECRET:-$(openssl rand -hex 32)}

[ -f "$CONF" ] && [ ! -f "$CONF.orig" ] && cp "$CONF" "$CONF.orig"
cat >"$CONF" <<EOF
# FORMULA NOVA 25 TURN relay (written by install-coturn.sh)
listening-port=$PORT
listening-ip=$PRIVATE_IP
relay-ip=$PRIVATE_IP
# the one relay address's public face (not "public/private": coturn would then whitelist the private address as a
# peer, ahead of every denied range, and map this public address to it — the relay could reach this server itself)
external-ip=$PUBLIC_IP
min-port=$MIN_PORT
max-port=$MAX_PORT
realm=$REALM
# short-lived credentials from the matchmaking Worker (server/src/turn.ts): HMAC-SHA1 with this secret. Anyone who
# can load the game can get one, so the relay does only what the game needs:
use-auth-secret
static-auth-secret=$TURN_SECRET
fingerprint
no-tls
no-dtls
no-cli
# UDP relays only (browsers never ask for TCP ones): no TCP connections out of this server to anywhere
no-tcp-relay
# players on the internet only: never into private / local networks (loopback is refused by default)
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# nor back to this server's own public address (its other services stay behind the cloud firewall); so two players
# both on the relay cannot reach each other: only one side picks it
denied-peer-ip=$PUBLIC_IP
# a race needs about 50 KB/s each way per player: at most 192 KB/s a session (each direction); allocations per
# credential (each has its own tag, the part of the username coturn counts by) and in all (≤ the 200 relay ports)
max-bps=196608
user-quota=24
total-quota=100
stale-nonce=600
# log to the journal (once: not also to stdout, which the service sends there too): journalctl -u coturn
syslog
no-stdout-log
EOF
# readable by the service only (it runs as its own user: turnserver on Debian / Ubuntu, coturn on Oracle Linux)
chmod 640 "$CONF"
for group in "$(systemctl show -p Group --value coturn 2>/dev/null || true)" turnserver coturn; do
  if [ -n "$group" ] && getent group "$group" >/dev/null; then
    chgrp "$group" "$CONF"
    break
  fi
done

# ── OS firewall (Oracle's Ubuntu images reject everything but SSH in iptables; Oracle Linux uses firewalld) ────────
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=$PORT/udp --add-port=$PORT/tcp --add-port=$MIN_PORT-$MAX_PORT/udp
  firewall-cmd --reload
elif command -v iptables >/dev/null 2>&1; then
  rules=("-p udp -m udp --dport $PORT" "-p tcp -m tcp --dport $PORT" "-p udp -m udp --dport $MIN_PORT:$MAX_PORT")
  for rule in "${rules[@]}"; do
    # shellcheck disable=SC2086
    iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 1 $rule -j ACCEPT
  done
  # across reboots: into the saved base rules, before their final REJECT. Never `netfilter-persistent save`: it would
  # also freeze the rules Docker / k3s / Tailscale add at run time into the boot rules.
  saved=/etc/iptables/rules.v4
  if [ -f "$saved" ] && grep -q '^-A INPUT -j REJECT' "$saved"; then
    for rule in "${rules[@]}"; do
      line="-A INPUT $rule -j ACCEPT"
      grep -qxF -- "$line" "$saved" || sed -i "0,/^-A INPUT -j REJECT/s//$line\n&/" "$saved"
    done
  else
    echo "注意：找不到 $saved 裡的 REJECT 規則，防火牆設定只在這次開機有效，請自行保存" >&2
  fi
fi

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn || { echo "coturn 沒有啟動，請看 journalctl -u coturn" >&2; exit 1; }

cat <<EOF

coturn 已啟動（$PUBLIC_IP:$PORT，中繼埠 UDP $MIN_PORT–$MAX_PORT）。

1) 雲端防火牆（Oracle Cloud：Networking → Virtual cloud networks → 你的 VCN → Security Lists，或執行個體的 NSG）
   新增 Ingress 規則，來源 0.0.0.0/0：
     UDP $PORT、TCP $PORT、UDP $MIN_PORT-$MAX_PORT

2) 配對伺服器（Cloudflare Worker，在專案的 server/ 目錄）：
     wrangler.toml 的 TURN_URLS = "turn:$PUBLIC_IP:$PORT?transport=udp,turn:$PUBLIC_IP:$PORT?transport=tcp"
     bunx wrangler secret put TURN_SECRET     （貼上下面這串）
     bunx wrangler deploy

   TURN_SECRET=$TURN_SECRET
   （請保密：有它就能產生中繼的通行證）
EOF
