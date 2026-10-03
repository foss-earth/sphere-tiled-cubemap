/**
 * The geometry of a tiled cube (docs/scenes/format.md, "Tiled cubes"): the
 * format's six faces, each a quadtree of square tiles, with the face position
 * warped equi-angularly or gnomonically. Selection and scheduling see a
 * tiling only through integer tile ids, so nothing outside this file knows
 * there are faces or warps.
 *
 * On a face, u runs along its right axis and v down its top axis, both 0–1;
 * texel (i, j) of an F-texel face is centred at ((i + ½)/F, (j + ½)/F). A
 * face position s in −1…1 is the direction f + w(s)·r (and the same for t),
 * where w(s) = tan(s·π/4) for the equi-angular warp and w(s) = s for the
 * gnomonic one. Level l has 2^l × 2^l tiles a face of `tileSize` logical
 * texels; a stored tile carries `gutter` more on every side, sampled at the
 * face's own coordinates continued past its edge. Ids run level by level,
 * then face, row and column.
 */
import { CUBE_FACE_NAMES, SOURCE_CUBE_FACES, type Vec3 } from "../panoramaMath";

export type CubeWarp = "equi-angular" | "gnomonic";

export interface TileAddress {
  face: number;
  level: number;
  x: number;
  y: number;
}

export interface CubeTiling {
  readonly warp: CubeWarp;
  readonly tileSize: number;
  readonly gutter: number;
  /** A stored tile's side: the logical texels and a gutter on each side. */
  readonly stored: number;
  readonly maxLevel: number;
  /** Tiles in the whole pyramid. */
  readonly count: number;
  /** Tiles along a face side at the finest level: the display table's cells. */
  readonly cells: number;
  faceSize(level: number): number;
  firstOfLevel(level: number): number;
  levelCount(level: number): number;
  id(face: number, level: number, x: number, y: number): number;
  level(id: number): number;
  address(id: number): TileAddress;
  /** −1 for a level-0 tile. */
  parent(id: number): number;
  children(id: number): number[];
  /** The tile itself, or its ancestor at a coarser level. */
  ancestor(id: number, level: number): number;
  /** A unit direction → `out = [face, u, v]`. */
  locate(x: number, y: number, z: number, out: number[]): number[];
  /** `(face, u, v)` → a unit direction; u and v may lie a little outside 0–1, in the gutter. */
  direction(face: number, u: number, v: number, out: number[]): number[];
  tileAt(x: number, y: number, z: number, level: number): number;
  /**
   * The angle, radians, one level-0 texel subtends at (face, u, v): the
   * larger of its two sides, so a level chosen from it is never too coarse
   * along either axis. Level l's texel is 2^l times smaller.
   */
  texelAngle(face: number, u: number, v: number): number;
  /** A tile's corners in order round it; its edges are great-circle arcs under both warps. */
  corners(id: number): Vec3[];
  centre(id: number, out: number[]): number[];
  /** `<face>/<level>/<x>/<y>`, the format's tile address without its extension. */
  path(id: number): string;
}

const FACES = CUBE_FACE_NAMES.map(name => SOURCE_CUBE_FACES[name]);
const QUARTER_PI = Math.PI / 4;

