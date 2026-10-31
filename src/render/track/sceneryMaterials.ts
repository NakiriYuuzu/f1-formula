/**
 * Shader patches (onBeforeCompile) for scenery materials:
 * - backdrop fog: the scene fog capped below 1 so far hills / mountains stay readable silhouettes beyond the fog
 *   distance (the cap lifts back to 1 when fog closes in for rain), and emissive windows shine through the haze;
 * - window fade: facade / window maps blend to their mip-chain average with distance, so far skylines do not shimmer
 *   (moiré) and read as a lit mass;
 * - tint mask: instance colour applied only where the per-vertex `tintMask` attribute is 1 (shirts, tree crowns),
 *   optional per-instance skin tones (crowd heads) from gl_InstanceID;
 * - foliage (tint mask + napali canopy lighting): wrapped diffuse that darkens faster than Lambert toward the
 *   terminator, warm light through the leaves when they are seen against the sun, and a gentle wind sway of the crowns
 *   (FOLIAGE_TIME, advanced by the race scene);
 * - ground: two-scale greyscale detail noise, mowing stripes along the track and a shoreline tint for the terrain
 *   (per-vertex `groundData` = mow weight, stripe coordinate s, shore weight), detail noise only for verges. The terrain
 *   also gets napali-style procedural variation that never repeats: the tiled colour map fades to its mean with
 *   distance, world-scale tone and dry patches (two very low-frequency detail samples) take over, and steep slopes show
 *   bare soil / rock; on water biomes the waterline gets a swashing wet-sand band and foam (surf);
 * - backdrop land: napali-style eroded gullies, bare banded rock on steep faces and canopy mottle on the far hills;
 * - sea: layered wave normals (swell / ripple), roughness rising with distance, turquoise light through the wave flanks.
 * Every patch sets a distinct customProgramCacheKey so programs are shared only between identical variants.
 */
import * as THREE from 'three';

/** Scene fog is capped at this factor on backdrop surfaces while the fog is thin (clear / dusk / night). */
export const BACKDROP_FOG_CAP = 0.82;
/** Fog far distances (m) over which the cap fades back to 1 (thick rain fog hides the backdrop completely). */
export const BACKDROP_FOG_THICK_FAR = 900;
export const BACKDROP_FOG_THIN_FAR = 2000;
/** Share of a backdrop emissive (lit windows) that survives the fog on top of the fogged colour. */
export const BACKDROP_GLOW_THROUGH_FOG = 0.5;

/** Ground detail texture tiling (repeats per 24 m ground-map tile): fine ≈ 2.4 m, medium ≈ 9.6 m. */
export const GROUND_DETAIL_FINE = 10;
export const GROUND_DETAIL_MID = 2.5;
/** Detail noise strength (0 = off) of the fine / medium layers. */
export const GROUND_DETAIL_FINE_AMOUNT = 0.5;
export const GROUND_DETAIL_MID_AMOUNT = 0.36;
/** Mowing stripes: period (m along the track, two bands) and brightness contrast (± fraction). */
export const GROUND_MOW_PERIOD = 6;
export const GROUND_MOW_CONTRAST = 0.085;
/** View distance (m) over which the tiled terrain colour map fades to its mean colour (hides the 24 m repeat). */
export const GROUND_FAR_FADE: readonly [number, number] = [70, 420];
/** Share of the tiled map's own variation that is left far away. */
export const GROUND_FAR_KEEP = 0.3;
/** Share of the two detail-noise layers removed far away (they tile every 2.4 / 9.6 m). */
export const GROUND_DETAIL_FAR_CUT = 0.8;
/** World-scale tone variation: noise frequencies (per 24 m map tile ≈ 530 m and 140 m features) and ± brightness. */
export const GROUND_WORLD_FREQ: readonly [number, number] = [0.045, 0.17];
export const GROUND_WORLD_TONE = 0.17;
/** Slope (1 − normal.y) where bare soil / rock starts and where it has taken over. */
export const GROUND_ROCK_SLOPE: readonly [number, number] = [0.2, 0.42];

/** Surf on water biomes: swash amplitudes (m, slow and quick swell), wet-sand band height (m above the waterline) and
 * its darkening, foam band half-width (m of height). */
export const SURF_SWASH: readonly [number, number] = [0.22, 0.08];
export const SURF_WET_HEIGHT = 0.8;
export const SURF_WET_DARKEN = 0.62;
export const SURF_FOAM_WIDTH = 0.16;

