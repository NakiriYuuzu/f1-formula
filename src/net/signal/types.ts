/**
 * Matchmaking (signalling) client contract: join a room by code, learn whether we host it, and relay opaque WebRTC
 * signalling payloads to other members. Implementations: cloudflare.ts (WebSocket to the Worker in server/) and
 * broadcast.ts (BroadcastChannel: tabs of one browser on one computer — local testing without a server).
 */
export interface SignalWelcome {
  id: string;
  host: boolean;
  hostId: string | null;
  /** members already in the room */
  peers: string[];
}

export interface SignalClient {
  /** resolves once in the room; rejects with a zh-TW message (not found / full / unreachable) */
  connect(): Promise<SignalWelcome>;
  send(to: string, payload: unknown): void;
  onSignal: ((from: string, payload: unknown) => void) | null;
  onPeerJoined: ((id: string) => void) | null;
  onPeerLeft: ((id: string) => void) | null;
  /** the room closed (host left / idle / connection lost) */
  onClosed: ((reason: string) => void) | null;
  close(): void;
}

/** zh-TW text for a room error / close reason. */
export function signalReasonText(reason: string): string {
  switch (reason) {
    case 'full':
      return '房間已滿（最多 4 名玩家）';
    case 'not-found':
      return '找不到這個房間代碼';
    case 'closed':
    case 'host-left':
      return '房主已離開，房間已關閉';
    case 'idle':
      return '房間閒置過久，已關閉';
    case 'unreachable':
      return '無法連線到配對伺服器';
    default:
      return reason || '連線中斷';
  }
}