export function createCubeTiling(options: { warp: CubeWarp; tileSize: number; maxLevel: number; gutter: number }): CubeTiling {
  const { warp, tileSize, maxLevel, gutter } = options;
  if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > 7) throw new Error(`A tiled cube has levels 0 to 7; ${maxLevel} is not one.`);
  const roots = FACES.length;
  const offsets = [0];
  for (let level = 0; level <= maxLevel; level++) offsets.push(offsets[level] + roots * 4 ** level);
  const count = offsets[maxLevel + 1];
  const levelOf = new Uint8Array(count);
  for (let level = 0; level <= maxLevel; level++) levelOf.fill(level, offsets[level], offsets[level + 1]);
  const equiAngular = warp === "equi-angular";
  const scratch = [0, 0, 0];
  const a = [0, 0, 0];
  const b = [0, 0, 0];

  function direction(face: number, u: number, v: number, out: number[]): number[] {
    let s = 2 * u - 1;
    let t = 1 - 2 * v;
    if (equiAngular) { s = Math.tan(s * QUARTER_PI); t = Math.tan(t * QUARTER_PI); }
    const { f, r, t: up } = FACES[face];
    const x = f[0] + s * r[0] + t * up[0];
    const y = f[1] + s * r[1] + t * up[1];
    const z = f[2] + s * r[2] + t * up[2];
    const n = 1 / Math.sqrt(x * x + y * y + z * z);
    out[0] = x * n; out[1] = y * n; out[2] = z * n;
    return out;
  }

  function locate(x: number, y: number, z: number, out: number[]): number[] {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    const face = ax >= ay && ax >= az ? (x > 0 ? 0 : 1) : ay >= az ? (y > 0 ? 2 : 3) : (z > 0 ? 4 : 5);
    const { f, r, t } = FACES[face];
    const depth = x * f[0] + y * f[1] + z * f[2];
    let s = (x * r[0] + y * r[1] + z * r[2]) / depth;
    let q = (x * t[0] + y * t[1] + z * t[2]) / depth;
    if (equiAngular) { s = Math.atan(s) / QUARTER_PI; q = Math.atan(q) / QUARTER_PI; }
    out[0] = face; out[1] = (s + 1) / 2; out[2] = (1 - q) / 2;
    return out;
  }

  const tiling: CubeTiling = {
    warp, tileSize, gutter, stored: tileSize + 2 * gutter, maxLevel, count,
    cells: 1 << maxLevel,
    faceSize: level => tileSize << level,
    firstOfLevel: level => offsets[level],
    levelCount: level => roots * 4 ** level,
    id: (face, level, x, y) => offsets[level] + (((face << level) + y) << level) + x,
    level: id => levelOf[id],
    address(id) {
      const level = levelOf[id];
      const n = 1 << level;
      const local = id - offsets[level];
      return { face: Math.floor(local / (n * n)), level, x: local % n, y: Math.floor(local / n) % n };
    },
    parent(id) {
      const level = levelOf[id];
      if (level === 0) return -1;
      const { face, x, y } = tiling.address(id);
      return tiling.id(face, level - 1, x >> 1, y >> 1);
    },
    children(id) {
      const level = levelOf[id];
      if (level === maxLevel) return [];
      const { face, x, y } = tiling.address(id);
      return [0, 1, 2, 3].map(k => tiling.id(face, level + 1, 2 * x + (k & 1), 2 * y + (k >> 1)));
    },
    ancestor(id, level) {
      const { face, level: own, x, y } = tiling.address(id);
      const shift = own - level;
      return tiling.id(face, level, x >> shift, y >> shift);
    },
    locate: (x, y, z, out) => locate(x, y, z, out),
    direction,
    tileAt(x, y, z, level) {
      locate(x, y, z, scratch);
      const n = 1 << level;
      return tiling.id(scratch[0], level, Math.min(n - 1, Math.floor(scratch[1] * n)), Math.min(n - 1, Math.floor(scratch[2] * n)));
    },
    texelAngle(face, u, v) {
      // A quarter texel either side, measured as a chord: at this size the chord is the angle.
      const step = 1 / (tileSize * 8);
      direction(face, u - step, v, a); direction(face, u + step, v, b);
      const alongU = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      direction(face, u, v - step, a); direction(face, u, v + step, b);
      const alongV = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return Math.max(alongU, alongV) * 4;
    },
    corners(id) {
      const { face, level, x, y } = tiling.address(id);
      const n = 1 << level;
      return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([cx, cy]) => {
        const corner = direction(face, cx / n, cy / n, [0, 0, 0]);
        return [corner[0], corner[1], corner[2]] as const;
      });
    },
    centre(id, out) {
      const { face, level, x, y } = tiling.address(id);
      const n = 1 << level;
      return direction(face, (x + 0.5) / n, (y + 0.5) / n, out);
    },
    path(id) {
      const { face, level, x, y } = tiling.address(id);
      return `${CUBE_FACE_NAMES[face]}/${level}/${x}/${y}`;
    },
  };
  return tiling;
}