/** Sea surface: uv multipliers of the swell (≈ 180 m) and ripple (≈ 13 m) layers of the wave normal map, roughness far
 * away (the small waves average out and the sun glitter spreads) and how much the wave flanks facing the viewer turn
 * turquoise. */
export const SEA_SWELL_SCALE = 0.19;
export const SEA_RIPPLE_SCALE = 2.7;
export const SEA_FAR_ROUGHNESS = 0.2;
export const SEA_FLANK = 0.55;

/** Crowd skin tones (linear-ish sRGB picks, blended per instance). */
const SKIN_TONES = ['#f1c7a5', '#d9a47c', '#a8714d', '#6e4630'];

function glslFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

function glslColor(hex: string): string {
  const c = new THREE.Color(hex);
  return `vec3(${glslFloat(+c.r.toFixed(4))}, ${glslFloat(+c.g.toFixed(4))}, ${glslFloat(+c.b.toFixed(4))})`;
}

/**
 * Capped backdrop fog. `glow` keeps BACKDROP_GLOW_THROUGH_FOG of the emissive radiance through the fog (only for
 * lit materials that declare totalEmissiveRadiance: Lambert / Phong / Standard).
 */
export function patchBackdropFog(material: THREE.Material, cap: number, glow: boolean): void {
  const capUniform = { value: cap };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.bdFogCap = capUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nuniform float bdFogCap;')
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
  float bdCap = mix(1.0, bdFogCap, smoothstep(${glslFloat(BACKDROP_FOG_THICK_FAR)}, ${glslFloat(BACKDROP_FOG_THIN_FAR)}, fogFar));
  float bdFog = min(smoothstep(fogNear, fogFar, vFogDepth), bdCap);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, bdFog);
  ${glow ? `gl_FragColor.rgb += totalEmissiveRadiance * bdFog * ${glslFloat(BACKDROP_GLOW_THROUGH_FOG)};` : ''}
#endif`,
      );
  };
  material.customProgramCacheKey = () => `nova-backdrop-fog-${glow ? 1 : 0}`;
}

/** Backdrop land relief: spacing (m) of the widest gullies across a slope and their relief depth (m). */
export const BACKDROP_GULLY_WAVELENGTH = 95;
export const BACKDROP_GULLY_DEPTH = 62;
/** Along-slope frequency of the gully field relative to across (< 1: long flutes running down the slopes). */
export const BACKDROP_GULLY_STRETCH = 0.3;
/** Amplitude ratio between gully octaves (the slope each octave adds shrinks by this × 2.03). */
export const BACKDROP_GULLY_GAIN = 0.47;
/** Sideways meander of the gullies down the slope (octave-0 cells). */
export const BACKDROP_GULLY_MEANDER = 0.9;
/** Radius (m) of the circle the across-slope coordinate is measured on (≈ distance of the ridges from the centre). */
export const BACKDROP_GULLY_RING = 2800;
/** Slope (1 − relief normal.y) where bare rock starts and where it has taken over the vegetation. */
export const BACKDROP_ROCK_SLOPE: readonly [number, number] = [0.42, 0.78];
/** Brightness of the gully floors (cavity darkening), canopy mottle (± fraction) and rock strata (± fraction). */
export const BACKDROP_CAVITY = 0.62;
export const BACKDROP_CANOPY_TONE = 0.1;
export const BACKDROP_STRATA = 0.07;

export interface BackdropLandOptions {
  /** bare rock colour (already scaled by the time-of-day albedo) */
  rock: THREE.Color;
  /** ring centre (x, z) the gullies run away from */
  centre: readonly [number, number];
  /** gully octaves (1–5) */
  octaves: number;
}

/**
 * Napali-style relief on the backdrop land (chains behind patchBackdropFog): a ridged noise field of long flutes that
 * run down the slopes and meander sideways tilts the normal (knife-edge ridges between rounded gullies, analytic
 * gradient: no screen-space derivative artefacts), darkens the gully floors, turns steep faces to bare banded rock and mottles the vegetation like
 * a distant canopy. Octaves fade out as they shrink below a few pixels. The per-vertex `uv.x` (0..1) is how rugged the
 * surface is: 1 for mountains, less for rolling hills, 0 for dunes / flat shelves (unchanged).
 */
