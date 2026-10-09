import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, type ImageFile, type ImageOperationScope, type ImageSessionBroker } from "@foss-earth/images";
import { decodeImageFile, type EncodedImageFile } from "@foss-earth/images/browser";
import type { BaseTexture } from "@babylonjs/core";
import type { ImageRegionDevicePorts, UploadTicket } from "@foss-earth/renderer/babylon";
import { createTiledPanorama } from "../src/browser/index.js";
import { createPanoramaTileAtlas } from "../src/browser/tileAtlas.js";
import { tileAtlasLayout } from "../src/layout.js";
import type { TiledCubeRepresentationRecord } from "../src/representation.js";

const record: TiledCubeRepresentationRecord = { id: "tiny", role: "immersion", projection: "tiled-cube", warp: "equi-angular", faceSize: 8, tileSize: 8, gutter: 1, mimeType: "image/png", encodedBytes: 60, levelBytes: [60], url: "https://example.invalid/tiles/" };
const view = { forward: [0, 1, 0] as const, right: [1, 0, 0] as const, up: [0, 0, 1] as const, tanHalfHeight: 0.5, tanHalfWidth: 0.25, heightPx: 8 };
const selection = { texelsPerPixel: 1, marginDeg: 0, levelCap: 0 };
const limits = { requests: 2, waiting: 2, decodes: 1, uploadsPerFrame: 1, retries: 1, retryDelayMs: 100, fadeMs: 0 };
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function fixture(shared?: ImageSessionBroker) {
  const broker = shared ?? createImageSessionBroker({ requests: 2, decodes: 1, pools: { encoded: 1000, decoded: 1000, sourceGpu: 2000, uploadOutstanding: 448, overlap: 2000 } });
  const scope = broker.scope(), layout = tileAtlasLayout(record, 800, 128)!;
  const submitted: UploadTicket[] = [], copies: string[] = [];
  const textures: BaseTexture[] = [];
  const device: ImageRegionDevicePorts = {
    createTexture: () => { const value = { dispose: vi.fn() } as unknown as BaseTexture; textures.push(value); return value; },
    copyImage: (_texture, _image, _x, _y, ticket) => { copies.push("tile"); submitted.push(ticket); },
    copyBytes: (_texture, _bytes, ticket) => { copies.push("table"); submitted.push(ticket); },
  };
  const reserveUpload = (bytes: number, label: string): UploadTicket | null => {
    const result = broker.pools.reserve("uploadOutstanding", bytes, label);
    return result.ok ? result.reservation : null;
  };
  const wake = vi.fn(), close = vi.fn();
  const obtain = vi.fn(async (_file: ImageFile, bytes: number, operation: ImageOperationScope, _onChunk?: (bytes: number) => void, _priority?: number) => {
    const grant = operation.reserve("encoded", bytes, "fixture body");
    const body = new Uint8Array(Math.max(33, bytes));
    grant.resize(body.byteLength);
    body.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(body.buffer);
    header.setUint32(8, 13); body.set([73, 72, 68, 82], 12);
    header.setUint32(16, 10); header.setUint32(20, 10); body[24] = 8; body[25] = 6;
    return { bytes: body, contentType: "image/png", retain: () => grant.retain(), release: () => grant.release() };
  });
  const decode = vi.fn(async (body: EncodedImageFile, declared: ImageFile, operation: ImageOperationScope, priority = 0) =>
    decodeImageFile({ file: body, declared, broker, scope: operation, priority,
      decode: async () => ({ width: declared.width, height: declared.height, close } as ImageBitmap),
    }));
  const panorama = createTiledPanorama({ representation: record, layout, broker, scope, priority: 7, createAtlas: () => createPanoramaTileAtlas({ device, layout, cells: 1, label: "fixture", reserveUpload }), obtain, decode, limits, wake });
  return { broker, scope, panorama, submitted, copies, wake, close, textures, obtain, decode };
}

