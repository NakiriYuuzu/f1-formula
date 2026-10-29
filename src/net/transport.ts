/**
 * Network transport contract of the online mode (docs/plans/phase3-online.md §2). Two channels per peer link:
 * - 'state': unordered, unreliable (WebRTC data channel `ordered: false, maxRetransmits: 0`) — inputs and snapshots;
 * - 'reliable': ordered and reliable — lobby, session start, events, commands, HUD mirror, results.
 * WebRTC (peer.ts) and the in-memory loopback (loopback.ts, tests) implement it; everything above is pure logic.
 */
export type NetChannel = 'state' | 'reliable';

export type NetPayload = ArrayBuffer | string;

export interface NetTransport {
  /** false once closed (locally or by the other side) */
  readonly open: boolean;
  send(channel: NetChannel, data: NetPayload): void;
  /**
   * Bytes sent on `channel` that have not left yet (WebRTC `bufferedAmount`): what is queued behind a congested link.
   * Real-time state is sent only while this stays small, so it never waits behind stale state.
   */
  buffered(channel: NetChannel): number;
  onMessage: ((channel: NetChannel, data: NetPayload) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}
