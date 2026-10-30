/**
 * Round-trip probes on the 'state' channel (unordered, no retransmits): the host sends a probe stamped with its clock,
 * the guest echoes it the moment it arrives. A lost probe is only a missing sample; unlike a message on the reliable
 * channel (delivered in order: everything behind a lost message waits for its resend) it never waits for a
 * retransmission, so the round trip is the one the race data (inputs, snapshots) takes, queueing on the link
 * included. Types 4 / 5 beside protocol.ts's input (1), snapshot (2) and own state (3).
 */
const PROBE_TYPE = 4;
const ECHO_TYPE = 5;
const BYTES = 1 + 8;

export interface Probe {
  /** false: the host's probe; true: the guest's echo of it */
  echo: boolean;
  /** the host's clock when it sent the probe (ms) */
  at: number;
}

export function encodeProbe(p: Probe): ArrayBuffer {
  const buf = new ArrayBuffer(BYTES);
  const v = new DataView(buf);
  v.setUint8(0, p.echo ? ECHO_TYPE : PROBE_TYPE);
  v.setFloat64(1, p.at);
  return buf;
}

export function decodeProbe(data: unknown): Probe | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== BYTES) return null;
  const v = new DataView(data);
  const type = v.getUint8(0);
  const at = v.getFloat64(1);
  if ((type !== PROBE_TYPE && type !== ECHO_TYPE) || !Number.isFinite(at)) return null;
  return { echo: type === ECHO_TYPE, at };
}
