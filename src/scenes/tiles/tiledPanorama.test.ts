import { describe, expect, it } from "vitest";
import { cross, normalize, type Vec3 } from "../panoramaMath";
import { tileAtlasLayout } from "../budget";
import type { ResolvedTiledCube } from "../format";
import { createTiledPanorama, type TiledPanoramaLimits } from "./tiledPanorama";
import type { TileView } from "./tileSelection";

const representation: ResolvedTiledCube = {
  id: "eac-tiles", role: "immersion", projection: "tiled-cube", warp: "equi-angular", mimeType: "image/jpeg",
  encodedBytes: 3000, faceSize: 384, tileSize: 192, gutter: 1, levelBytes: [600, 2400], url: "https://tiles.example/eac-tiles/",
};
const layout = tileAtlasLayout(representation, 64 * 194 * 194 * 4)!;
const LIMITS: TiledPanoramaLimits = { requests: 6, waiting: 12, decodes: 2, uploadsPerFrame: 8, retries: 3, retryDelayMs: 250, fadeMs: 0, timeoutMs: 30_000, responseBytes: 4096 };

/** A JPEG header of `side` × `side` pixels, padded to `length` bytes. */
function jpeg(side: number, length = 100): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, side >> 8, side & 0xff, side >> 8, side & 0xff, 0x03]);
  return bytes;
}

const ahead: TileView = (() => {
  const forward: Vec3 = [0, 1, 0];
  const right = normalize(cross(forward, [0, 0, 1]));
  return { forward, right, up: cross(right, forward), tanHalfHeight: Math.tan((75 * Math.PI) / 360), tanHalfWidth: Math.tan((75 * Math.PI) / 360) * 0.45, heightPx: 2401 };
})();

function harness(respond: (url: string) => Response) {
  const uploads: number[] = [];
  const requested: string[] = [];
  let released = 0, decoded = 0;
  const panorama = createTiledPanorama<{ side: number }>({
    representation, layout,
    atlas: { uploadTile: slot => { uploads.push(slot); }, setTable: () => {}, dispose: () => {} },
    fetch: async url => { requested.push(url); return respond(url); },
    decode: async bytes => { decoded += 1; return { side: (bytes[7] << 8) | bytes[8] }; },
    release: () => { released += 1; },
    limits: LIMITS,
    wake: () => {},
  });
  let now = 0;
  return {
    panorama, uploads, requested,
    get decoded() { return decoded; },
    get released() { return released; },
    async run(frames: number, stepMs = 16) {
      for (let frame = 0; frame < frames; frame++) {
        now += stepMs;
        panorama.tick(now, ahead, { texelsPerPixel: 1, marginDeg: 0, levelCap: 1 });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    },
  };
}

describe("a tiled panorama", () => {
  it("fetches the format's tile addresses, checks each header and fills the atlas", async () => {
    const h = harness(() => new Response(jpeg(194) as BodyInit));
    await h.run(20);
    expect(h.requested.every(url => /^https:\/\/tiles\.example\/eac-tiles\/(px|nx|py|ny|pz|nz)\/1\/[01]\/[01]\.jpg$/.test(url))).toBe(true);
    expect(h.panorama.stats().complete).toBe(true);
    expect(h.uploads.length).toBe(h.panorama.stats().resident);
    expect(h.released).toBe(h.decoded);
  });

  it("refuses a tile of the wrong size before decoding it, and one past the largest-file limit while it arrives", async () => {
    const wrong = harness(() => new Response(jpeg(256) as BodyInit));
    await wrong.run(10);
    expect(wrong.decoded).toBe(0);
    expect(wrong.uploads).toEqual([]);
    expect(wrong.panorama.stats().failures).toBeGreaterThan(0);

    const large = harness(() => new Response(jpeg(194, 8192) as BodyInit));
    await large.run(10);
    expect(large.decoded).toBe(0);
    expect(large.panorama.stats().failures).toBeGreaterThan(0);
    expect(large.panorama.stats().shownInView).toBe(0);
  });

  it("counts a failed response as a failure and asks again later, not every frame", async () => {
    let failing = true;
    const h = harness(() => (failing ? new Response("", { status: 503 }) : new Response(jpeg(194) as BodyInit)));
    await h.run(10);
    const first = h.requested.length;
    expect(h.panorama.stats().failures).toBe(first);
    await h.run(10);
    expect(h.requested.length).toBe(first);
    failing = false;
    // The first retry, after twice the delay.
    await h.run(40, 16);
    expect(h.panorama.stats().complete).toBe(true);
  });
});
