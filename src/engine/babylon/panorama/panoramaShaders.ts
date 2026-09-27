/**
 * WGSL for panorama orbs and immersion (docs/proposals/panorama-scenes.md §3).
 *
 * Positions are relative to the camera's eye, computed on the CPU in float64,
 * so no uniform is named world/view/viewProjection and Babylon's floating
 * origin leaves them alone. `viewRotProj` is the camera's rotation times its
 * projection, the same matrices the globe is drawn with this frame.
 *
 * The orb's window is the flat (rectilinear) window of panoramaMath.ts:
 * for a covered ray v with cap half-angle α < βR it shows
 * D ∝ a + (tan βR / tan α)(v − (a·v)a)/(a·v), and v itself once α ≥ βR.
 * Content is then rotated from ECEF into the image's frame, and the cube is
 * sampled with (x, z, y): the format's faces are WebGPU's with Y and Z
 * exchanged (GPU_LAYER_SOURCE_FACES).
 *
 * An outline, when there is one, is a ring `outlineWidth` rendered pixels
 * wide just outside the silhouette, measured along the gradient of sin δ;
 * the probes' outputs leave it out, so they cover the image alone.
 *
 * Every texture is sampled once, outside any branch, so derivatives are
 * taken in uniform control flow from rays that are all finite. Textures are
 * rgba8unorm-srgb, so samples arrive in linear light; blending between two
 * sources happens there, and the one conversion back to sRGB is at output.
 */

/** Shared WGSL: the window mapping and the sRGB encoding. */
const COMMON = /* wgsl */ `
fn panoramaSrgbEncode(linear: vec3<f32>) -> vec3<f32> {
  let c = clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3<f32>(0.0031308));
}

fn panoramaImageDirection(world: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(uniforms.content0, world), dot(uniforms.content1, world), dot(uniforms.content2, world));
}

fn panoramaCubeVector(image: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(image.x, image.z, image.y);
}

fn panoramaEquirectUv(image: vec3<f32>) -> vec2<f32> {
  let d = normalize(image);
  return vec2<f32>(atan2(d.x, d.y) / 6.283185307179586 + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.141592653589793);
}
`;

const CONTENT_UNIFORMS = `
uniform content0 : vec3<f32>;
uniform content1 : vec3<f32>;
uniform content2 : vec3<f32>;
`;

/** The orb: a quad perpendicular to the camera-to-marker axis, or covering the view near and inside the sphere. */
export const ORB_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform viewRotProj : mat4x4<f32>;
uniform quadCenter : vec3<f32>;
uniform quadU : vec3<f32>;
uniform quadV : vec3<f32>;
varying vRel : vec3<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let rel = uniforms.quadCenter + vertexInputs.position.x * uniforms.quadU + vertexInputs.position.y * uniforms.quadV;
  vertexOutputs.vRel = rel;
  vertexOutputs.position = uniforms.viewRotProj * vec4<f32>(rel, 1.0);
}
`;

export const ORB_FRAGMENT = /* wgsl */ `
uniform viewRotProj : mat4x4<f32>;
uniform markerRel : vec3<f32>;
uniform radius : f32;
uniform tanPreviewHalfAngle : f32;
uniform opacity : f32;
uniform outlineColor : vec4<f32>;
uniform outlineWidth : f32;
${CONTENT_UNIFORMS}
var panoramaCube : texture_cube<f32>;
var panoramaCubeSampler : sampler;
varying vRel : vec3<f32>;
${COMMON}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let v = normalize(fragmentInputs.vRel);
  let d = length(uniforms.markerRel);
  let a = uniforms.markerRel / d;
  let c = dot(a, v);
  let k = v - c * a;
  let sinDelta = length(k);
  let radius = uniforms.radius;
  let inside = d <= radius;
  let sinAlpha = min(radius / d, 1.0);
  let cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  let tanAlpha = sinAlpha / max(cosAlpha, 1e-7);

  // Coverage: the cap sin δ < sin α on the near side, with a one-pixel edge.
  let edge = sinAlpha - sinDelta;
  let edgeWidth = max(fwidth(sinDelta), 1e-7);
  let front = select(0.0, 1.0, c > 0.0);
  let exterior = clamp(edge / edgeWidth + 0.5, 0.0, 1.0) * front;
  let coverage = select(exterior, 1.0, inside);
  // The outline's share of the pixel: out to its width beyond the edge, none from inside.
  let pixelStep = max(length(vec2<f32>(dpdx(sinDelta), dpdy(sinDelta))), 1e-9);
  let ringOuter = clamp(edge / pixelStep + uniforms.outlineWidth + 0.5, 0.0, 1.0) * front;
  let ring = select(max(ringOuter - exterior, 0.0), 0.0, inside) * uniforms.outlineColor.a;

  // The flat window; identity inside and once α ≥ βR. Finite for every ray.
  let gain = uniforms.tanPreviewHalfAngle / max(tanAlpha, 1e-7);
  let windowed = normalize(a + k * (gain / max(c, 1e-4)));
  let identity = inside || tanAlpha >= uniforms.tanPreviewHalfAngle;
  let world = select(windowed, v, identity);
  let image = panoramaImageDirection(world);
  let sampled = textureSample(panoramaCube, panoramaCubeSampler, panoramaCubeVector(image));

  // Depth where the ray meets the sphere: the near side from outside, the far side inside.
  let b = c * d;
  let root = sqrt(max(radius * radius - d * d + b * b, 0.0));
  let t = select(b - root, b + root, inside);
  let clip = uniforms.viewRotProj * vec4<f32>(v * max(t, 0.0), 1.0);

