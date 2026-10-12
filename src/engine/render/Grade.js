// Colour grade, applied by three.js inside every lit / sky / water shader (no extra pass):
// AgX tone mapping (filmic, natural greens and skies that roll off instead of clipping) with a
// slightly punchier look — a touch more contrast and saturation — so the island doesn't look
// washed out. Selected with renderer.toneMapping = THREE.CustomToneMapping (Engine.js).
import * as THREE from 'three';

const HOOK = 'vec3 CustomToneMapping( vec3 color ) { return color; }';

if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(HOOK)) {
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(HOOK, /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
  vec3 c = clamp( AgXToneMapping( color ), 0.0, 1.0 ); // exposure applied inside
  // grade in display space: mild S curve + saturation
  vec3 g = pow( c, vec3( 1.0 / 2.2 ) );
  g = mix( g, g * g * ( 3.0 - 2.0 * g ), 0.22 );
  float l = dot( g, vec3( 0.2126, 0.7152, 0.0722 ) );
  g = clamp( mix( vec3( l ), g, 1.1 ), 0.0, 1.0 );
  return pow( g, vec3( 2.2 ) );
}`);
}

export const TONE_MAPPING = THREE.CustomToneMapping;
