/**
 * Shader patches (onBeforeCompile) for scenery materials:
 * - backdrop fog: the scene fog capped below 1 so far hills / mountains stay readable silhouettes beyond the fog
 *   distance (the cap lifts back to 1 when fog closes in for rain), and emissive windows shine through the haze;
 * - window fade: facade / window maps blend to their mip-chain average with distance, so far skylines do not shimmer
 *   (moiré) and read as a lit mass;
 * - tint mask: instance colour applied only where the per-vertex `tintMask` attribute is 1 (shirts, tree crowns),
 *   optional per-instance skin tones (crowd heads) from gl_InstanceID;
 * - ground: two-scale greyscale detail noise, mowing stripes along the track and a shoreline tint for the terrain
 *   (per-vertex `groundData` = mow weight, stripe coordinate s, shore weight), detail noise only for verges.
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
  const tones = SKIN_TONES.map(glslColor);
  material.onBeforeCompile = (shader) => {
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
  };
  material.customProgramCacheKey = () => `nova-tint-mask-${skin ? 1 : 0}`;
}

export interface GroundPatchOptions {
  /** greyscale (mean ≈ 0.5) tileable detail texture */
  detail: THREE.Texture;
  /** use the per-vertex `groundData` attribute (mowing stripes, shore tint) — terrain only */
  terrain: boolean;
  /** shoreline colour (terrain on water biomes) */
  shoreColor?: THREE.Color;
}

/** Two-scale detail noise (+ terrain mowing stripes and shoreline tint). The material must have a `map`. */
export function patchGroundMaterial(material: THREE.MeshStandardMaterial, opts: GroundPatchOptions): void {
  const detailUniform = { value: opts.detail };
  const shoreUniform = { value: (opts.shoreColor ?? new THREE.Color(0.6, 0.55, 0.42)).clone() };
  const terrain = opts.terrain;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundDetail = detailUniform;
    shader.uniforms.shoreColor = shoreUniform;
    if (terrain) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 groundData;\nvarying vec3 vGround;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = groundData;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D groundDetail;\nuniform vec3 shoreColor;\n${terrain ? 'varying vec3 vGround;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef USE_MAP
  float gdA = texture2D( groundDetail, vMapUv * ${glslFloat(GROUND_DETAIL_FINE)} ).r;
  float gdB = texture2D( groundDetail, vec2( vMapUv.y, -vMapUv.x ) * ${glslFloat(GROUND_DETAIL_MID)} + vec2( 0.37, 0.71 ) ).r;
  diffuseColor.rgb *= ( 1.0 + ( gdA - 0.5 ) * ${glslFloat(GROUND_DETAIL_FINE_AMOUNT * 2)} ) * ( 1.0 + ( gdB - 0.5 ) * ${glslFloat(GROUND_DETAIL_MID_AMOUNT * 2)} );
#endif
${
  terrain
    ? `{
  float mowPh = vGround.y / ${glslFloat(GROUND_MOW_PERIOD)};
  float mowFw = fwidth( mowPh );
  float mowEdge = clamp( mowFw * 6.0, 0.06, 1.0 );
  float mowBand = smoothstep( -mowEdge, mowEdge, -sin( mowPh * 6.2831853 ) );
  float mowFade = 1.0 - smoothstep( 0.12, 0.35, mowFw );
  diffuseColor.rgb *= 1.0 + ${glslFloat(GROUND_MOW_CONTRAST)} * ( mowBand * 2.0 - 1.0 ) * clamp( vGround.x, 0.0, 1.0 ) * mowFade;
  diffuseColor.rgb = mix( diffuseColor.rgb, shoreColor, clamp( vGround.z, 0.0, 1.0 ) );
}`
    : ''
}`,
      );
  };
  material.customProgramCacheKey = () => `nova-ground-${terrain ? 1 : 0}`;
}