export function patchBackdropLand(material: THREE.Material, opts: BackdropLandOptions): void {
  const prev = material.onBeforeCompile;
  const rockUniform = { value: opts.rock.clone() };
  const centreUniform = { value: new THREE.Vector2(opts.centre[0], opts.centre[1]) };
  const octaves = Math.max(1, Math.min(5, Math.round(opts.octaves)));
  const wave = BACKDROP_GULLY_WAVELENGTH;
  const ringK = glslFloat(+(BACKDROP_GULLY_RING / wave).toFixed(6));
  const slopeK = glslFloat(+(BACKDROP_GULLY_STRETCH / wave).toFixed(6));
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.bdRock = rockUniform;
    shader.uniforms.bdCentre = centreUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBdPos;\nvarying float vBdRugged;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvBdPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvBdRugged = uv.x;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 bdRock;
uniform vec2 bdCentre;
varying vec3 vBdPos;
varying float vBdRugged;
float bdHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
// value noise (x) and its gradient (yzw)
vec4 bdNoiseD( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  vec3 u = f * f * ( 3.0 - 2.0 * f );
  vec3 du = 6.0 * f * ( 1.0 - f );
  float a = bdHash( i );
  float b = bdHash( i + vec3( 1.0, 0.0, 0.0 ) );
  float c = bdHash( i + vec3( 0.0, 1.0, 0.0 ) );
  float d = bdHash( i + vec3( 1.0, 1.0, 0.0 ) );
  float e = bdHash( i + vec3( 0.0, 0.0, 1.0 ) );
  float g = bdHash( i + vec3( 1.0, 0.0, 1.0 ) );
  float h = bdHash( i + vec3( 0.0, 1.0, 1.0 ) );
  float k = bdHash( i + vec3( 1.0 ) );
  float k1 = b - a;
  float k2 = c - a;
  float k3 = e - a;
  float k4 = a - b - c + d;
  float k5 = a - c - e + h;
  float k6 = a - b - e + g;
  float k7 = - a + b + c - d + e - g - h + k;
  return vec4(
    a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3( k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y ) );
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // gully field: across-slope coordinate on a fixed circle round the centre, along-slope from height and radius
  vec2 bdD = vBdPos.xz - bdCentre;
  float bdR = max( length( bdD ), 1.0 );
  vec2 bdDir = bdD / bdR;
  vec3 bdQ = vec3( bdDir * ${ringK}, ( vBdPos.y + bdR * 0.3 ) * ${slopeK} );
  // meander: shift the across coordinate along the ring as the slope coordinate changes (warp gradient ignored)
  bdQ.xy += vec2( - bdDir.y, bdDir.x ) * ( ( bdNoiseD( vec3( bdQ.xy * 0.3, bdQ.z * 1.7 ) + 7.1 ).x - 0.5 ) * ${glslFloat(BACKDROP_GULLY_MEANDER * 2)} );
  // pixel footprint in octave-0 cells (computed everywhere: derivatives need uniform control flow)
  float bdFp = length( fwidth( vBdPos ) ) * ${glslFloat(+(1 / wave).toFixed(6))};
  float bdH = 0.0;
  vec3 bdG = vec3( 0.0 );
  float bdA = 0.5;
  float bdF = 1.0;
  vec3 bdQi = bdQ;
  for ( int i = 0; i < ${octaves}; i ++ ) {
    vec4 bdN4 = bdNoiseD( bdQi );
    float bdS = bdN4.x * 2.0 - 1.0;
    float bdRidge = 1.0 - abs( bdS );
    float bdW = bdA * ( 1.0 - smoothstep( 0.12, 0.4, bdFp * bdF ) );
    bdH += bdW * bdRidge * bdRidge;
    bdG -= bdW * 4.0 * bdRidge * sign( bdS ) * bdN4.yzw * bdF;
    bdQi = bdQi * 2.03 + vec3( 1.7, 9.2, 3.1 );
    bdF *= 2.03;
    bdA *= ${glslFloat(BACKDROP_GULLY_GAIN)};
  }
  float bdK = clamp( vBdRugged, 0.0, 1.0 );
  // world gradient (m / m) of the relief through the ring mapping, then tilt the world normal by it
  vec2 bdT = ( bdG.xy - bdDir * dot( bdDir, bdG.xy ) ) * ( ${ringK} / bdR );
  vec3 bdGw = ( vec3( bdT.x, 0.0, bdT.y ) + bdG.z * ${slopeK} * vec3( 0.3 * bdDir.x, 1.0, 0.3 * bdDir.y ) ) * ( bdK * ${glslFloat(BACKDROP_GULLY_DEPTH)} );
  vec3 bdN = inverseTransformDirection( normal, viewMatrix );
  bdN = normalize( bdN - ( bdGw - dot( bdGw, bdN ) * bdN ) );
  normal = normalize( ( viewMatrix * vec4( bdN, 0.0 ) ).xyz );
  // bare rock on steep faces, banded; gully floors darker; vegetation mottled like a canopy
  float bdBreak = bdNoiseD( bdQ * vec3( 3.1, 3.1, 7.0 ) + 4.7 ).x;
  float bdRockMix = smoothstep( ${glslFloat(BACKDROP_ROCK_SLOPE[0])}, ${glslFloat(BACKDROP_ROCK_SLOPE[1])}, 1.0 - bdN.y + ( bdBreak - 0.5 ) * 0.22 ) * bdK;
  float bdStrata = 1.0 + ${glslFloat(BACKDROP_STRATA)} * sin( vBdPos.y * 0.11 + bdBreak * 2.6 ) + ${glslFloat(BACKDROP_STRATA)} * ( bdBreak - 0.5 );
  float bdCanopy = 1.0 + ${glslFloat(BACKDROP_CANOPY_TONE * 2)} * ( bdNoiseD( bdQ * vec3( 9.0, 9.0, 30.0 ) ).x - 0.5 ) * ( 1.0 - smoothstep( 0.05, 0.3, bdFp * 9.0 ) );
  float bdCav = mix( ${glslFloat(BACKDROP_CAVITY)}, 1.0, smoothstep( 0.05, 0.55, bdH ) );
  diffuseColor.rgb = mix( diffuseColor.rgb * bdCanopy, bdRock * bdStrata, bdRockMix ) * mix( 1.0, bdCav, bdK );
}`,
      );
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${prevKey.call(material)}|nova-backdrop-land-${octaves}`;
}