#ifdef OUTPUT_DIRECTION
  if (coverage <= 0.0) {
    discard;
  }
  fragmentOutputs.color = vec4<f32>(image, coverage);
#else
#ifdef OUTPUT_RAY
  if (coverage <= 0.0) {
    discard;
  }
  fragmentOutputs.color = vec4<f32>(v, coverage);
#else
  let shown = coverage + ring;
  if (shown <= 0.0) {
    discard;
  }
  let rgb = (panoramaSrgbEncode(sampled.rgb) * coverage + uniforms.outlineColor.rgb * ring) / shown;
  fragmentOutputs.color = vec4<f32>(rgb, shown * uniforms.opacity);
#endif
#endif
  fragmentOutputs.fragDepth = clamp(clip.z / clip.w, 0.0, 1.0);
}
`;

/**
 * Immersion: one triangle covering the view. `inverseViewRotProj` turns the
 * clip-space corner into an eye-relative direction, interpolated
 * projectively and normalized per fragment. The first source is the current
 * image; the second, weighted by `mixWeight`, the incoming one.
 */
export const IMMERSION_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform inverseViewRotProj : mat4x4<f32>;
varying vRay : vec4<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let clip = vec4<f32>(vertexInputs.position.xy, 0.5, 1.0);
  vertexOutputs.vRay = uniforms.inverseViewRotProj * clip;
  vertexOutputs.position = clip;
}
`;

export const IMMERSION_FRAGMENT = /* wgsl */ `
uniform inverseViewRotProj : mat4x4<f32>;
uniform opacity : f32;
uniform mixWeight : f32;
${CONTENT_UNIFORMS}
uniform nextContent0 : vec3<f32>;
uniform nextContent1 : vec3<f32>;
uniform nextContent2 : vec3<f32>;
#ifdef SOURCE_EQUIRECT
var panoramaEquirect : texture_2d<f32>;
var panoramaEquirectSampler : sampler;
#else
var panoramaCube : texture_cube<f32>;
var panoramaCubeSampler : sampler;
#endif
#ifdef NEXT_EQUIRECT
var nextEquirect : texture_2d<f32>;
var nextEquirectSampler : sampler;
#endif
#ifdef NEXT_CUBE
var nextCube : texture_cube<f32>;
var nextCubeSampler : sampler;
#endif
varying vRay : vec4<f32>;
${COMMON}

// Gradients across the longitude seam: of u and of u shifted by half a
// turn, whichever is smaller, so the seam does not drop to the coarsest mip.
fn panoramaSeamlessSample(tex: texture_2d<f32>, samp: sampler, uv: vec2<f32>) -> vec4<f32> {
  let shifted = fract(uv.x + 0.5);
  let dx = vec2<f32>(select(dpdx(shifted), dpdx(uv.x), abs(dpdx(uv.x)) <= abs(dpdx(shifted))), dpdx(uv.y));
  let dy = vec2<f32>(select(dpdy(shifted), dpdy(uv.x), abs(dpdy(uv.x)) <= abs(dpdy(shifted))), dpdy(uv.y));
  return textureSampleGrad(tex, samp, uv, dx, dy);
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let v = normalize(fragmentInputs.vRay.xyz / fragmentInputs.vRay.w);
  let image = panoramaImageDirection(v);
#ifdef SOURCE_EQUIRECT
  var color = panoramaSeamlessSample(panoramaEquirect, panoramaEquirectSampler, panoramaEquirectUv(image)).rgb;
#else
  var color = textureSample(panoramaCube, panoramaCubeSampler, panoramaCubeVector(image)).rgb;
#endif
  let nextImage = vec3<f32>(dot(uniforms.nextContent0, v), dot(uniforms.nextContent1, v), dot(uniforms.nextContent2, v));
#ifdef NEXT_EQUIRECT
  color = mix(color, panoramaSeamlessSample(nextEquirect, nextEquirectSampler, panoramaEquirectUv(nextImage)).rgb, uniforms.mixWeight);
#endif
#ifdef NEXT_CUBE
  color = mix(color, textureSample(nextCube, nextCubeSampler, panoramaCubeVector(nextImage)).rgb, uniforms.mixWeight);
#endif
#ifdef OUTPUT_DIRECTION
  fragmentOutputs.color = vec4<f32>(image, 1.0);
#else
#ifdef OUTPUT_RAY
  fragmentOutputs.color = vec4<f32>(v, 1.0);
#else
  fragmentOutputs.color = vec4<f32>(panoramaSrgbEncode(color), uniforms.opacity);
#endif
#endif
}
`;

export const ORB_UNIFORMS = ["viewRotProj", "quadCenter", "quadU", "quadV", "markerRel", "radius", "tanPreviewHalfAngle", "opacity", "outlineColor", "outlineWidth", "content0", "content1", "content2"] as const;
export const IMMERSION_UNIFORMS = ["inverseViewRotProj", "opacity", "mixWeight", "content0", "content1", "content2", "nextContent0", "nextContent1", "nextContent2"] as const;
