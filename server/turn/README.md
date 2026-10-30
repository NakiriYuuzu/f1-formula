# 中繼伺服器（TURN，coturn）

線上多人預設是點對點直連：封包走兩位玩家的網路業者之間的路由。跨國時這條路有時會繞遠路或掉包（連線診斷面板
「網路來回」偏高、「快照遺失」偏多），這時可以讓一方的封包改走自己的雲端主機轉送：玩家 → 雲端主機 → 對方。
雲端業者之間的骨幹通常比家用網路的國際路由穩定，例如台灣的玩家經由馬來西亞的 Oracle Cloud 主機連到馬來西亞
的房主。

中繼伺服器只轉送封包，不跑遊戲；配對伺服器（Cloudflare Worker）用共用密鑰發 24 小時有效的臨時通行證
（`GET /turn`，`server/src/turn.ts`），密鑰本身不會出現在遊戲裡。注意：能打開遊戲網頁的人就拿得到通行證
（來源檢查只擋其他網站，擋不住腳本），所以中繼本身只做遊戲需要的事：只轉送 UDP、只轉送到網際網路上的位址、
每個連線限速、每張通行證與全部的同時配額都有上限。這擋不住有人大量索取通行證把中繼暫時占滿（那時選「經由
中繼伺服器」的玩家連不上，直連不受影響），但沒辦法把主機當成一般的代理伺服器使用。

## 1. 在雲端主機安裝 coturn

需求：一台有公開 IP 的 Linux 主機（Oracle Cloud 的 Ubuntu 22.04 / 24.04 或 Oracle Linux 8 / 9 都可以；其他用
apt 或 dnf 的系統也行）。流量很小：每位經由中繼的玩家約 50 KB/s 下載、5 KB/s 上傳。

```sh
scp server/turn/install-coturn.sh ubuntu@<主機公開IP>:
ssh ubuntu@<主機公開IP> 'sudo bash install-coturn.sh'
```

（Oracle Linux 的預設帳號是 `opc`。）腳本會：

- 安裝並啟用 coturn，寫入 `/etc/turnserver.conf`（Oracle Linux：`/etc/coturn/turnserver.conf`；原檔備份為 `.orig`）：
  只接受配對伺服器發的通行證（`use-auth-secret`）、監聽 3478（UDP + TCP）、中繼埠 UDP 49160–49359、
  不開 TCP 中繼（`no-tcp-relay`）、不轉送到私有網段與本機、每個連線每個方向最多 192 KB/s（比賽約 50 KB/s）、
  同時配額（每張通行證 24、全部 100）、日誌寫到 journald；
- 打開主機本身的防火牆（Oracle 的 Ubuntu 映像檔預設只開 SSH）：當下加入規則，並寫進開機時載入的
  `/etc/iptables/rules.v4`（插在最後的 REJECT 之前；不會用 `netfilter-persistent save`，那會把 Docker／k3s／
  Tailscale 執行時加的規則也凍結進開機設定）；
- 最後印出要設定的 `TURN_URLS` 與 `TURN_SECRET`。

公開 IP 自動偵測；偵測不到或要指定時：`sudo PUBLIC_IP=<公開IP> bash install-coturn.sh`。重跑腳本會沿用設定檔裡
已有的密鑰；要換新密鑰就 `sudo TURN_SECRET=$(openssl rand -hex 32) bash install-coturn.sh`，再更新 Worker 的
secret。

## 2. 雲端防火牆

Oracle Cloud 主控台 → Networking → Virtual cloud networks → 主機所在的 VCN → Security Lists（或主機使用的
Network Security Group），新增 Ingress 規則，來源 `0.0.0.0/0`：

| 協定 | 目的埠 |
|---|---|
| UDP | 3478 |
| TCP | 3478 |
| UDP | 49160-49359 |

其他雲端（AWS Security Group、GCP firewall rule 等）開同樣的埠。

## 3. 配對伺服器

在 `server/`：

```sh
# wrangler.toml 的 [vars]：
#   TURN_URLS = "turn:<公開IP>:3478?transport=udp,turn:<公開IP>:3478?transport=tcp"
bunx wrangler secret put TURN_SECRET     # 貼上腳本印出的密鑰（與 coturn 的 static-auth-secret 相同）
bunx wrangler deploy
```

確認：`curl -H 'Origin: https://github.yuuzu.net' https://<Worker 網址>/turn` 應回傳含 `iceServers` 的 JSON
（沒設定好時是 `{"iceServers":[],"ttl":0}`）。

## 4. 遊戲內

主選單 → 線上多人 → **連線路徑**：

- **自動（直連優先）**：先試點對點直連；直連不通時（嚴格 NAT）才自動改走中繼。
- **經由中繼伺服器**：這一方的所有封包都走中繼。

只需要**連線較差的那一方**（例如台灣的訪客）選「經由中繼伺服器」，房主維持「自動」：封包路線是
訪客 → 中繼 → 房主。兩邊都選中繼會連不上：中繼不轉送回主機自己的公開 IP（免得被當成跳板，連到主機上其他
只對雲端防火牆內開放的服務）。

比賽中按 F3（或暫停選單的「連線診斷」）：「路徑」顯示「經由中繼伺服器」就是走中繼了。比較兩種設定下的
「網路來回」與「快照遺失」，選表現好的那一種。

## 疑難排解

- 選中繼後連不上：多半是雲端防火牆（第 2 步）沒開，或 `TURN_URLS` 的 IP 不對。
- 主機上：`systemctl status coturn`、`journalctl -u coturn -f`（連線時會看到 `session ... new` 與 `allocation`）、
  `sudo ss -ulpn | grep 3478`。
- 用瀏覽器測 TURN：把 `/turn` 回傳的 `urls`、`username`、`credential` 填進 WebRTC 官方範例
  「Trickle ICE」頁面，按 Gather candidates，出現 `relay` 類型的 candidate 就表示中繼正常。
- 通行證在建立／加入房間時取得，有效 24 小時。
