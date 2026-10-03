import { describe, expect, it } from "vitest";
import { cross, normalize, type Vec3 } from "../panoramaMath";
import { createCubeTiling } from "./cubeTiling";
import { createTileScheduler, type TileSchedulerLimits } from "./tileScheduler";
import type { TileView } from "./tileSelection";

const tiling = createCubeTiling({ warp: "equi-angular", tileSize: 192, maxLevel: 3, gutter: 1 });
const C = tiling.cells;
const LIMITS: TileSchedulerLimits = { requests: 6, waiting: 12, decodes: 2, uploadsPerFrame: 2, retries: 3, retryDelayMs: 250, fadeMs: 150 };
const PARAMETERS = { texelsPerPixel: 1, marginDeg: 5, levelCap: 3 };

function phoneView(headingDeg: number): TileView {
  const h = (headingDeg * Math.PI) / 180;
  const forward: Vec3 = [Math.sin(h), Math.cos(h), 0];
  const right = normalize(cross(forward, [0, 0, 1]));
  const tanV = Math.tan((75 * Math.PI) / 360);
  return { forward, right, up: cross(right, forward), tanHalfHeight: tanV, tanHalfWidth: (tanV * 1081) / 2401, heightPx: 2401 };
}

/** A scheduler on a network and GPU the test drives by hand, checking its bounds after every step. */
function harness(options: { slots?: number; limits?: Partial<TileSchedulerLimits>; fail?: (tile: number) => boolean } = {}) {
  const limits = { ...LIMITS, ...options.limits };
  const slots = options.slots ?? 196;
  const perRow = Math.ceil(Math.sqrt(slots));
  const requests: { tile: number; url: string; done(result: { ok: boolean; received: number; payload: Uint8Array | null }): void; aborted: boolean }[] = [];
  const decodes: { tile: number; resolve(image: { tile: number }): void }[] = [];
  const slotTile = new Map<number, number>();
  let table = new Uint8Array(0);
  let images = 0, released = 0, uploadsThisTick = 0, wakes = 0;
  const scheduler = createTileScheduler<{ tile: number }>({
    tiling, levelBytes: [70_000, 280_000, 1_000_000, 3_300_000], slots, perRow,
    url: tile => `tiles/${tiling.path(tile)}.jpg`,
    transport: {
      start(request) {
        const entry = { ...request, aborted: false };
        requests.push(entry);
        return { abort() { entry.aborted = true; return 100; } };
      },
    },
    stages: {
      decode: tile => new Promise(resolve => decodes.push({ tile, resolve })),
      upload(slot, tile) { slotTile.set(slot, tile); uploadsThisTick += 1; },
      release() { released += 1; },
      setTable(bytes) { table = bytes.slice(); },
    },
    limits,
    wake: () => { wakes += 1; },
  });
  let now = 0;
  const open = () => requests.filter(request => !request.aborted && !(request as { finished?: boolean }).finished);
  const check = () => {
    expect(open().length).toBeLessThanOrEqual(limits.requests);
    expect(uploadsThisTick).toBeLessThanOrEqual(limits.uploadsPerFrame);
    const stats = scheduler.stats();
    expect(stats.resident).toBeLessThanOrEqual(slots);
    expect(stats.waiting).toBeLessThanOrEqual(limits.waiting + limits.requests);
    // Every cell shows a resident tile that covers it, or the preview.
    for (let cell = 0; cell < 6 * C * C; cell++) {
      for (const half of [0, 1]) {
        const face = Math.floor(cell / (C * C)), cx = cell % C, cy = Math.floor(cell / C) % C;
        const at = ((half * C + cy) * 6 * C + face * C + cx) * 4;
        if (table.length === 0 || table[at + 2] === 0) continue;
        const tile = slotTile.get(table[at] + table[at + 1] * perRow);
        expect(tile).toBeDefined();
        const level = table[at + 2] - 1;
        const shift = tiling.maxLevel - level;
        expect(tile).toBe(tiling.id(face, level, cx >> shift, cy >> shift));
      }
    }
  };
  return {
    scheduler, requests, decodes, slotTile, check,
    get table() { return table; },
    get images() { return images; },
    get released() { return released; },
    get wakes() { return wakes; },
    tick(view: TileView, ms = 16) {
      now += ms;
      uploadsThisTick = 0;
      const busy = scheduler.tick(now, view, PARAMETERS);
      check();
      return busy;
    },
    deliverAll() {
      for (const request of open()) {
        (request as { finished?: boolean }).finished = true;
        const failing = options.fail?.(request.tile) ?? false;
        request.done(failing ? { ok: false, received: 0, payload: null } : { ok: true, received: 10_000, payload: new Uint8Array(4) });
      }
    },
    async decodeAll() {
      for (const job of decodes.splice(0)) { images += 1; job.resolve({ tile: job.tile }); }
      await Promise.resolve();
    },
  };
}

