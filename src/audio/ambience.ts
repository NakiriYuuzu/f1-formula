/**
 * Listener-car ambience beds (both human cars in split-screen): wind (∝ speed²), rain + tyre spray, kerb buzz and grass/gravel rumble.
 * One shared looping noise source feeds every noise bed; levels are driven by gain glides only (no per-frame nodes).
 */
import { glide, releaseNodes, safeFreq, startNoise, type SharedAudio } from './context';
import { ambienceLayers, mergeAmbienceLayers, type AmbienceSource } from './mix';

export interface AmbienceParams extends AmbienceSource {
  /** 0..1 rain intensity */
  rain: number;
  /** 0..1 water on track */
  wetness: number;
}

const TAU = 0.06;

export class ListenerAmbience {
  private readonly shared: SharedAudio;
  private readonly windFilter: BiquadFilterNode;
  private readonly windGain: GainNode;
  private readonly rainGain: GainNode;
  private readonly offroadFilter: BiquadFilterNode;
  private readonly offroadGain: GainNode;
  private readonly rumbleOsc: OscillatorNode;
  private readonly rumbleGain: GainNode;
  private readonly nodes: AudioNode[];

  constructor(shared: SharedAudio, out: AudioNode) {
    this.shared = shared;
    const ctx = shared.ctx;
    const noise = startNoise(shared);
    const filter = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const silent = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };

    this.windFilter = filter('lowpass', 400, 0.6);
    const windBody = filter('peaking', 180, 0.8);
    windBody.gain.value = 5;
    this.windGain = silent();
    noise.connect(this.windFilter).connect(windBody).connect(this.windGain).connect(out);

    const rainHp = filter('highpass', 900, 0.5);
    const rainLp = filter('lowpass', 7500, 0.5);
    this.rainGain = silent();
    noise.connect(rainHp).connect(rainLp).connect(this.rainGain).connect(out);

    this.offroadFilter = filter('lowpass', 400, 0.9);
    this.offroadGain = silent();
    noise.connect(this.offroadFilter).connect(this.offroadGain).connect(out);

    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'square';
    this.rumbleOsc.frequency.value = 40;
    const rumbleLp = filter('lowpass', 240, 1.2);
    this.rumbleGain = silent();
    this.rumbleOsc.connect(rumbleLp).connect(this.rumbleGain).connect(out);
    this.rumbleOsc.start();

    this.nodes = [
      noise,
      this.windFilter,
      windBody,
      this.windGain,
      rainHp,
      rainLp,
      this.rainGain,
      this.offroadFilter,
      this.offroadGain,
      this.rumbleOsc,
      rumbleLp,
      this.rumbleGain,
    ];
  }

  /** `extra` = the second human car in split-screen (beds follow the louder of the two cars). */
  update(p: AmbienceParams, now: number, extra?: AmbienceSource): void {
    const ny = this.shared.nyquist;
    let layers = ambienceLayers(p, p.rain, p.wetness);
    if (extra) layers = mergeAmbienceLayers(layers, ambienceLayers(extra, p.rain, p.wetness));

    // Wind: rises with speed², brighter at speed; louder on board (helmet), absent from trackside cameras.
    glide(this.windFilter.frequency, safeFreq(250 + layers.windSpeed * 20, ny, 80), now, TAU);
    glide(this.windGain.gain, layers.wind, now, TAU);
    // Rain bed (environmental, not attenuated) + spray hiss on a wet track.
    glide(this.rainGain.gain, layers.rain, now, 0.2);
    // Surface: kerb buzz (stripe rate ∝ speed), gravel crunch / grass swish + low rumble.
    glide(this.rumbleOsc.frequency, safeFreq(layers.rumbleHz, ny, 8), now, 0.04);
    glide(this.rumbleGain.gain, layers.rumble, now, 0.03);
    glide(this.offroadFilter.frequency, safeFreq(layers.offroadHz, ny, 80), now, 0.05);
    glide(this.offroadGain.gain, layers.offroad, now, 0.04);
  }

  dispose(): void {
    releaseNodes(this.nodes);
  }
}