/** Window facades blend to their average colour between these view distances (m). */
export const WINDOW_FADE: readonly [number, number] = [110, 340];

/**
 * Distance fade of window maps (diffuse and emissive): beyond WINDOW_FADE the texel pattern is replaced by the texture's
 * mean colour (the last mip level). Chains behind an existing onBeforeCompile patch; lit materials with vViewPosition only.
 */
export function patchWindowFade(material: THREE.Material, range: readonly [number, number] = WINDOW_FADE): void {
  const prev = material.onBeforeCompile;
  const [near, far] = range.map(glslFloat);
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor = mix( sampledDiffuseColor, textureLod( map, vMapUv, 9.0 ), smoothstep( ${near}, ${far}, length( vViewPosition ) ) );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
  emissiveColor = mix( emissiveColor, textureLod( emissiveMap, vEmissiveMapUv, 9.0 ), smoothstep( ${near}, ${far}, length( vViewPosition ) ) );
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,
      );
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${prevKey.call(material)}|nova-window-fade-${near}-${far}`;
}

/**
 * Instance colour only where `tintMask` = 1 (vertex colours elsewhere). With `skin`, vertices whose `tintMask` is 2
 * get a per-instance skin tone instead.
 */
export function patchTintMask(material: THREE.Material, skin = false): void {
  material.onBeforeCompile = (shader) => applyTintMask(shader, skin);
  material.customProgramCacheKey = () => `nova-tint-mask-${skin ? 1 : 0}`;
}

/** Wrapped-diffuse offset (light reaches FOLIAGE_WRAP past the terminator) and the canopy exponent (> 1 = darker sooner). */
export const FOLIAGE_WRAP = 0.3;
export const FOLIAGE_CANOPY_POWER = 1.3;
/** Light through the leaves toward the viewer when the crown is seen against the sun (× sun colour × warm tint). */
export const FOLIAGE_TRANSLUCENCY = 0.42;
/** Wind sway of crowns (m per (m above FOLIAGE_SWAY_FROM)², and rad/s) — tint-masked vertices only. */
export const FOLIAGE_SWAY = 0.0045;
export const FOLIAGE_SWAY_FROM = 1.2;
export const FOLIAGE_SWAY_SPEED = 1.25;
/** Crown albedo relative to the instance colour (napali's canopy is darker and less saturated than a picked swatch). */
export const FOLIAGE_ALBEDO = 0.8;
export const FOLIAGE_SATURATION = 0.84;
/** Leaf mottling on top of the atlas: 3D noise cells per metre (object space) and the view distance (m) it fades by. */
export const FOLIAGE_LEAF_FREQ = 2.5;
export const FOLIAGE_LEAF_FADE: readonly [number, number] = [25, 110];
/** Foliage atlas size (texels) and the alpha gain per mip level (keeps leaf coverage in the small mips). */
export const FOLIAGE_ATLAS_SIZE: readonly [number, number] = [1024, 512];
export const FOLIAGE_MIP_ALPHA = 0.3;
/** Shared foliage clock (s): the race scene writes the race time each frame. */
export const FOLIAGE_TIME: THREE.IUniform<number> = { value: 0 };

/**
 * Tint mask + canopy lighting for instanced vegetation on a MeshLambertMaterial (see the file comment). Crowns built by
 * props.ts carry crown-scale normals and baked interior occlusion in their vertex colours; this adds the light model.
 */
export function patchFoliage(material: THREE.MeshLambertMaterial): void {
  material.onBeforeCompile = (shader) => {
    applyTintMask(shader, false);
    shader.uniforms.foliageTime = FOLIAGE_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float foliageTime;\nvarying vec3 vLeaf;\nvarying float vCrown;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vLeaf = position * ${glslFloat(FOLIAGE_LEAF_FREQ)};
vCrown = clamp( tintMask, 0.0, 1.0 );
#ifdef USE_INSTANCING
{
  float swayH = max( transformed.y - ${glslFloat(FOLIAGE_SWAY_FROM)}, 0.0 );
  float swayPh = dot( instanceMatrix[ 3 ].xz, vec2( 0.071, 0.053 ) );
  float swayK = ${glslFloat(FOLIAGE_SWAY)} * swayH * swayH * clamp( tintMask, 0.0, 1.0 );
  transformed.x += sin( foliageTime * ${glslFloat(FOLIAGE_SWAY_SPEED)} + swayPh ) * swayK;
  transformed.z += sin( foliageTime * ${glslFloat(FOLIAGE_SWAY_SPEED * 0.83)} + swayPh * 1.7 + 1.3 ) * swayK * 0.7;
}
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vLeaf;
varying float vCrown;
float leafHash( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
float leafNoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( leafHash( i ), leafHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( leafHash( i + vec3( 0, 1, 0 ) ), leafHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( leafHash( i + vec3( 0, 0, 1 ) ), leafHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( leafHash( i + vec3( 0, 1, 1 ) ), leafHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  if ( vCrown < 0.5 ) {
    // trunks, limbs, tiers: plain vertex colour, always opaque
    sampledDiffuseColor = vec4( 1.0 );
  } else {
    vec2 texDx = dFdx( vMapUv * vec2( ${glslFloat(FOLIAGE_ATLAS_SIZE[0])}, ${glslFloat(FOLIAGE_ATLAS_SIZE[1])} ) );
    vec2 texDy = dFdy( vMapUv * vec2( ${glslFloat(FOLIAGE_ATLAS_SIZE[0])}, ${glslFloat(FOLIAGE_ATLAS_SIZE[1])} ) );
    float texMip = max( 0.0, 0.5 * log2( max( dot( texDx, texDx ), dot( texDy, texDy ) ) ) );
    sampledDiffuseColor.a *= 1.0 + texMip * ${glslFloat(FOLIAGE_MIP_ALPHA)};
  }
  diffuseColor *= sampledDiffuseColor;
#endif`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
  // crown normals belong to the whole crown: both card sides light the same way
  if ( vCrown > 0.5 ) {
    normal = normalize( vNormal );
    nonPerturbedNormal = normal;
  }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if ( vCrown > 0.5 ) {
  // broad mottling up close (fades before it could shimmer), darker, less saturated canopy albedo
  float leafK = 1.0 - smoothstep( ${glslFloat(FOLIAGE_LEAF_FADE[0])}, ${glslFloat(FOLIAGE_LEAF_FADE[1])}, length( vViewPosition ) );
  float leaf = leafNoise( vLeaf ) * 0.6 + leafNoise( vLeaf * 2.7 + 13.1 ) * 0.4;
  diffuseColor.rgb *= mix( 1.0, mix( 0.78, 1.12, smoothstep( 0.25, 0.8, leaf ) ), leafK );
  float leafL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = mix( vec3( leafL ), diffuseColor.rgb, ${glslFloat(FOLIAGE_SATURATION)} ) * ${glslFloat(FOLIAGE_ALBEDO)};
}`,
      )
      .replace(
      '#include <lights_lambert_pars_fragment>',
      `varying vec3 vViewPosition;
