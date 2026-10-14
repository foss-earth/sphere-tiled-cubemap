/** Scheduler joined to common acquisition/decode and supplied atlas. */
import type { ImageFile, ImageOperationScope, ImageSessionBroker } from "@foss-earth/images";
import type { EncodedImageFile, HeldDecodedImage } from "@foss-earth/images/browser";
import { createCubeTiling, type CubeTiling } from "../cubeTiling.js";
import { createTileScheduler, type TileSchedulerLimits, type TileSchedulerStats } from "../tileScheduler.js";
import type { TileView, TileSelectionParameters } from "../tileSelection.js";
import type { TileAtlasLayout } from "../layout.js";
import type { TiledCubeRepresentationRecord } from "../representation.js";

export interface TiledSphereAtlas<Image = ImageBitmap> {
  /** Capture input synchronously before returning, including a throwing partial copy.
   * Deferred adapters must own a separate input hold; retaining the upload charge alone is insufficient.
   */
  uploadTile(slot: number, image: Image): boolean | void;
  /** Capture the mutable table bytes synchronously before returning. */
  setTable(bytes: Uint8Array): boolean | void;
  /** Required when a table write can refuse; omission preserves non-refusing legacy adapters. */
  beginUpdate?(): boolean;
  endUpdate?(): void;
  /** Optional completion pump, called through the same host frame. */
  pump?(): void;
  dispose(): void;
}
export interface TiledSphere {
  readonly representation: TiledCubeRepresentationRecord;
  readonly tiling: CubeTiling;
  readonly layout: TileAtlasLayout;
  tick(now: number, view: TileView, parameters: TileSelectionParameters): boolean;
  setLimits(limits: TileSchedulerLimits): void;
  stats(): TileSchedulerStats & { reusedTiles: number; reusedBytes: number };
  settleReplacement(): void;
  dispose(): void;
}
export interface TiledSphereOptions {
  representation: TiledCubeRepresentationRecord;
  layout: TileAtlasLayout;
  broker: ImageSessionBroker;
  /** Dedicated operation owns atlas residency and requests, not submitted upload tickets. */
  scope: ImageOperationScope;
  overlap?: boolean;
  createAtlas(layout: TileAtlasLayout, cells: number): TiledSphereAtlas;
  /** Cache/header/transport policy lives in images; scope identifies this tile. */
  obtain(file: ImageFile, declaredBytes: number, scope: ImageOperationScope, onChunk: (bytes: number) => void, priority?: number): Promise<EncodedImageFile & { fromCache?: boolean }>;
  decode(file: EncodedImageFile, declared: ImageFile, scope: ImageOperationScope, priority?: number): Promise<HeldDecodedImage>;
  /** Forward this source's priority to the host's common acquisition/decode queue. */
  priority?: number;
  limits: TileSchedulerLimits;
  wake(): void;
}
export function createTiledSphere(options: TiledSphereOptions): TiledSphere {
  const { representation, layout, scope, broker } = options;
  scope.signal.throwIfAborted();
  const tiling = createCubeTiling({ warp: representation.warp, tileSize: representation.tileSize, maxLevel: representation.levelBytes.length - 1, gutter: representation.gutter });
  const gpu = scope.reserve("sourceGpu", layout.gpuBytes, `${representation.id} atlas/table`, { overlap: options.overlap });
  let atlas: TiledSphereAtlas;
  try { atlas = options.createAtlas(layout, representation.faceSize / representation.tileSize); }
  catch (error) { scope.dispose(); throw error; }
  if (!scope.adopt(atlas)) { scope.signal.throwIfAborted(); throw new Error("Stale tiled atlas."); }
  const extension = representation.mimeType === "image/png" ? "png" : "jpg";
  const urlOf = (tile: number): string => `${representation.url}${tiling.path(tile)}.${extension}`;
  type Arrival = { operation: ImageOperationScope; file: ImageFile; body?: EncodedImageFile };
  type Decoded = { held: HeldDecodedImage; operation: ImageOperationScope };
  const arrivals = new Map<number, Arrival>();
  const children = new Set<ImageOperationScope>();
  const reused = { tiles: 0, bytes: 0 };
  let disposed = false;
  const end = (operation: ImageOperationScope): void => { children.delete(operation); operation.dispose(); };
  const scheduler = createTileScheduler<Decoded>({
    tiling, levelBytes: representation.levelBytes, slots: layout.slots, perRow: layout.perRow, url: urlOf, limits: options.limits,
    wake: () => { if (!disposed && scope.isCurrent()) options.wake(); },
    transport: {
      start({ tile, url, expectedBytes, done }) {
        const operation = broker.scope();
        children.add(operation);
        const file: ImageFile = { url, mimeType: representation.mimeType, width: layout.stored, height: layout.stored };
        const arrival: Arrival = { operation, file };
        arrivals.set(tile, arrival);
        let received = 0;
        let cancelled = false;
        void Promise.resolve().then(() => {
          operation.signal.throwIfAborted();
          return options.obtain(file, Math.ceil(expectedBytes), operation, bytes => { received += bytes; }, options.priority);
        }).then(body => {
          if (cancelled || disposed || !operation.isCurrent() || !scope.isCurrent()) { body.release(); end(operation); return; }
          arrival.body = body;
          if (body.fromCache) { reused.tiles += 1; reused.bytes += body.bytes.byteLength; }
          done({ ok: true, received: body.fromCache ? 0 : received, payload: body.bytes });
        }, () => {
          if (arrivals.get(tile) === arrival) arrivals.delete(tile);
          end(operation);
          if (!cancelled && !disposed && scope.isCurrent()) done({ ok: false, received, payload: null });
        });
        return { abort() {
          cancelled = true;
          if (arrivals.get(tile) === arrival) arrivals.delete(tile);
          arrival.body?.release(); end(operation);
          return received;
        } };
      },
    },
    stages: {
      async decode(tile, payload) {
        const arrival = arrivals.get(tile);
        arrivals.delete(tile);
        if (!arrival?.body || arrival.body.bytes !== payload) throw new Error("Tile acquisition ownership was lost.");
        try {
          const held = await options.decode(arrival.body, arrival.file, arrival.operation, options.priority);
          if (disposed || !scope.isCurrent()) { held.close(); end(arrival.operation); throw new Error("Stale tile decode."); }
          return { held, operation: arrival.operation };
        } catch (error) { end(arrival.operation); throw error; }
        finally { arrival.body.release(); }
      },
      upload(slot, _tile, image) {
        scope.signal.throwIfAborted();
        if (typeof image.held.retain !== "function") throw new Error("Tiled native copies require a retained decoded input.");
        // A native callback may dispose the scope before it captures the pixels.
        // Keep the input alive until that synchronous callback has returned/thrown.
        const releaseInput = image.held.retain();
        const failures: unknown[] = [];
        let result: boolean | void = undefined;
        try {
          scope.signal.throwIfAborted();
          result = atlas.uploadTile(slot, image.held.image);
        } catch (error) { failures.push(error); }
        try { releaseInput(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Tiled input copy and retirement failed.");
        return result;
      },
      release(image) { try { image.held.close(); } finally { end(image.operation); } },
      setTable: bytes => { scope.signal.throwIfAborted(); return atlas.setTable(bytes); },
      beginUpdate: () => atlas.beginUpdate?.() ?? true,
      endUpdate: () => atlas.endUpdate?.(),
    },
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    scope.signal.removeEventListener("abort", dispose);
    const errors: unknown[] = [];
    try { offCapacity(); } catch (error) { errors.push(error); }
    try { scheduler.dispose(); } catch (error) { errors.push(error); }
    for (const arrival of arrivals.values()) { try { arrival.body?.release(); } catch (error) { errors.push(error); } }
    arrivals.clear();
    for (const operation of [...children]) { try { end(operation); } catch (error) { errors.push(error); } }
    try { scope.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Tiled panorama disposal failed.");
  };
  const offCapacity = broker.pools.subscribeAvailable(() => {
    const wait = scheduler.uploadAdmission();
    if (!wait || disposed || !scope.isCurrent()) return;
    const tableBytes = 4 * 6 * tiling.cells * 2 * tiling.cells;
    const tileBytes = wait.tiles ? 4 * layout.stored * layout.stored : 0;
    // Releasing an unused preflight table grant must not wake itself forever.
    // Wake only when the complete next update can now be admitted.
    if (broker.pools.fits("uploadOutstanding", tableBytes + tileBytes)) options.wake();
  });
  scope.signal.addEventListener("abort", dispose, { once: true });
  return {
    representation, tiling, layout,
    tick(now, view, parameters) { if (disposed) return false; atlas.pump?.(); return scheduler.tick(now, view, parameters); },
    setLimits(next) { scheduler.setLimits(next); },
    stats: () => ({ ...scheduler.stats(), reusedTiles: reused.tiles, reusedBytes: reused.bytes }),
    settleReplacement: () => gpu.settle(), dispose,
  };
}
