/** Pure helpers of the safety car model (wheel roll direction, roof light bar flashing, lamp levels). */

/** Roof light bar flash rate (Hz): the two amber pods alternate, each one flashes at this rate. */
export const SC_FLASH_HZ = 2;
/** Colour gain of a lit amber pod / head + tail lamps (lamp material) (post bloom thresholds: night 1.0, dusk 1.1, day 1.6). */
export const SC_POD_ON = 1.6;
export const SC_HEAD_GAIN = 1.5;
export const SC_CENTRE_ON = 1.4;
/** Colour factor of an unlit pod lens (barely visible amber glass). */
export const SC_POD_OFF = 0.07;

/**
 * Wheel spin about the axle (local X). The car convention is rotation.x = +wheelSpin, which rolls the wheel forward
 * for a +Z facing car (the top of the tyre moves towards +Z). Wrapped to ±2π to keep float precision.
 */
export function wheelSpinAngle(spin: number): number {
  return Number.isFinite(spin) ? spin % (Math.PI * 2) : 0;
}

/** Which pod is lit: 0 = left (+X), 1 = right (-X); null when the light bar is off. Pure in `time` (replays). */
export function lightBarPhase(time: number, lightsOn: boolean, hz = SC_FLASH_HZ): 0 | 1 | null {
  if (!lightsOn || !Number.isFinite(time)) return null;
  const f = (((time * hz) % 1) + 1) % 1;
  return f < 0.5 ? 0 : 1;
}