struct LambertMaterial {
  vec3 diffuseColor;
  float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float nl = dot( geometryNormal, directLight.direction );
  float dotNL = pow( saturate( ( nl + ${glslFloat(FOLIAGE_WRAP)} ) / ${glslFloat(1 + FOLIAGE_WRAP)} ), ${glslFloat(FOLIAGE_CANOPY_POWER)} );
  vec3 irradiance = dotNL * directLight.color;
  // backlit leaves: light scattered through the crown toward the viewer
  float back = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 ) * saturate( 0.35 - nl );
  irradiance += back * ${glslFloat(FOLIAGE_TRANSLUCENCY)} * directLight.color * vec3( 1.05, 1.15, 0.55 );
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Lambert
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert`,
    );
  };
  material.customProgramCacheKey = () => 'nova-foliage';
}

function applyTintMask(shader: THREE.WebGLProgramParametersWithUniforms, skin: boolean): void {
  const tones = SKIN_TONES.map(glslColor);
  {
    shader.vertexShader = shader.vertexShader
      .replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute float tintMask;')
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, clamp( tintMask, 0.0, 1.0 ) );
  ${
    skin
      ? `float skinPick = fract( sin( float( gl_InstanceID ) * 12.9898 + 4.1 ) * 43758.5453 ) * 3.0;
  vec3 skinTone = skinPick < 1.0 ? mix( ${tones[0]}, ${tones[1]}, skinPick ) : skinPick < 2.0 ? mix( ${tones[1]}, ${tones[2]}, skinPick - 1.0 ) : mix( ${tones[2]}, ${tones[3]}, skinPick - 2.0 );
  vColor.rgb = mix( vColor.rgb, skinTone, step( 1.5, tintMask ) );`
      : ''
  }
#endif`,
      );
  }
}

