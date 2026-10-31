/**
 * Two-cascade sun shadows in three's own lighting chunks (installed once, for every lit material: no per-material
 * patches). Convention: when a scene has two shadow-casting directional lights and the SECOND one is black (intensity
 * 0), it is the far cascade of the first. The first light then shades with its own (near) map inside the near box, fades
 * to the far map across the box's outer band (CASCADE_FADE_START) and uses the far map alone beyond; the black light
 * skips its own shadow lookup. Scenes with one shadow-casting directional light (showroom) compile exactly as before.
 */
import * as THREE from 'three';
import { CASCADE_FADE_START } from './shadowCascades';

const ORIGINAL_LINE =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

const CASCADE_LINE = /* glsl */ `#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= receiveShadow ? sunCascadeShadow( directionalShadowMap[ 0 ], directionalLightShadow, vDirectionalShadowCoord[ 0 ], directionalShadowMap[ 1 ], directionalLightShadows[ 1 ], vDirectionalShadowCoord[ 1 ], directionalLights[ 1 ].color ) : 1.0;
		#elif ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 )
		directLight.color *= ( receiveShadow && dot( directLight.color, vec3( 1.0 ) ) > 0.0 ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#else
		${ORIGINAL_LINE}
		#endif`;

const CASCADE_FUNCTION = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 1
	#if defined( SHADOWMAP_TYPE_PCF )
		#define SUN_CASCADE_SAMPLER sampler2DShadow
	#else
		#define SUN_CASCADE_SAMPLER sampler2D
	#endif
	// near map inside its box, faded into the far map over the outer band; a lit far light is no cascade (own shadow only)
	float sunCascadeShadow( SUN_CASCADE_SAMPLER nearMap, DirectionalLightShadow nearShadow, vec4 nearCoord, SUN_CASCADE_SAMPLER farMap, DirectionalLightShadow farShadow, vec4 farCoord, vec3 farColor ) {
		float shadow = 1.0;
		if ( dot( farColor, vec3( 1.0 ) ) > 0.0 ) {
			return getShadow( nearMap, nearShadow.shadowMapSize, nearShadow.shadowIntensity, nearShadow.shadowBias, nearShadow.shadowRadius, nearCoord );
		}
		vec3 c = nearCoord.xyz / nearCoord.w;
		vec2 e = abs( c.xy - 0.5 ) * 2.0;
		float w = c.z <= 1.0 ? 1.0 - smoothstep( ${CASCADE_FADE_START.toFixed(4)}, 1.0, max( e.x, e.y ) ) : 0.0;
		if ( w > 0.0 ) shadow = getShadow( nearMap, nearShadow.shadowMapSize, nearShadow.shadowIntensity, nearShadow.shadowBias, nearShadow.shadowRadius, nearCoord );
		if ( w < 1.0 ) shadow = mix( getShadow( farMap, farShadow.shadowMapSize, farShadow.shadowIntensity, farShadow.shadowBias, farShadow.shadowRadius, farCoord ), shadow, w );
		return shadow;
	}
#endif
`;

let installed: boolean | null = null;

/**
 * Patch THREE.ShaderChunk once (idempotent). Returns false (and leaves three untouched) when the expected chunk text is
 * not found, e.g. after a three.js upgrade changed it: the far light then simply casts its own, black (invisible) shadow.
 */
export function installSunCascadeShader(): boolean {
  if (installed !== null) return installed;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const lights = chunks.lights_fragment_begin;
  const pars = chunks.shadowmap_pars_fragment;
  if (typeof lights !== 'string' || typeof pars !== 'string' || !lights.includes(ORIGINAL_LINE)) {
    console.warn('render: sun cascade shader not installed (unexpected three.js lights chunk)');
    installed = false;
    return false;
  }
  chunks.lights_fragment_begin = lights.replace(ORIGINAL_LINE, CASCADE_LINE);
  chunks.shadowmap_pars_fragment = pars + CASCADE_FUNCTION;
  installed = true;
  return true;
}
