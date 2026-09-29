/**
 * GLSL counterpart of panoramaShaders.ts, owned by FOSS Earth's renderer.
 * The same analytic quad and immersion triangle work on WebGL 1 and 2;
 * Babylon translates attributes, varyings and fragment depth for WebGL 2.
 * WebGL textures hold encoded sRGB. Decode before blending and encode once
 * at output, matching WebGPU's native sRGB texture sampling contract.
 */

const EXTENSIONS = /* glsl */ `
#extension GL_OES_standard_derivatives : require
#ifdef PANORAMA_TEXTURE_GRADIENTS
#extension GL_EXT_shader_texture_lod : enable
#endif
precision highp float;
`;

const CONTENT_UNIFORMS = /* glsl */ `
uniform vec3 content0;
uniform vec3 content1;
uniform vec3 content2;
`;

const COMMON = /* glsl */ `
vec3 panoramaSrgbDecode(vec3 encoded) {
  vec3 c = clamp(encoded, 0.0, 1.0);
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}

vec3 panoramaSrgbEncode(vec3 linearColor) {
  vec3 c = clamp(linearColor, 0.0, 1.0);
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

vec3 panoramaImageDirection(vec3 worldDirection) {
  return vec3(dot(content0, worldDirection), dot(content1, worldDirection), dot(content2, worldDirection));
}

vec3 panoramaCubeVector(vec3 imageDirection) {
  return vec3(imageDirection.x, imageDirection.z, imageDirection.y);
}

vec2 panoramaEquirectUv(vec3 imageDirection) {
  vec3 d = normalize(imageDirection);
  return vec2(atan(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
}

vec4 panoramaSeamlessSample(sampler2D tex, vec2 uv) {
#ifdef PANORAMA_TEXTURE_GRADIENTS
  float shifted = fract(uv.x + 0.5);
  vec2 dx = vec2(abs(dFdx(uv.x)) <= abs(dFdx(shifted)) ? dFdx(uv.x) : dFdx(shifted), dFdx(uv.y));
  vec2 dy = vec2(abs(dFdy(uv.x)) <= abs(dFdy(shifted)) ? dFdy(uv.x) : dFdy(shifted), dFdy(uv.y));
#ifdef PANORAMA_WEBGL2
  return textureGrad(tex, uv, dx, dy);
#else
  return texture2DGradEXT(tex, uv, dx, dy);
#endif
#else
  // WebGL 1 without EXT_shader_texture_lod still draws the same image;
  // its implicit mip gradients can be softer at the longitude seam.
  return texture2D(tex, uv);
#endif
}
`;

export const ORB_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewRotProj;
uniform vec3 quadCenter;
uniform vec3 quadU;
uniform vec3 quadV;
varying vec3 vRel;
void main(void) {
  vec3 rel = quadCenter + position.x * quadU + position.y * quadV;
  vRel = rel;
  gl_Position = viewRotProj * vec4(rel, 1.0);
}
`;

export const ORB_FRAGMENT_GLSL = /* glsl */ `
#extension GL_EXT_frag_depth : require
${EXTENSIONS}
uniform mat4 viewRotProj;
uniform vec3 markerRel;
uniform float radius;
uniform float tanPreviewHalfAngle;
uniform float opacity;
uniform vec4 outlineColor;
uniform float outlineWidth;
${CONTENT_UNIFORMS}
#ifdef SOURCE_EQUIRECT
uniform sampler2D panoramaEquirect;
#else
uniform samplerCube panoramaCube;
#endif
varying vec3 vRel;
${COMMON}