export interface GroundPatchOptions {
  /** greyscale (mean ≈ 0.5) tileable detail texture */
  detail: THREE.Texture;
  /** use the per-vertex `groundData` attribute (mowing stripes, shore tint) — terrain only */
  terrain: boolean;
  /** shoreline colour (terrain on water biomes) */
  shoreColor?: THREE.Color;
  /** dry-patch strength 0..1 (sun-bleached straw / sand patches; terrain only) */
  dry?: number;
  /** bare soil / rock colour on steep slopes (terrain only) */
  rockColor?: THREE.Color;
  /** albedo saturation of the terrain (1 = palette as painted; < 1 = the muted greens of real turf from a distance) */
  saturation?: number;
  /** albedo brightness multiplier of the terrain */
  value?: number;
  /** sea level (m): surf along the waterline (wet sand band, foam running up and down the beach; terrain only) */
  surf?: number;
}

/** Two-scale detail noise (+ terrain mowing stripes and shoreline tint). The material must have a `map`. */
export function patchGroundMaterial(material: THREE.MeshStandardMaterial, opts: GroundPatchOptions): void {
  const detailUniform = { value: opts.detail };
  const shoreUniform = { value: (opts.shoreColor ?? new THREE.Color(0.6, 0.55, 0.42)).clone() };
  const dryUniform = { value: Math.max(0, Math.min(1, opts.dry ?? 0)) };
  const rockUniform = { value: (opts.rockColor ?? new THREE.Color(0.32, 0.29, 0.25)).clone() };
  const satUniform = { value: Math.max(0, Math.min(1.5, opts.saturation ?? 1)) };
  const valueUniform = { value: Math.max(0, Math.min(2, opts.value ?? 1)) };
  const terrain = opts.terrain;
  const surf = terrain && opts.surf !== undefined && Number.isFinite(opts.surf) ? opts.surf : null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundDetail = detailUniform;
    shader.uniforms.groundTime = FOLIAGE_TIME;
    shader.uniforms.shoreColor = shoreUniform;
    shader.uniforms.groundDry = dryUniform;
    shader.uniforms.rockColor = rockUniform;
    shader.uniforms.groundSat = satUniform;
    shader.uniforms.groundValue = valueUniform;
    if (terrain) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 groundData;\nvarying vec3 vGround;\nvarying float vGroundY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = groundData;\nvGroundY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D groundDetail;\nuniform vec3 shoreColor;\nuniform float groundDry;\nuniform vec3 rockColor;\nuniform float groundSat;\nuniform float groundValue;\nuniform float groundTime;\n${terrain ? 'varying vec3 vGround;\nvarying float vGroundY;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef USE_MAP
  float gdA = texture2D( groundDetail, vMapUv * ${glslFloat(GROUND_DETAIL_FINE)} ).r;
  float gdB = texture2D( groundDetail, vec2( vMapUv.y, -vMapUv.x ) * ${glslFloat(GROUND_DETAIL_MID)} + vec2( 0.37, 0.71 ) ).r;
  // the regular detail tiles would read as a lattice far away: they fade out with distance
  float gdK = 1.0 - ${glslFloat(GROUND_DETAIL_FAR_CUT)} * smoothstep( ${glslFloat(GROUND_FAR_FADE[0] * 0.5)}, ${glslFloat(GROUND_FAR_FADE[1] * 0.7)}, length( vViewPosition ) );
  diffuseColor.rgb *= ( 1.0 + ( gdA - 0.5 ) * ${glslFloat(GROUND_DETAIL_FINE_AMOUNT * 2)} * gdK ) * ( 1.0 + ( gdB - 0.5 ) * ${glslFloat(GROUND_DETAIL_MID_AMOUNT * 2)} * gdK );
#endif
${
  terrain
    ? `#ifdef USE_MAP
{
  // far away the 24 m colour map fades to its mean (mip tail): no visible repeat
  float gFar = smoothstep( ${glslFloat(GROUND_FAR_FADE[0])}, ${glslFloat(GROUND_FAR_FADE[1])}, length( vViewPosition ) ) * ${glslFloat(1 - GROUND_FAR_KEEP)};
  vec3 gTex = max( texture2D( map, vMapUv ).rgb, vec3( 0.004 ) );
  vec3 gMean = textureLod( map, vMapUv, 9.0 ).rgb;
  diffuseColor.rgb *= mix( vec3( 1.0 ), gMean / gTex, gFar );
  // world-scale tone and sun-bleached dry patches (never tile within a circuit)
  float gL1 = texture2D( groundDetail, vMapUv * ${glslFloat(GROUND_WORLD_FREQ[0])} + vec2( 0.13, 0.71 ) ).r;
  float gL2 = texture2D( groundDetail, vec2( vMapUv.y, -vMapUv.x ) * ${glslFloat(GROUND_WORLD_FREQ[1])} + vec2( 0.61, 0.29 ) ).r;
  diffuseColor.rgb *= 1.0 + ${glslFloat(GROUND_WORLD_TONE)} * ( ( gL1 - 0.5 ) + ( gL2 - 0.5 ) ) * 2.0;
  float gDry = smoothstep( 0.52, 0.72, gL1 * 0.7 + gL2 * 0.3 ) * groundDry;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.28, 1.08, 0.72 ), gDry );
  // steep banks: bare soil / rock (napali: slope-driven blend, block-to-block variation)
  vec3 gN = inverseTransformDirection( normalize( vNormal ), viewMatrix );
  float gRock = smoothstep( ${glslFloat(GROUND_ROCK_SLOPE[0])}, ${glslFloat(GROUND_ROCK_SLOPE[1])}, 1.0 - gN.y + ( gdB - 0.5 ) * 0.16 );
  diffuseColor.rgb = mix( diffuseColor.rgb, rockColor * ( 0.75 + 0.5 * gdA ) * ( 0.85 + 0.3 * gL2 ), gRock );
  float gLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = max( mix( vec3( gLum ), diffuseColor.rgb, groundSat ), vec3( 0.0 ) ) * groundValue;
}
#endif
{
  float mowPh = vGround.y / ${glslFloat(GROUND_MOW_PERIOD)};
  float mowFw = fwidth( mowPh );
  float mowEdge = clamp( mowFw * 6.0, 0.06, 1.0 );
  float mowBand = smoothstep( -mowEdge, mowEdge, -sin( mowPh * 6.2831853 ) );
  float mowFade = 1.0 - smoothstep( 0.12, 0.35, mowFw );
  diffuseColor.rgb *= 1.0 + ${glslFloat(GROUND_MOW_CONTRAST)} * ( mowBand * 2.0 - 1.0 ) * clamp( vGround.x, 0.0, 1.0 ) * mowFade;
  diffuseColor.rgb = mix( diffuseColor.rgb, shoreColor, clamp( vGround.z, 0.0, 1.0 ) );
}
${
  surf !== null
    ? `#ifdef USE_MAP
{
  // surf: the waterline swashes up and down the beach (two slow swells along the shore), wet sand above it, foam on it
  float gSwash = ${glslFloat(SURF_SWASH[0])} * sin( groundTime * 0.7 + dot( vMapUv, vec2( 0.9, 0.4 ) ) * 1.3 ) + ${glslFloat(SURF_SWASH[1])} * sin( groundTime * 1.9 + vMapUv.x * 3.1 - vMapUv.y * 1.7 );
  float gLine = vGroundY - ${glslFloat(+surf.toFixed(3))} - gSwash;
  float gWet = 1.0 - smoothstep( 0.0, ${glslFloat(SURF_WET_HEIGHT)}, gLine );
  diffuseColor.rgb *= mix( 1.0, ${glslFloat(SURF_WET_DARKEN)}, gWet * clamp( vGround.z, 0.0, 1.0 ) );
  float gFoam = ( 1.0 - smoothstep( 0.0, ${glslFloat(SURF_FOAM_WIDTH)}, abs( gLine - 0.06 ) ) ) * smoothstep( 0.3, 0.62, gdA * 0.55 + gdB * 0.45 + 0.08 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.9, 0.92 ), gFoam * 0.9 );
}
#endif`
    : ''
}`
    : ''
}`,
      );
  };
  material.customProgramCacheKey = () => `nova-ground-${terrain ? 1 : 0}-${surf ?? 'x'}`;
}