describe("one common session and renderer-owned submitted lifetime", () => {
  it("keeps two panorama jobs isolated while one tracker completion admits the other", async () => {
    const a = fixture(), b = fixture(a.broker);
    for (const f of [a, b]) f.panorama.tick(0, view, selection);
    await flush(); for (const f of [a, b]) f.panorama.tick(1, view, selection); await flush();
    // Initial tables hold both grants. Complete them before the tile frame.
    for (const f of [a, b]) for (const ticket of f.submitted) ticket.release(); await flush();
    a.panorama.tick(2, view, selection);
    expect(a.panorama.stats().complete).toBe(true);
    expect(b.panorama.tick(2, view, selection)).toBe(false);
    expect(b.panorama.stats().complete).toBe(false); expect(b.close).not.toHaveBeenCalled();
    a.panorama.dispose();
    // Cancelling A cannot release its submitted GPU charge or B's decoded work.
    expect(a.broker.pools.stats().uploadOutstanding.reserved).toBe(448);
    const before = b.wake.mock.calls.length;
    for (const ticket of a.submitted) ticket.release(); await flush();
    expect(b.wake).toHaveBeenCalledTimes(before + 1);
    b.panorama.tick(2, view, selection); expect(b.panorama.stats().complete).toBe(true);
    b.panorama.dispose(); for (const ticket of b.submitted) ticket.release(); a.broker.dispose();
    expect(a.broker.pools.live()).toEqual([]);
  });
  it("waits without polling and wakes only after the full next update fits", async () => {
    const f = fixture(); const blocked = f.broker.pools.reserve("uploadOutstanding", 448, "other job");
    if (!blocked.ok) throw new Error("fixture admission");
    expect(f.panorama.tick(0, view, selection)).toBe(false); await flush();
    f.panorama.tick(1, view, selection); await flush();
    expect(f.panorama.tick(2, view, selection)).toBe(false);
    expect(f.copies).toEqual([]); expect(f.broker.pools.stats().decoded.reserved).toBe(400);
    const before = f.wake.mock.calls.length;
    blocked.reservation.resize(400); await flush();
    expect(f.wake).toHaveBeenCalledTimes(before); // table alone fits, tile plus table does not
    blocked.reservation.release(); await flush();
    expect(f.wake).toHaveBeenCalledTimes(before + 1);
    f.panorama.tick(2, view, selection);
    expect(f.copies).toEqual(["tile", "table"]); expect(f.close).toHaveBeenCalledOnce();
    expect(f.panorama.stats().complete).toBe(true);
    expect(f.obtain.mock.calls[0][4]).toBe(7); expect(f.decode.mock.calls[0][3]).toBe(7);
    f.panorama.dispose(); f.panorama.dispose();
    expect(f.broker.pools.stats().uploadOutstanding.reserved).toBe(448);
    const retiredWakes = f.wake.mock.calls.length;
    for (const grant of f.submitted) grant.release(); await flush();
    expect(f.wake).toHaveBeenCalledTimes(retiredWakes);
    expect(f.broker.pools.live()).toEqual([]);
    for (const texture of f.textures) expect(texture.dispose).toHaveBeenCalledOnce(); f.broker.dispose();
  });
  it("does not self-wake forever after a table-only preflight releases unused capacity", async () => {
    const f = fixture();
    // A table fits but a tile cannot. No continuous frame or release feedback loop.
    const blocked = f.broker.pools.reserve("uploadOutstanding", 400, "other upload");
    if (!blocked.ok) throw new Error("fixture admission");
    f.panorama.tick(0, view, selection); await flush(); f.panorama.tick(1, view, selection); await flush();
    // Complete the initial preview-only table so a new preflight can fit.
    for (const ticket of f.submitted) ticket.release(); await flush();
    const before = f.wake.mock.calls.length;
    expect(f.panorama.tick(2, view, selection)).toBe(false); await flush();
    expect(f.wake).toHaveBeenCalledTimes(before);
    f.panorama.dispose(); blocked.reservation.release(); for (const ticket of f.submitted) ticket.release(); await flush(); f.broker.dispose();
    expect(f.broker.pools.live()).toEqual([]);
  });
});