void main(void) {
  vec3 v = normalize(vRel);
  float d = length(markerRel);
  vec3 a = markerRel / d;
  float c = dot(a, v);
  vec3 k = v - c * a;
  float sinDelta = length(k);
  bool inside = d <= radius;
  float sinAlpha = min(radius / d, 1.0);
  float cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  float tanAlpha = sinAlpha / max(cosAlpha, 1e-7);
  float edge = sinAlpha - sinDelta;
  float edgeWidth = max(fwidth(sinDelta), 1e-7);
  float front = c > 0.0 ? 1.0 : 0.0;
  float exterior = clamp(edge / edgeWidth + 0.5, 0.0, 1.0) * front;
  float coverage = inside ? 1.0 : exterior;
  float pixelStep = max(length(vec2(dFdx(sinDelta), dFdy(sinDelta))), 1e-9);
  float ringOuter = clamp(edge / pixelStep + outlineWidth + 0.5, 0.0, 1.0) * front;
  float ring = (inside ? 0.0 : max(ringOuter - exterior, 0.0)) * outlineColor.a;

  float gain = tanPreviewHalfAngle / max(tanAlpha, 1e-7);
  vec3 windowed = normalize(a + k * (gain / max(c, 1e-4)));
  vec3 worldDirection = (inside || tanAlpha >= tanPreviewHalfAngle) ? v : windowed;
  vec3 imageDirection = panoramaImageDirection(worldDirection);
#ifdef SOURCE_EQUIRECT
  vec4 sampled = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectUv(imageDirection));
#else
  vec4 sampled = textureCube(panoramaCube, panoramaCubeVector(imageDirection));
#endif

  float b = c * d;
  float root = sqrt(max(radius * radius - d * d + b * b, 0.0));
  float t = inside ? b + root : b - root;
  vec4 clip = viewRotProj * vec4(v * max(t, 0.0), 1.0);
#ifdef OUTPUT_DIRECTION
  if (coverage <= 0.0) discard;
  gl_FragColor = vec4(imageDirection, coverage);
#else
#ifdef OUTPUT_RAY
  if (coverage <= 0.0) discard;
  gl_FragColor = vec4(v, coverage);
#else
  float shown = coverage + ring;
  if (shown <= 0.0) discard;
  vec3 rgb = (sampled.rgb * coverage + outlineColor.rgb * ring) / shown;
  gl_FragColor = vec4(rgb, shown * opacity);
#endif
#endif
  // WebGL's projection maps depth to [-1, 1], unlike WebGPU's [0, 1].
  gl_FragDepthEXT = clamp(0.5 * (clip.z / clip.w) + 0.5, 0.0, 1.0);
}
`;

export const IMMERSION_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 inverseViewRotProj;
varying vec4 vRay;
void main(void) {
  vec4 clip = vec4(position.xy, 0.5, 1.0);
  vRay = inverseViewRotProj * clip;
  gl_Position = clip;
}
`;

export const IMMERSION_FRAGMENT_GLSL = /* glsl */ `
${EXTENSIONS}
uniform float opacity;
uniform float mixWeight;
${CONTENT_UNIFORMS}
uniform vec3 nextContent0;
uniform vec3 nextContent1;
uniform vec3 nextContent2;
#ifdef SOURCE_EQUIRECT
uniform sampler2D panoramaEquirect;
#else
uniform samplerCube panoramaCube;
#endif
#ifdef NEXT_EQUIRECT
uniform sampler2D nextEquirect;
#endif
#ifdef NEXT_CUBE
uniform samplerCube nextCube;
#endif
varying vec4 vRay;
${COMMON}

void main(void) {
  vec3 v = normalize(vRay.xyz / vRay.w);
  vec3 imageDirection = panoramaImageDirection(v);
#ifdef SOURCE_EQUIRECT
  vec3 color = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectUv(imageDirection)).rgb;
#else
  vec3 color = textureCube(panoramaCube, panoramaCubeVector(imageDirection)).rgb;
#endif
  vec3 nextImage = vec3(dot(nextContent0, v), dot(nextContent1, v), dot(nextContent2, v));
#ifdef NEXT_EQUIRECT
  color = panoramaSrgbEncode(mix(panoramaSrgbDecode(color), panoramaSrgbDecode(panoramaSeamlessSample(nextEquirect, panoramaEquirectUv(nextImage)).rgb), mixWeight));
#endif
#ifdef NEXT_CUBE
  color = panoramaSrgbEncode(mix(panoramaSrgbDecode(color), panoramaSrgbDecode(textureCube(nextCube, panoramaCubeVector(nextImage)).rgb), mixWeight));
#endif
#ifdef OUTPUT_DIRECTION
  gl_FragColor = vec4(imageDirection, 1.0);
#else
#ifdef OUTPUT_RAY
  gl_FragColor = vec4(v, 1.0);
#else
  // The steady view has no crossfade: avoid decoding and encoding every
  // pixel when the encoded sample is already the desired display color.
  gl_FragColor = vec4(color, opacity);
#endif
#endif
}
`;
