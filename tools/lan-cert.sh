#!/usr/bin/env bash
# HTTPS for `bun run dev:lan:https`: tilt steering reads the motion sensor, which a phone only allows in a secure
# context. Creates a local CA once, then signs a certificate for this machine's LAN addresses, <hostname>.local and
# localhost. Uses only openssl (LibreSSL on macOS). Everything goes into the git-ignored .cert/.
# The player fully trusts the CA on a phone, so it carries a critical name constraint: it can vouch only for
# localhost, .local names and private or link-local IPv4 addresses, never for a public site even if its key leaks.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=.cert
mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

HOST=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
IPS=$( (ifconfig 2>/dev/null || true) | awk '/inet / && $2 != "127.0.0.1" { sub("addr:", "", $2); print $2 }')
if [[ -z "$IPS" ]] && command -v hostname >/dev/null; then IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true); fi

# keep in step with nameConstraints below: a leaf name outside these would not verify against the CA
permitted_ip() {
  local a b rest
  IFS=. read -r a b rest <<<"$1"
  ((a == 10 || a == 127)) || ((a == 172 && b >= 16 && b <= 31)) || ((a == 192 && b == 168)) ||
    ((a == 169 && b == 254)) || ((a == 100 && b >= 64 && b <= 127))
}

if [[ -f "$DIR/ca.crt" ]]; then
  CA_TEXT=$(openssl x509 -in "$DIR/ca.crt" -noout -text)
  if [[ "$CA_TEXT" != *"X509v3 Name Constraints: critical"* ]]; then
    rm -f "$DIR/ca.key" "$DIR/ca.crt" "$DIR/ca.srl"
    echo "舊的本機 CA 沒有名稱限制，已刪除並重建：請在裝置上移除舊的「FORMULA NOVA LAN dev CA」描述檔，再依下方步驟信任新的 CA"
  fi
fi

if [[ ! -f "$DIR/ca.key" || ! -f "$DIR/ca.crt" ]]; then
  # DNS:local is RFC 5280's form for "local and every name under it"
  cat >"$TMP/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = FORMULA NOVA LAN dev CA
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:localhost, permitted;DNS:local, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:169.254.0.0/255.255.0.0, permitted;IP:100.64.0.0/255.192.0.0, permitted;IP:127.0.0.0/255.0.0.0
EOF
  openssl genrsa -out "$DIR/ca.key" 2048 2>/dev/null
  openssl req -x509 -new -sha256 -days 3650 -key "$DIR/ca.key" -out "$DIR/ca.crt" -config "$TMP/ca.cnf" -extensions ca
  echo "新的本機 CA：$DIR/ca.crt（每台裝置只需信任一次）"
fi

SAN="DNS:$HOST.local, DNS:localhost, IP:127.0.0.1"
FIRST_IP=""
for ip in $IPS; do
  if permitted_ip "$ip"; then
    SAN="$SAN, IP:$ip"
    FIRST_IP=${FIRST_IP:-$ip}
  else
    echo "略過 $ip：不在本機 CA 允許的私有網段內"
  fi
done

# 397 days: Apple refuses longer-lived server certificates
cat >"$TMP/leaf.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $HOST.local
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN
authorityKeyIdentifier = keyid
EOF
openssl genrsa -out "$DIR/lan.key" 2048 2>/dev/null
openssl req -new -sha256 -key "$DIR/lan.key" -out "$TMP/lan.csr" -config "$TMP/leaf.cnf"
openssl x509 -req -sha256 -days 397 -in "$TMP/lan.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
  -CAserial "$DIR/ca.srl" -CAcreateserial -out "$DIR/lan.crt" -extfile "$TMP/leaf.cnf" -extensions leaf 2>/dev/null
chmod 600 "$DIR/ca.key" "$DIR/lan.key"

cat <<EOF

已寫入 $DIR/lan.crt 與 $DIR/lan.key（涵蓋：${SAN}）
啟動：bun run dev:lan:https，手機開 https://${FIRST_IP:-<這台電腦的 IP>}:5173 或 https://$HOST.local:5173

iPhone / iPad：
  1. 用 AirDrop 把 $DIR/ca.crt 傳到裝置，開啟後依提示下載描述檔
  2. 設定 → 一般 → VPN 與裝置管理 → 安裝描述檔
  3. 設定 → 一般 → 關於本機 → 憑證信任設定 → 對「FORMULA NOVA LAN dev CA」開啟完全信任

Android（不需要憑證）：
  USB 連線並開啟 USB 偵錯，執行 adb reverse tcp:5173 tcp:5173，
  然後執行 bun run dev，手機開 http://localhost:5173（localhost 本身就是安全連線）

電腦的 IP 變了就重跑本腳本；CA 會保留，裝置不必重新信任。
EOF
