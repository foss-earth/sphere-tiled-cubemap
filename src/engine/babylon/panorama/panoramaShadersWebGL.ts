/**
 * GLSL counterpart of panoramaShaders.ts, owned by FOSS Earth's renderer.
 * The same analytic quad and immersion triangle work on WebGL 1 and 2;
 * Babylon translates attributes, varyings and fragment depth for WebGL 2.
 * WebGL textures hold encoded sRGB. Decode before blending and encode once
 * at output, matching WebGPU's native sRGB texture sampling contract.
 *
 * SOURCE_TILES and NEXT_TILES draw a tiled cube (src/scenes/tiles/) over the
 * preview cube the same draw samples: panoramaTiles looks the direction's cell
 * up in the display table and takes one bilinear tap from the atlas.
 *
 * PANORAMA_LEAN (the renderer.experiments.panoramaShaders parameter) draws
 * the same image with less per-pixel work: the orb's cap angle and window
 * come from the CPU (its depth keeps this shader's arithmetic), immersion
 * turns the view into the image's frame in the vertex shader, and a ray is
 * normalized once where it must be, or not at all for a cube lookup, which
 * only needs its direction.
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

vec2 panoramaEquirectUvUnit(vec3 d) {
  return vec2(atan(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
}

vec2 panoramaEquirectUv(vec3 imageDirection) {
  return panoramaEquirectUvUnit(normalize(imageDirection));
}

#if defined(SOURCE_TILES) || defined(NEXT_TILES)
// A direction in the image's axes: its tiled-cube face, by the format's face
// table, and (u, v) on it, warped equi-angularly when warp > 0.5.
vec2 panoramaTileFace(vec3 d, float warp, out float face) {
  vec3 a = abs(d);
  float s;
  float t;
  float depth;
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0.0 : 1.0;
    s = d.x > 0.0 ? -d.y : d.y;
    t = d.z;
    depth = a.x;
  } else if (a.y >= a.z) {
    face = d.y > 0.0 ? 2.0 : 3.0;
    s = d.y > 0.0 ? d.x : -d.x;
    t = d.z;
    depth = a.y;
  } else {
    face = d.z > 0.0 ? 4.0 : 5.0;
    s = d.x;
    t = d.z > 0.0 ? -d.y : d.y;
    depth = a.z;
  }
  vec2 st = vec2(s, t) / depth;
  if (warp > 0.5) st = atan(st) * 1.2732395447351628;
  return vec2(st.x + 1.0, 1.0 - st.y) * 0.5;
}

// One display-table entry's tile at (u, v), or the preview where it shows none.
// The tap stays inside the tile's stored texels: its gutter, never a neighbour.
vec3 panoramaTileTap(sampler2D atlas, vec4 entry, vec2 uv, vec4 shape, vec2 atlasSize, vec3 preview) {
  float level = floor(entry.b * 255.0 + 0.5) - 1.0;
  // Rounded: a GPU's exp2 may return 3.9999998 for 4, and the tile would then disagree with the table's cell.
  float n = floor(exp2(max(level, 0.0)) + 0.5);
  vec2 tile = min(floor(uv * n), vec2(n - 1.0));
  vec2 slot = floor(entry.rg * 255.0 + 0.5);
  vec2 at = slot * shape.w + shape.z + clamp(uv * n - tile, 0.0, 1.0) * shape.y;
  vec3 tiled = texture2D(atlas, at / atlasSize).rgb;
  return level < 0.0 ? preview : tiled;
}

// A tiled cube's colour in a direction: the tile the table shows for its cell,
// faded in over the one it showed before (in linear light), over the preview.
// shape: cells, tile size, gutter, stored size (not "layout", a reserved word in WGSL and GLSL ES 3.00); info: atlas width and height, warp, outlines.
vec3 panoramaTiles(sampler2D atlas, sampler2D table, vec3 preview, vec3 imageDirection, vec4 shape, vec4 info) {
  float face;
  vec2 uv = clamp(panoramaTileFace(imageDirection, info.z, face), 0.0, 1.0);
  float cells = shape.x;
  vec2 cell = min(floor(uv * cells), vec2(cells - 1.0));
  vec2 tableSize = vec2(6.0 * cells, 2.0 * cells);
  vec4 newer = texture2D(table, (vec2(face * cells + cell.x, cell.y) + 0.5) / tableSize);
  vec4 older = texture2D(table, (vec2(face * cells + cell.x, cells + cell.y) + 0.5) / tableSize);
  vec3 color = panoramaTileTap(atlas, newer, uv, shape, info.xy, preview);
  if (newer.a < 1.0) {
    vec3 before = panoramaTileTap(atlas, older, uv, shape, info.xy, preview);
    color = panoramaSrgbEncode(mix(panoramaSrgbDecode(before), panoramaSrgbDecode(color), newer.a));
  }
  // Tile outlines: each tile's edges a pixel wide, tinted by its level; the preview red.
  float level = floor(newer.b * 255.0 + 0.5) - 1.0;
  vec2 inTile = uv * floor(exp2(max(level, 0.0)) + 0.5);
  vec2 edge = min(fract(inTile), 1.0 - fract(inTile)) / max(fwidth(inTile), vec2(1e-6));
  vec3 tint = level < 0.0 ? vec3(1.0, 0.35, 0.35) : level < 0.5 ? vec3(1.0, 0.65, 0.25) : level < 1.5 ? vec3(1.0, 1.0, 0.4) : level < 2.5 ? vec3(0.4, 1.0, 0.5) : vec3(0.4, 0.75, 1.0);
  vec3 outlined = mix(color * tint, vec3(1.0), step(min(edge.x, edge.y), 1.0) * step(-0.5, level));
  return info.w > 0.5 ? outlined : color;
}
#endif

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
#ifdef PANORAMA_LEAN
// The same for every pixel of a draw, so worked out once on the CPU (ORB_LEAN_UNIFORMS).
uniform float sinAlpha;
uniform float windowGain;
uniform float identityWindow;
#endif
${CONTENT_UNIFORMS}
#ifdef SOURCE_EQUIRECT
uniform sampler2D panoramaEquirect;
#else
uniform samplerCube panoramaCube;
#endif
#ifdef SOURCE_TILES
uniform sampler2D tileAtlas;
uniform sampler2D tileTable;
uniform vec4 tileLayout;
uniform vec4 tileAtlasInfo;
#endif
varying vec3 vRel;
${COMMON}

void main(void) {
  vec3 v = normalize(vRel);
#ifdef PANORAMA_LEAN
  // The distance, axis and depth keep the full shader's arithmetic: orbs that
  // nearly coincide on screen must settle their depth ties the same way.
  float d = length(markerRel);
  vec3 a = markerRel / d;
  float c = dot(a, v);
  vec3 k = v - c * a;
  float sinDelta = length(k);
  bool inside = d <= radius;
#else
  float d = length(markerRel);
  vec3 a = markerRel / d;
  float c = dot(a, v);
  vec3 k = v - c * a;
  float sinDelta = length(k);
  bool inside = d <= radius;
  float sinAlpha = min(radius / d, 1.0);
  float cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  float tanAlpha = sinAlpha / max(cosAlpha, 1e-7);
#endif
  float edge = sinAlpha - sinDelta;
  float edgeWidth = max(fwidth(sinDelta), 1e-7);
  float front = c > 0.0 ? 1.0 : 0.0;
  float exterior = clamp(edge / edgeWidth + 0.5, 0.0, 1.0) * front;
  float coverage = inside ? 1.0 : exterior;
  float pixelStep = max(length(vec2(dFdx(sinDelta), dFdy(sinDelta))), 1e-9);
  float ringOuter = clamp(edge / pixelStep + outlineWidth + 0.5, 0.0, 1.0) * front;
  float ring = (inside ? 0.0 : max(ringOuter - exterior, 0.0)) * outlineColor.a;

#ifdef PANORAMA_LEAN
  // Only its direction is sampled: the equirectangular lookup normalizes it once, a cube needs no length.
  vec3 worldDirection = identityWindow > 0.5 ? v : a + k * (windowGain / max(c, 1e-4));
#else
  float gain = tanPreviewHalfAngle / max(tanAlpha, 1e-7);
  vec3 windowed = normalize(a + k * (gain / max(c, 1e-4)));
  vec3 worldDirection = (inside || tanAlpha >= tanPreviewHalfAngle) ? v : windowed;
#endif
  vec3 imageDirection = panoramaImageDirection(worldDirection);
#ifdef SOURCE_EQUIRECT
  vec4 sampled = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectUv(imageDirection));
#else
  vec4 sampled = textureCube(panoramaCube, panoramaCubeVector(imageDirection));
#endif
#ifdef SOURCE_TILES
  sampled.rgb = panoramaTiles(tileAtlas, tileTable, sampled.rgb, imageDirection, tileLayout, tileAtlasInfo);
#endif

  float b = c * d;
  float root = sqrt(max(radius * radius - d * d + b * b, 0.0));
  float t = inside ? b + root : b - root;
  vec4 clip = viewRotProj * vec4(v * max(t, 0.0), 1.0);
#ifdef OUTPUT_DIRECTION
  if (coverage <= 0.0) discard;
#ifdef PANORAMA_LEAN
  gl_FragColor = vec4(normalize(imageDirection), coverage);
#else
  gl_FragColor = vec4(imageDirection, coverage);
#endif
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
#ifdef PANORAMA_LEAN
// The view ray in each image's frame, divided by its w on the CPU: w is the
// same at every corner, so the rotation is linear across the triangle.
uniform mat4 imageFromClip;
uniform mat4 nextImageFromClip;
varying vec3 vImage;
varying vec3 vNextImage;
#ifdef OUTPUT_RAY
varying vec4 vRay;
#endif
#else
varying vec4 vRay;
#endif
void main(void) {
  vec4 clip = vec4(position.xy, 0.5, 1.0);
#ifdef PANORAMA_LEAN
  vImage = (imageFromClip * clip).xyz;
  vNextImage = (nextImageFromClip * clip).xyz;
#ifdef OUTPUT_RAY
  vRay = inverseViewRotProj * clip;
#endif
#else
  vRay = inverseViewRotProj * clip;
#endif
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
#ifdef SOURCE_TILES
uniform sampler2D tileAtlas;
uniform sampler2D tileTable;
uniform vec4 tileLayout;
uniform vec4 tileAtlasInfo;
#endif
#ifdef NEXT_TILES
uniform sampler2D nextTileAtlas;
uniform sampler2D nextTileTable;
uniform vec4 nextTileLayout;
uniform vec4 nextTileAtlasInfo;
#endif
#ifdef PANORAMA_LEAN
varying vec3 vImage;
#ifdef NEXT_EQUIRECT
varying vec3 vNextImage;
#endif
#ifdef NEXT_CUBE
varying vec3 vNextImage;
#endif
#ifdef OUTPUT_RAY
varying vec4 vRay;
#endif
#else
varying vec4 vRay;
#endif
${COMMON}

void main(void) {
#ifdef PANORAMA_LEAN
#ifdef SOURCE_EQUIRECT
  vec3 imageDirection = normalize(vImage);
  vec3 color = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectUvUnit(imageDirection)).rgb;
#else
  vec3 imageDirection = vImage;
  vec3 color = textureCube(panoramaCube, panoramaCubeVector(imageDirection)).rgb;
#endif
#ifdef NEXT_EQUIRECT
  vec3 nextImage = normalize(vNextImage);
#endif
#ifdef NEXT_CUBE
  vec3 nextImage = vNextImage;
#endif
#else
  vec3 v = normalize(vRay.xyz / vRay.w);
  vec3 imageDirection = panoramaImageDirection(v);
#ifdef SOURCE_EQUIRECT
  vec3 color = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectUv(imageDirection)).rgb;
#else
  vec3 color = textureCube(panoramaCube, panoramaCubeVector(imageDirection)).rgb;
#endif
  vec3 nextImage = vec3(dot(nextContent0, v), dot(nextContent1, v), dot(nextContent2, v));
#endif
#ifdef SOURCE_TILES
  color = panoramaTiles(tileAtlas, tileTable, color, imageDirection, tileLayout, tileAtlasInfo);
#endif
#ifdef NEXT_EQUIRECT
#ifdef PANORAMA_LEAN
  color = panoramaSrgbEncode(mix(panoramaSrgbDecode(color), panoramaSrgbDecode(panoramaSeamlessSample(nextEquirect, panoramaEquirectUvUnit(nextImage)).rgb), mixWeight));
#else
  color = panoramaSrgbEncode(mix(panoramaSrgbDecode(color), panoramaSrgbDecode(panoramaSeamlessSample(nextEquirect, panoramaEquirectUv(nextImage)).rgb), mixWeight));
#endif
#endif
#ifdef NEXT_CUBE
  vec3 nextColor = textureCube(nextCube, panoramaCubeVector(nextImage)).rgb;
#ifdef NEXT_TILES
  nextColor = panoramaTiles(nextTileAtlas, nextTileTable, nextColor, nextImage, nextTileLayout, nextTileAtlasInfo);
#endif
  color = panoramaSrgbEncode(mix(panoramaSrgbDecode(color), panoramaSrgbDecode(nextColor), mixWeight));
#endif
#ifdef OUTPUT_DIRECTION
#ifdef PANORAMA_LEAN
  gl_FragColor = vec4(normalize(imageDirection), 1.0);
#else
  gl_FragColor = vec4(imageDirection, 1.0);
#endif
#else
#ifdef OUTPUT_RAY
#ifdef PANORAMA_LEAN
  gl_FragColor = vec4(normalize(vRay.xyz / vRay.w), 1.0);
#else
  gl_FragColor = vec4(v, 1.0);
#endif
#else
  // The steady view has no crossfade: avoid decoding and encoding every
  // pixel when the encoded sample is already the desired display color.
  gl_FragColor = vec4(color, opacity);
#endif
#endif
}
`;

/** The orb's per-draw constants under PANORAMA_LEAN, set by the renderer from its float64 geometry. */
export const ORB_LEAN_UNIFORMS = ["sinAlpha", "windowGain", "identityWindow"] as const;
/** Immersion's view-to-image matrices under PANORAMA_LEAN. */
export const IMMERSION_LEAN_UNIFORMS = ["imageFromClip", "nextImageFromClip"] as const;