async function settle(h: ReturnType<typeof harness>, view: TileView, rounds = 80): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    h.tick(view);
    h.deliverAll();
    await h.decodeAll();
  }
}

describe("the tile scheduler", () => {
  it("fetches the view's tiles at the level it needs, within every bound, until the view is complete", async () => {
    const h = harness();
    const view = phoneView(30);
    h.tick(view);
    // The view's tiles first, the largest share of the view first, at its finest level.
    expect(h.requests.length).toBe(LIMITS.requests);
    expect(new Set(h.requests.map(request => tiling.level(request.tile)))).toEqual(new Set([3]));
    await settle(h, view);
    const stats = h.scheduler.stats();
    expect(stats.complete).toBe(true);
    expect(stats.shownInView).toBe(stats.inView);
    // Nothing between the preview and the level the view needs was asked for.
    expect(h.requests.every(request => tiling.level(request.tile) === 3)).toBe(true);
    expect(h.released).toBe(h.images);
  });

  it("fades a tile in over the preview, then keeps it", async () => {
    const h = harness();
    const view = phoneView(0);
    h.tick(view);
    h.deliverAll();
    // Responses are decoded from the next tick, and uploaded on the one after.
    h.tick(view);
    await h.decodeAll();
    h.tick(view, 1);
    expect(h.slotTile.size).toBe(2);
    const tile = [...h.slotTile.values()][0];
    const { face, x, y } = tiling.address(tile);
    const at = ((y * 6 * C) + face * C + x) * 4;
    expect(h.table[at + 2]).toBe(4);
    expect(h.table[at + 3]).toBe(Math.round((0 / 150) * 255));
    // The cell it replaces showed the preview, which the bottom half keeps while it fades.
    expect(h.table[((C + y) * 6 * C + face * C + x) * 4 + 2]).toBe(0);
    expect(h.tick(view, 75)).toBe(true);
    expect(h.table[at + 3]).toBe(128);
    h.tick(view, 100);
    expect(h.table[at + 3]).toBe(255);
  });

  it("turning cancels requests nothing wants, and asks for the new view", async () => {
    const h = harness();
    h.tick(phoneView(0));
    const first = h.requests.map(request => request.tile);
    h.tick(phoneView(180));
    expect(h.requests.filter(request => request.aborted).map(request => request.tile).sort()).toEqual(first.sort());
    expect(h.scheduler.stats().cancelled).toBe(first.length);
    await settle(h, phoneView(180));
    expect(h.scheduler.stats().complete).toBe(true);
  });

  it("with a small atlas, drops the level rather than leave part of the view without tiles, and evicts what is out of view", async () => {
    const h = harness({ slots: 24 });
    await settle(h, phoneView(0));
    expect(h.scheduler.stats().complete).toBe(true);
    expect(h.scheduler.selection!.levelCap).toBeLessThan(3);
    await settle(h, phoneView(120));
    const stats = h.scheduler.stats();
    expect(stats.complete).toBe(true);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.resident).toBeLessThanOrEqual(24);
  });

  it("retries a failed tile with growing delays, and the view keeps its preview meanwhile", async () => {
    const failing = new Set<number>();
    const h = harness({ fail: tile => failing.has(tile) });
    const view = phoneView(0);
    h.tick(view);
    for (const request of h.requests) failing.add(request.tile);
    for (let round = 0; round < 40; round++) {
      h.tick(view, 50);
      h.deliverAll();
      await h.decodeAll();
    }
    const attempts = h.requests.filter(request => failing.has(request.tile)).length;
    expect(h.scheduler.stats().failures).toBe(attempts);
    // Retried after 500 ms, then 1 s: three tries each in two seconds, not one a frame.
    expect(attempts).toBeGreaterThanOrEqual(failing.size * 2);
    expect(attempts).toBeLessThanOrEqual(failing.size * 3);
    expect(h.scheduler.stats().complete).toBe(false);
    // Every cell those tiles cover still shows something: the preview.
    expect(h.scheduler.stats().shownInView).toBe(h.scheduler.stats().inView - failing.size);
  });

  it("after dispose, aborts what is in flight and releases what arrives unseen", async () => {
    const h = harness();
    h.tick(phoneView(0));
    h.deliverAll();
    h.tick(phoneView(0));
    const decoding = h.decodes.length;
    h.tick(phoneView(0));
    h.scheduler.dispose();
    expect(h.requests.filter(request => !(request as { finished?: boolean }).finished).every(request => request.aborted)).toBe(true);
    await h.decodeAll();
    expect(decoding).toBeGreaterThan(0);
    expect(h.released).toBe(h.images);
    expect(h.tick(phoneView(0))).toBe(false);
  });
});
