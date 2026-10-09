import type { TiledCubeRepresentationRecord } from "./representation.js";
const BYTES_PER_TEXEL = 4;
export interface TileAtlasLayout {
  stored: number;
  slots: number;
  perRow: number;
  width: number;
  height: number;
  /** Exact bytes: the atlas, without mips, and the display table. */
  gpuBytes: number;
}

/** Slot columns and rows are table bytes. */
const MOST_SLOTS_A_SIDE = 255;

export function tileAtlasLayout(representation: Pick<TiledCubeRepresentationRecord, "tileSize" | "gutter" | "faceSize">, memoryBytes: number, maxTextureSide = Number.POSITIVE_INFINITY): TileAtlasLayout | null {
  validateGrid(representation);
  if (!Number.isFinite(memoryBytes) || memoryBytes < 0 || !(maxTextureSide === Number.POSITIVE_INFINITY || Number.isSafeInteger(maxTextureSide) && maxTextureSide > 0)) throw new RangeError("Atlas limits must be nonnegative finite bytes and a positive texture side.");
  if (!Number.isSafeInteger(representation.gutter) || representation.gutter < 0 || 2 * representation.gutter >= representation.tileSize) throw new RangeError("Tile gutter must be a whole number below half the tile size.");
  const stored = representation.tileSize + 2 * representation.gutter;
  const tileBytes = BYTES_PER_TEXEL * stored * stored;
  const aSide = Math.min(MOST_SLOTS_A_SIDE, Math.floor(maxTextureSide / stored));
  // A slot for every tile of every level is all a cube can use: then nothing is ever evicted.
  const wanted = Math.min(Math.floor(memoryBytes / tileBytes), tiledCubeTileCount(representation));
  if (aSide < 1 || wanted < 1) return null;
  const perRow = Math.min(aSide, Math.ceil(Math.sqrt(wanted)));
  const rows = Math.min(aSide, Math.ceil(wanted / perRow));
  const slots = Math.min(wanted, perRow * rows);
  const cells = representation.faceSize / representation.tileSize;
  const tableBytes = BYTES_PER_TEXEL * 6 * cells * 2 * cells;
  return { stored, slots, perRow, width: perRow * stored, height: rows * stored, gpuBytes: BYTES_PER_TEXEL * perRow * stored * rows * stored + tableBytes };
}

/** A tiled cube's tile count: 6 · Σ 4^level, over the levels from one tile a face to `faceSize`. */
export function tiledCubeTileCount(representation: Pick<TiledCubeRepresentationRecord, "tileSize" | "faceSize">): number {
  validateGrid(representation);
  let count = 0;
  for (let cells = representation.faceSize / representation.tileSize; cells >= 1; cells /= 2) count += 6 * cells * cells;
  return count;
}
function validateGrid(representation: Pick<TiledCubeRepresentationRecord, "tileSize" | "faceSize">): void {
  const cells = representation.faceSize / representation.tileSize;
  if (![representation.tileSize, representation.faceSize, cells].every(value => Number.isSafeInteger(value) && value > 0) || cells > 128 || (cells & (cells - 1)) !== 0) throw new RangeError("A tiled face must have one to eight complete power-of-two levels.");
}
