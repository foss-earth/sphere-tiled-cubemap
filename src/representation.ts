import { ImageRecordChecker, checkImageRepresentationBase, resolveImageUrl, type ImageRepresentation, type RepresentationValidation, type RepresentationHooks, type ImageEstimate, type ImageFile } from "@foss-earth/images";
import { createCubeTiling, type CubeWarp } from "./cubeTiling.js";
import { tileAtlasLayout } from "./layout.js";
export interface TiledCubeRepresentationRecord extends ImageRepresentation {
  projection: "tiled-cube";
  role: "immersion";
  warp: CubeWarp;
  faceSize: number;
  tileSize: number;
  gutter: number;
  levelBytes: readonly number[];
  url: string;
}
const MOST_TILE_LEVELS = 8;
export function validateTiledCubeRepresentation(value: unknown, context: { path: string; baseUrl: string | null }): RepresentationValidation<TiledCubeRepresentationRecord> {
  const checker = new ImageRecordChecker();
  const { path } = context;
  const record = checker.record(value, path);
  if (!record) return { ok: false, errors: checker.errors };
  checker.keys(record, path, ["id", "role", "projection", "mimeType", "encodedBytes", "extensions", "warp", "faceSize", "tileSize", "gutter", "levelBytes", "url"]);
  checker.oneOf(record.projection, `${path}.projection`, ["tiled-cube"]);
  const common = checkImageRepresentationBase(checker, record, path);
  if (!common) return { ok: false, errors: checker.errors };
  const { id, role, mimeType, encodedBytes } = common;
  let base: URL | null = null;
  try { base = context.baseUrl === null ? null : new URL(context.baseUrl); }
  catch { checker.fail(path, "base URL must be absolute"); }

    if (role === "preview") checker.fail(`${path}.role`, "must be \"immersion\": a tiled cube shows over its asset's preview cube, so it cannot be one");
    const warp = checker.oneOf(record.warp, `${path}.warp`, ["equi-angular", "gnomonic"] as const);
    const tileSize = checker.positiveInteger(record.tileSize, `${path}.tileSize`);
    const faceSize = checker.positiveInteger(record.faceSize, `${path}.faceSize`);
    let gutter: number | null = null;
    if (typeof record.gutter === "number" && Number.isInteger(record.gutter) && record.gutter >= 0 && (tileSize === null || 2 * record.gutter < tileSize)) gutter = record.gutter;
    else checker.fail(`${path}.gutter`, "must be a whole number of texels, at least 0 and less than half the tile size");
    const list = checker.array(record.levelBytes, `${path}.levelBytes`);
    let levelBytes: number[] | null = null;
    if (list) {
      const values = list.map((entry, level) => checker.positiveInteger(entry, `${path}.levelBytes[${level}]`));
      if (list.length === 0 || list.length > MOST_TILE_LEVELS) checker.fail(`${path}.levelBytes`, `must list 1 to ${MOST_TILE_LEVELS} levels`);
      else if (values.every((entry): entry is number => entry !== null)) levelBytes = values;
    }
    if (levelBytes && tileSize && faceSize && faceSize !== tileSize * 2 ** (levelBytes.length - 1)) {
      checker.fail(`${path}.faceSize`, `must be the tile size times 2 to the number of levels less one: ${tileSize * 2 ** (levelBytes.length - 1)}`);
      levelBytes = null;
    }
    if (levelBytes && encodedBytes && levelBytes.reduce((sum, entry) => sum + entry, 0) !== encodedBytes) {
      checker.fail(`${path}.levelBytes`, "must add up to encodedBytes");
      levelBytes = null;
    }
    const url = resolveImageUrl(checker, record.url, `${path}.url`, base);
    if (url && !url.endsWith("/")) checker.fail(`${path}.url`, "must name the tiles' folder, ending with \"/\"");
    if (!id || role !== "immersion" || !mimeType || !encodedBytes || !warp || !tileSize || !faceSize || gutter === null || !levelBytes || !url || !url.endsWith("/")) return { ok: false, errors: checker.errors };
    if (checker.errors.length) return { ok: false, errors: checker.errors };
    return { ok: true, representation: { ...common, role, projection: "tiled-cube", warp, faceSize, tileSize, gutter, levelBytes, url }, warnings: checker.warnings };
  
}

/** Every file of the prepared pyramid, in level/face/row/column order. */
export function* tiledCubeFiles(record: TiledCubeRepresentationRecord): Iterable<ImageFile> {
  for (const file of tiledCubeFilesWithLevel(record)) yield { url: file.url, mimeType: file.mimeType, width: file.width, height: file.height };
}
/** File groups for owner-neutral Node verification; all tiling math stays here. */
export function* tiledCubeFilesWithLevel(record: TiledCubeRepresentationRecord): Iterable<ImageFile & { level: number; fieldPath: string }> {
  const tiling = createCubeTiling({ warp: record.warp, tileSize: record.tileSize, maxLevel: record.levelBytes.length - 1, gutter: record.gutter });
  const extension = record.mimeType === "image/png" ? "png" : "jpg";
  for (let tile = 0; tile < tiling.count; tile++) {
    const name = `${tiling.path(tile)}.${extension}`;
    yield { level: tiling.level(tile), fieldPath: `.tiles[${name}]`, url: `${record.url}${name}`, mimeType: record.mimeType, width: tiling.stored, height: tiling.stored };
  }
}
/** Host-visible tile policy; no hidden package memory/default scheduling preset. */
export interface TiledResourceParameters {
  tileMemoryBytes: number;
  responseBytes: number;
  requests: number;
  waiting: number;
  /** Maximum bytes of outstanding upload tickets accepted by the supplied renderer adapter. */
  uploadOutstandingBytes: number;
}
export function estimateTiledCube(record: TiledCubeRepresentationRecord, context: TiledResourceParameters & { maxTextureSide: number }): ImageEstimate {
  for (const key of ["tileMemoryBytes", "responseBytes", "requests", "waiting", "uploadOutstandingBytes"] as const) {
    if (!Number.isFinite(context[key]) || context[key] < 0) throw new RangeError(`${key} must be a finite nonnegative limit.`);
  }
  if (!Number.isInteger(context.requests) || !Number.isInteger(context.waiting)) throw new RangeError("Tile queue counts must be whole numbers.");
  const layout = tileAtlasLayout(record, context.tileMemoryBytes, context.maxTextureSide);
  if (!layout || 6 * record.faceSize / record.tileSize > context.maxTextureSide) throw new RangeError("Tiled atlas/display table exceeds supplied device or memory limits.");
  const tileBytes = 4 * layout.stored ** 2;
  return {
    // Pending work can exceed waiting by requests already in flight. Stream
    // assembly additionally holds a contiguous copy for each active request.
    encoded: (context.waiting + 2 * context.requests) * context.responseBytes,
    decoded: (context.waiting + context.requests) * tileBytes,
    sourceGpu: layout.gpuBytes,
    uploadOutstanding: context.uploadOutstandingBytes,
  };
}
/** The viewer supplies its current tile policy on every estimate. */
export function createTiledCubeRepresentation(parameters: () => TiledResourceParameters): RepresentationHooks<TiledCubeRepresentationRecord> {
  return { projection: "tiled-cube", validate: validateTiledCubeRepresentation, files: tiledCubeFiles,
    filePath: (record, file) => `.tiles[${file.url.slice(record.url.length)}]`,
    estimate: (record, context) => estimateTiledCube(record, { ...parameters(), ...context }) };
}