/**
 * Napali-style sea on the MeshStandardMaterial with the wave normal map: the map is layered with a large swell and a
 * fine ripple (rotated so the repeats never line up), the ripples fade out with distance while the roughness rises (the
 * glitter spreads), and the light coming through the wave flanks that face the viewer turns them turquoise (`flank`).
 */
export function patchSeaMaterial(material: THREE.MeshStandardMaterial, flank: THREE.Color): void {
  const flankUniform = { value: flank.clone() };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.seaFlank = flankUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 seaFlank;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, ${glslFloat(SEA_FAR_ROUGHNESS)}, smoothstep( 120.0, 1400.0, length( vViewPosition ) ) );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
{
  float seaDist = length( vViewPosition );
  vec2 seaN1 = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
  vec2 seaN2 = texture2D( normalMap, vec2( vNormalMapUv.y, - vNormalMapUv.x ) * ${glslFloat(SEA_SWELL_SCALE)} + vec2( 0.31, 0.67 ) ).xy * 2.0 - 1.0;
  vec2 seaN3 = texture2D( normalMap, vec2( - vNormalMapUv.x, vNormalMapUv.y ) * ${glslFloat(SEA_RIPPLE_SCALE)} + vec2( 0.53, 0.11 ) ).xy * 2.0 - 1.0;
  vec2 seaXY = ( seaN1 + seaN2 * 0.9 + seaN3 * 0.45 * ( 1.0 - smoothstep( 25.0, 180.0, seaDist ) ) ) * normalScale;
  seaXY *= mix( 1.0, 0.4, smoothstep( 150.0, 1600.0, seaDist ) );
  normal = normalize( tbn * vec3( seaXY, 1.0 ) );
  // wave flanks that face the viewer let the light through
  vec3 seaWn = inverseTransformDirection( normal, viewMatrix );
  vec3 seaV = inverseTransformDirection( normalize( vViewPosition ), viewMatrix );
  float seaFacing = clamp( dot( seaWn.xz, normalize( seaV.xz + vec2( 1e-4 ) ) ) * 6.0, 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, seaFlank, seaFacing * ${glslFloat(SEA_FLANK)} );
}
#endif`,
      );
  };
  material.customProgramCacheKey = () => 'nova-sea';
}
