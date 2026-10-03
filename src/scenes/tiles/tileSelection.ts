/**
 * Which tiles of a tiled cube a view needs, and at what level: geometry only.
 *
 * **Coverage is exact.** A tile's outline and the view's are both made of
 * great-circle arcs, so whether they overlap is decided exactly
 * (sphericalRegions.ts), from the six faces down the quadtree to the finest
 * level's tiles, the cells.
 *
 * **Level.** A pixel's angle is taken along the radius of the image, where a
 * perspective pixel is smallest: pitch / (1 + r²). A texel's angle is the
 * larger of its two sides (CubeTiling.texelAngle). A cell gets the coarsest
 * level whose texel is no larger than a pixel divided by `texelsPerPixel`,
 * from scout rays on a grid over the image plane: each ray asks for a level,
 * and a cell takes the finest any of its rays asked for, or what its own
 * middle needs when no ray landed in it. The level is therefore approximate
 * and coverage is not; the number of rays in a tile is also its share of the
 * view, which ranks requests.
 *
 * **Margin.** `marginDeg` widens the view on every side. Tiles only the margin
 * touches are returned apart, so a scheduler ranks them below the view.
 */
import type { Vec3 } from "../panoramaMath";
import type { CubeTiling } from "./cubeTiling";
import { regionsOverlap, sphericalRegion } from "./sphericalRegions";

/** A view in the image's own axes: X right, Y forward, Z up. */
export interface TileView {
  /** Unit vectors of the camera. */
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** Half the image plane's width and height at distance 1. */
  tanHalfWidth: number;
  tanHalfHeight: number;
  /** Pixels drawn across the view's height. */
  heightPx: number;
}

export interface TileSelectionParameters {
  /** Image texels per drawn pixel the level aims for; 1 shows no texel wider than a pixel where a finer level exists. */
  texelsPerPixel: number;
  marginDeg: number;
  /** The finest level that may be asked for. */
  levelCap: number;
}

export interface TileSelection {
  key: string;
  /** The level each cell needs; −1 outside the view and its margin. */
  cells: Int8Array;
  /** 1 where the view itself, not just its margin, touches the cell. */
  inView: Uint8Array;
  /** Tiles the view needs, each with its scout rays: its share of the view. */
  visible: ReadonlyMap<number, number>;
  /** Tiles only the margin touches. */
  margin: ReadonlyMap<number, number>;
  centre: Vec3;
  levelCap: number;
}

/** The scout rays' spacing, as a share of the narrowest finest tile: two rays a tile at least. */
const SCOUT_FRACTION = 0.5;
/** A margin never widens a half view past this, where the image plane would run to infinity. */
const WIDEST_HALF_VIEW_RAD = (89 * Math.PI) / 180;
/** Digits a view's vectors are compared to: a change below this asks for the same tiles. */
const KEY_DIGITS = 5;

/** The narrowest edge of any finest tile, radians; the six faces are alike, so one is measured. */
function narrowestTile(tiling: CubeTiling): number {
  const n = tiling.cells;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  let narrowest = Number.POSITIVE_INFINITY;
  const edge = (u0: number, v0: number, u1: number, v1: number): void => {
    tiling.direction(0, u0, v0, a);
    tiling.direction(0, u1, v1, b);
    narrowest = Math.min(narrowest, 2 * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2)));
  };
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    if (x < n) edge(x / n, y / n, (x + 1) / n, y / n);
    if (y < n) edge(x / n, y / n, x / n, (y + 1) / n);
  }
  return narrowest;
}

export interface TileSelector {
  select(view: TileView, parameters: TileSelectionParameters): TileSelection;
  /**
   * The selection when only `capacity` tiles can be held under the view: the
   * level cap drops until the view's tiles fit, so a short budget costs detail
   * everywhere at once and never leaves part of the view without its tiles.
   */
  selectWithin(view: TileView, parameters: TileSelectionParameters, capacity: number): TileSelection;
}

