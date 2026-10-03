/**
 * One tiled panorama as the loader holds it: the scheduler (tileScheduler.ts)
 * joined to the network, the browser's decoder and an atlas on the GPU. The
 * GPU side is injected, so this runs in tests without a device.
 *
 * Every response is bounded by the request timeout and the largest-file
 * limit, and every tile's header is checked against the stored tile size
 * before it is decoded, as the loader checks whole images.
 */
import type { TileAtlasLayout } from "../budget";
import type { ResolvedTiledCube } from "../format";
import { checkImage } from "../imageHeaders";
import { createCubeTiling, type CubeTiling } from "./cubeTiling";
import { createTileScheduler, type TileSchedulerLimits, type TileSchedulerStats } from "./tileScheduler";
import type { TileSelectionParameters, TileView } from "./tileSelection";

export interface TiledPanoramaAtlas<Image> {
  uploadTile(slot: number, image: Image): void;
  setTable(bytes: Uint8Array): void;
  dispose(): void;
}

export interface TiledPanoramaLimits extends TileSchedulerLimits {
  timeoutMs: number;
  /** One tile's largest response: `scene.panorama.responseMiB`. */
  responseBytes: number;
}

export interface TiledPanorama {
  readonly representation: ResolvedTiledCube;
  readonly tiling: CubeTiling;
  readonly layout: TileAtlasLayout;
  /** One frame with the view; true while it has work for the next frame without anything arriving. */
  tick(now: number, view: TileView, parameters: TileSelectionParameters): boolean;
  setLimits(limits: TiledPanoramaLimits): void;
  stats(): TileSchedulerStats;
  dispose(): void;
}

export function createTiledPanorama<Image>(options: {
  representation: ResolvedTiledCube;
  layout: TileAtlasLayout;
  atlas: TiledPanoramaAtlas<Image>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  decode(bytes: Uint8Array, mimeType: ResolvedTiledCube["mimeType"]): Promise<Image>;
  release(image: Image): void;
  limits: TiledPanoramaLimits;
  /** Something arrived that the next frame should take up. */
  wake(): void;
}): TiledPanorama {
  const { representation, layout, atlas } = options;
  let limits = options.limits;
  const tiling = createCubeTiling({ warp: representation.warp, tileSize: representation.tileSize, maxLevel: representation.levelBytes.length - 1, gutter: representation.gutter });
  const extension = representation.mimeType === "image/png" ? "png" : "jpg";
  let disposed = false;

  const scheduler = createTileScheduler<Image>({
    tiling,
    levelBytes: representation.levelBytes,
    slots: layout.slots,
    perRow: layout.perRow,
    url: tile => `${representation.url}${tiling.path(tile)}.${extension}`,
    limits,
    wake: () => { if (!disposed) options.wake(); },
    transport: {
      start({ url, done }) {
        const controller = new AbortController();
        let received = 0;
        const fail = () => done({ ok: false, received, payload: null });
        void (async () => {
          try {
            const response = await options.fetch(url, { credentials: "omit", mode: "cors", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(limits.timeoutMs)]) });
            const announced = Number(response.headers.get("content-length"));
            if (!response.ok || !response.body || (Number.isFinite(announced) && announced > limits.responseBytes)) {
              void response.body?.cancel().catch(() => {});
              fail();
              return;
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            for (;;) {
              const { done: finished, value } = await reader.read();
              if (finished) break;
              received += value.byteLength;
              if (received > limits.responseBytes) {
                void reader.cancel().catch(() => {});
                fail();
                return;
              }
              chunks.push(value);
            }
            const payload = new Uint8Array(received);
            let at = 0;
            for (const chunk of chunks) { payload.set(chunk, at); at += chunk.byteLength; }
            done({ ok: true, received, payload });
          } catch {
            // An abort is the scheduler's own; it ignores anything reported after it.
            fail();
          }
        })();
        return {
          abort() {
            controller.abort();
            return received;
          },
        };
      },
    },
    stages: {
      decode(_tile, payload) {
        const problem = checkImage(payload, { mimeType: representation.mimeType, width: layout.stored, height: layout.stored }, null);
        if (problem) return Promise.reject(new Error(problem));
        return options.decode(payload, representation.mimeType);
      },
      upload: (slot, _tile, image) => atlas.uploadTile(slot, image),
      release: image => options.release(image),
      setTable: bytes => atlas.setTable(bytes),
    },
  });

  return {
    representation,
    tiling,
    layout,
    tick: (now, view, parameters) => (disposed ? false : scheduler.tick(now, view, parameters)),
    setLimits(next) {
      limits = next;
      scheduler.setLimits(next);
    },
    stats: () => scheduler.stats(),
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      atlas.dispose();
    },
  };
}
