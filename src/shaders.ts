/** Source sampling/transfer fragment owned here; no shader device is created. */
export const TILE_LOOKUP_WGSL = /* wgsl */ `
#if defined(SOURCE_TILES) || defined(NEXT_TILES) || defined(LEFT_TILES) || defined(RIGHT_TILES)
// A direction in the image's axes: its tiled-cube face, by the format's face
// table, and (u, v) on it, warped equi-angularly when warp > 0.5.
fn sphereTileFace(d: vec3<f32>, warp: f32) -> vec3<f32> {
  let a = abs(d);
  var face: f32;
  var s: f32;
  var t: f32;
  var depth: f32;
  if (a.x >= a.y && a.x >= a.z) {
    face = select(1.0, 0.0, d.x > 0.0);
    s = select(d.y, -d.y, d.x > 0.0);
    t = d.z;
    depth = a.x;
  } else if (a.y >= a.z) {
    face = select(3.0, 2.0, d.y > 0.0);
    s = select(-d.x, d.x, d.y > 0.0);
    t = d.z;
    depth = a.y;
  } else {
    face = select(5.0, 4.0, d.z > 0.0);
    s = d.x;
    t = select(d.y, -d.y, d.z > 0.0);
    depth = a.z;
  }
  var st = vec2<f32>(s, t) / depth;
  if (warp > 0.5) {
    st = atan(st) * 1.2732395447351628;
  }
  return vec3<f32>(face, (st.x + 1.0) * 0.5, (1.0 - st.y) * 0.5);
}

// One display-table entry's tile at (u, v), or the preview where it shows none.
// The tap stays inside the tile's stored texels: its gutter, never a neighbour.
fn sphereTileTap(atlas: texture_2d<f32>, atlasSampler: sampler, entry: vec4<f32>, uv: vec2<f32>, shape: vec4<f32>, atlasSize: vec2<f32>, preview: vec3<f32>) -> vec3<f32> {
  let level = floor(entry.b * 255.0 + 0.5) - 1.0;
  // Rounded: a GPU's exp2 may return 3.9999998 for 4, and the tile would then disagree with the table's cell.
  let n = floor(exp2(max(level, 0.0)) + 0.5);
  let tile = min(floor(uv * n), vec2<f32>(n - 1.0));
  let slot = floor(entry.rg * 255.0 + 0.5);
  let at = slot * shape.w + shape.z + clamp(uv * n - tile, vec2<f32>(0.0), vec2<f32>(1.0)) * shape.y;
  let tiled = textureSampleLevel(atlas, atlasSampler, at / atlasSize, 0.0).rgb;
  return select(tiled, preview, level < 0.0);
}

// A tiled cube's colour in a direction, in linear light: the tile the table
// shows for its cell, faded in over the one it showed before, over the preview.
// shape: cells, tile size, gutter, stored size (not "layout", a reserved word in WGSL and GLSL ES 3.00); info: atlas width and height, warp, outlines.
fn sphereTiles(atlas: texture_2d<f32>, atlasSampler: sampler, table: texture_2d<f32>, tableSampler: sampler, preview: vec3<f32>, imageDirection: vec3<f32>, shape: vec4<f32>, info: vec4<f32>) -> vec3<f32> {
  let place = sphereTileFace(imageDirection, info.z);
  let face = place.x;
  let uv = clamp(place.yz, vec2<f32>(0.0), vec2<f32>(1.0));
  let cells = shape.x;
  let cell = min(floor(uv * cells), vec2<f32>(cells - 1.0));
  let tableSize = vec2<f32>(6.0 * cells, 2.0 * cells);
  let newer = textureSampleLevel(table, tableSampler, (vec2<f32>(face * cells + cell.x, cell.y) + 0.5) / tableSize, 0.0);
  let older = textureSampleLevel(table, tableSampler, (vec2<f32>(face * cells + cell.x, cells + cell.y) + 0.5) / tableSize, 0.0);
  let shown = sphereTileTap(atlas, atlasSampler, newer, uv, shape, info.xy, preview);
  let before = sphereTileTap(atlas, atlasSampler, older, uv, shape, info.xy, preview);
  let color = mix(before, shown, newer.a);
  // Tile outlines: each tile's edges a pixel wide, tinted by its level; the preview red.
  let level = floor(newer.b * 255.0 + 0.5) - 1.0;
  let inTile = uv * floor(exp2(max(level, 0.0)) + 0.5);
  let edge = min(fract(inTile), vec2<f32>(1.0) - fract(inTile)) / max(fwidth(inTile), vec2<f32>(1e-6));
  var tint = vec3<f32>(0.4, 0.75, 1.0);
  if (level < 2.5) { tint = vec3<f32>(0.4, 1.0, 0.5); }
  if (level < 1.5) { tint = vec3<f32>(1.0, 1.0, 0.4); }
  if (level < 0.5) { tint = vec3<f32>(1.0, 0.65, 0.25); }
  if (level < 0.0) { tint = vec3<f32>(1.0, 0.35, 0.35); }
  let outlined = mix(color * tint, vec3<f32>(1.0), step(min(edge.x, edge.y), 1.0) * step(-0.5, level));
  return select(color, outlined, info.w > 0.5);
}
#endif
`;
export const TILE_LOOKUP_GLSL = /* glsl */ `
#if defined(SOURCE_TILES) || defined(NEXT_TILES) || defined(LEFT_TILES) || defined(RIGHT_TILES)
// A direction in the image's axes: its tiled-cube face, by the format's face
// table, and (u, v) on it, warped equi-angularly when warp > 0.5.
vec2 sphereTileFace(vec3 d, float warp, out float face) {
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
vec3 sphereTileTap(sampler2D atlas, vec4 entry, vec2 uv, vec4 shape, vec2 atlasSize, vec3 preview) {
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
vec3 sphereTiles(sampler2D atlas, sampler2D table, vec3 preview, vec3 imageDirection, vec4 shape, vec4 info) {
  float face;
  vec2 uv = clamp(sphereTileFace(imageDirection, info.z, face), 0.0, 1.0);
  float cells = shape.x;
  vec2 cell = min(floor(uv * cells), vec2(cells - 1.0));
  vec2 tableSize = vec2(6.0 * cells, 2.0 * cells);
  vec4 newer = texture2D(table, (vec2(face * cells + cell.x, cell.y) + 0.5) / tableSize);
  vec4 older = texture2D(table, (vec2(face * cells + cell.x, cells + cell.y) + 0.5) / tableSize);
  vec3 color = sphereTileTap(atlas, newer, uv, shape, info.xy, preview);
  if (newer.a < 1.0) {
    vec3 before = sphereTileTap(atlas, older, uv, shape, info.xy, preview);
    color = sphereSrgbEncode(mix(sphereSrgbDecode(before), sphereSrgbDecode(color), newer.a));
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
`;