export function createTileSelector(tiling: CubeTiling): TileSelector {
  const C = tiling.cells;
  const cellCount = 6 * C * C;
  const spacing = narrowestTile(tiling) * SCOUT_FRACTION;
  const place = [0, 0, 0];
  const centre = [0, 0, 0];
  let cached: TileSelection | null = null;

  function select(view: TileView, parameters: TileSelectionParameters): TileSelection {
    const levelCap = Math.max(0, Math.min(tiling.maxLevel, Math.floor(parameters.levelCap)));
    const vector = (v: Vec3) => v.map(value => value.toFixed(KEY_DIGITS)).join(",");
    const key = `${vector(view.forward)}/${vector(view.right)}/${vector(view.up)}/${view.tanHalfWidth.toFixed(KEY_DIGITS)}/${view.tanHalfHeight.toFixed(KEY_DIGITS)}/${view.heightPx}/${parameters.texelsPerPixel}/${parameters.marginDeg}/${levelCap}`;
    if (cached?.key === key) return cached;
    const { forward, right, up, tanHalfWidth: tanH, tanHalfHeight: tanV } = view;
    const pixel = (2 * tanV) / Math.max(1, view.heightPx);
    const ray = (a: number, b: number): Vec3 => {
      const x = forward[0] + a * right[0] + b * up[0];
      const y = forward[1] + a * right[1] + b * up[1];
      const z = forward[2] + a * right[2] + b * up[2];
      const n = Math.hypot(x, y, z);
      return [x / n, y / n, z / n];
    };
    const outline = (h: number, v: number) => sphericalRegion([ray(-h, v), ray(h, v), ray(h, -v), ray(-h, -v)]);
    // The margin is an angle, so the plane grows by more than it near a wide view's edge.
    const widen = (half: number) => Math.tan(Math.min(WIDEST_HALF_VIEW_RAD, Math.atan(half) + (parameters.marginDeg * Math.PI) / 180));
    const inner = outline(tanH, tanV);
    const wide = parameters.marginDeg > 0 ? outline(widen(tanH), widen(tanV)) : inner;
    const density = Math.max(1e-6, parameters.texelsPerPixel);
    const levelAt = (face: number, u: number, v: number, a: number, b: number): number =>
      Math.max(0, Math.min(levelCap, Math.ceil(Math.log2((tiling.texelAngle(face, u, v) * density) / (pixel / (1 + a * a + b * b))))));

    const cells = new Int8Array(cellCount).fill(-1);
    const inView = new Uint8Array(cellCount);
    const rays = new Uint16Array(cellCount);
    const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
    // Coverage, exactly: down the quadtree, keeping every tile whose outline overlaps the view's.
    const descend = (tile: number, insideView: boolean): void => {
      const shape = sphericalRegion(tiling.corners(tile));
      if (!regionsOverlap(shape, wide)) return;
      const seen = insideView && regionsOverlap(shape, inner);
      if (tiling.level(tile) < tiling.maxLevel) {
        for (const child of tiling.children(tile)) descend(child, seen);
        return;
      }
      const { face, x, y } = tiling.address(tile);
      const cell = (face * C + y) * C + x;
      inView[cell] = seen ? 1 : 0;
      // What the cell's middle needs, judged at the nearest point of the view when the middle is outside it.
      tiling.centre(tile, place);
      const depth = place[0] * forward[0] + place[1] * forward[1] + place[2] * forward[2];
      const a = depth > 1e-6 ? clamp((place[0] * right[0] + place[1] * right[1] + place[2] * right[2]) / depth, tanH) : tanH;
      const b = depth > 1e-6 ? clamp((place[0] * up[0] + place[1] * up[1] + place[2] * up[2]) / depth, tanV) : tanV;
      cells[cell] = levelAt(face, (x + 0.5) / C, (y + 0.5) / C, a, b);
    };
    for (let face = 0; face < 6; face++) descend(tiling.id(face, 0, 0, 0), true);

    // Levels and shares of the view, from scout rays.
    const columns = Math.max(2, Math.ceil((2 * tanH) / spacing) + 1);
    const rows = Math.max(2, Math.ceil((2 * tanV) / spacing) + 1);
    for (let j = 0; j < rows; j++) {
      const b = tanV - (2 * tanV * j) / (rows - 1);
      for (let i = 0; i < columns; i++) {
        const a = -tanH + (2 * tanH * i) / (columns - 1);
        const d = ray(a, b);
        tiling.locate(d[0], d[1], d[2], place);
        const cx = Math.min(C - 1, Math.floor(place[1] * C));
        const cy = Math.min(C - 1, Math.floor(place[2] * C));
        const cell = (place[0] * C + cy) * C + cx;
        const level = levelAt(place[0], place[1], place[2], a, b);
        if (level > cells[cell]) cells[cell] = level;
        inView[cell] = 1;
        rays[cell] += 1;
      }
    }
    const visible = new Map<number, number>();
    const margin = new Map<number, number>();
    for (let cell = 0; cell < cellCount; cell++) {
      if (cells[cell] < 0) continue;
      const face = Math.floor(cell / (C * C));
      const shift = tiling.maxLevel - cells[cell];
      const tile = tiling.id(face, cells[cell], (cell % C) >> shift, (Math.floor(cell / C) % C) >> shift);
      if (inView[cell]) visible.set(tile, (visible.get(tile) ?? 0) + rays[cell]);
      else margin.set(tile, 0);
    }
    for (const tile of visible.keys()) margin.delete(tile);
    centre[0] = forward[0]; centre[1] = forward[1]; centre[2] = forward[2];
    cached = { key, cells, inView, visible, margin, centre: [centre[0], centre[1], centre[2]], levelCap };
    return cached;
  }

  return {
    select,
    selectWithin(view, parameters, capacity) {
      let cap = Math.max(0, Math.min(tiling.maxLevel, Math.floor(parameters.levelCap)));
      let selection = select(view, { ...parameters, levelCap: cap });
      while (selection.visible.size > capacity && cap > 0) selection = select(view, { ...parameters, levelCap: --cap });
      return selection;
    },
  };
}

/** The tile of `level` under each pixel of a view, every `stride` pixels: the independent check of a selection. */
export function tilesUnderPixels(tiling: CubeTiling, view: TileView, widthPx: number, level: number, stride = 1): Set<number> {
  const { forward, right, up, tanHalfWidth: tanH, tanHalfHeight: tanV, heightPx } = view;
  const found = new Set<number>();
  for (let py = 0; py < heightPx; py += stride) {
    const b = (1 - (2 * (py + 0.5)) / heightPx) * tanV;
    for (let px = 0; px < widthPx; px += stride) {
      const a = ((2 * (px + 0.5)) / widthPx - 1) * tanH;
      const x = forward[0] + a * right[0] + b * up[0];
      const y = forward[1] + a * right[1] + b * up[1];
      const z = forward[2] + a * right[2] + b * up[2];
      const n = Math.hypot(x, y, z);
      found.add(tiling.tileAt(x / n, y / n, z / n, level));
    }
  }
  return found;
}
