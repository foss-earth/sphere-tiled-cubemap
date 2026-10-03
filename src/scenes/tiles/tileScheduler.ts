/**
 * One tiled panorama's scheduler, bounded caches and display table
 * (benchmarks/eac-progressive-prototype/REPORT.md: "direct replacement").
 * It knows tiles only as ids of a CubeTiling and touches no pixels; it is
 * handed a transport, a decoder, an atlas to upload into and a table to
 * write, and is ticked once a frame with the view.
 *
 * **Tile states.** absent → loading → fetched → decoding → decoded → resident.
 * A resident tile owns a slot of the atlas.
 *
 * **What is asked for.** The tiles the view needs, at the level it needs and
 * nothing in between, largest share of the view first; then the tiles only
 * the margin around the view touches. Until a cell's tile arrives, the cell
 * shows the finest resident tile at or below its level, or a finer one, or
 * else the panorama's preview cube, which is always there: nothing is ever a
 * hole.
 *
 * **Bounds.** At most `requests` in flight; no new request while `waiting`
 * tiles are fetched and not yet on screen, so a fast link cannot pile up
 * decode work; `decodes` at once; `uploadsPerFrame` a tick; one atlas slot a
 * resident tile. There is no queue to go stale: the list is rebuilt from the
 * view every tick. A request in flight for a tile nothing wants is aborted
 * only when something the view needs is waiting for its place.
 *
 * **Eviction.** A new tile takes a free slot, or the slot of the resident tile
 * with the lowest standing: on screen under the view, or fading out there (3),
 * wanted by the view (2), in the margin (1), anything else (0), oldest use
 * first. A tile that would outrank nothing is dropped, not swapped in.
 *
 * **The display table** is 6C × 2C texels for C cells along a face side: the
 * top half the tile each cell shows, the bottom half the one it showed before,
 * which the new one fades in over for `fadeMs`. A texel is the slot's column
 * and row, the level plus one (0: the preview cube) and, in the top half, the
 * fade's progress.
 */
import type { CubeTiling } from "./cubeTiling";
import { createTileSelector, type TileSelection, type TileSelectionParameters, type TileView } from "./tileSelection";

export interface TileResponse {
  ok: boolean;
  /** Bytes that arrived, whether or not the response completed. */
  received: number;
  payload: Uint8Array | null;
}

export interface TileTransport {
  /** Starts a request; `done` is called once, never after `abort`. `abort` returns the bytes that had arrived. */
  start(request: { tile: number; url: string; expectedBytes: number; done(result: TileResponse): void }): { abort(): number };
}

export interface TileStages<Image> {
  decode(tile: number, payload: Uint8Array): Promise<Image>;
  /** Copies a decoded tile into the atlas slot. The scheduler releases the image afterwards. */
  upload(slot: number, tile: number, image: Image): void;
  release(image: Image): void;
  setTable(bytes: Uint8Array): void;
}

export interface TileSchedulerLimits {
  requests: number;
  waiting: number;
  decodes: number;
  uploadsPerFrame: number;
  retries: number;
  retryDelayMs: number;
  fadeMs: number;
}

export interface TileSchedulerStats {
  /** Tiles the view needs, and how many of them are on screen. */
  inView: number;
  shownInView: number;
  /** The finest level the view asks for. */
  levelWanted: number;
  resident: number;
  slots: number;
  loading: number;
  waiting: number;
  requests: number;
  receivedBytes: number;
  failures: number;
  cancelled: number;
  evictions: number;
  /** Whether every tile the view needs is on screen. */
  complete: boolean;
}

export interface TileScheduler {
  /** One frame: look, ask, decode, upload, show. True while it has work for the next frame without anything arriving. */
  tick(now: number, view: TileView, parameters: TileSelectionParameters): boolean;
  setLimits(limits: TileSchedulerLimits): void;
  stats(): TileSchedulerStats;
  /** What each cell shows now, −1 for the preview: for tests. */
  shown(): Int32Array;
  readonly selection: TileSelection | null;
  /** Aborts every request; anything that still arrives is released unseen. */
  dispose(): void;
}

const ABSENT = 0, LOADING = 1, FETCHED = 2, DECODING = 3, DECODED = 4, RESIDENT = 5;
/** The view may take at most this share of the slots: the rest is room for the margin and for work in flight. */
const VIEW_SHARE_OF_SLOTS = 0.75;
/** Retry delays double up to 2^this times the first. */
const LONGEST_BACKOFF_DOUBLINGS = 8;
/** A cell's fade progress, written as a byte. */
const FADE_STEPS = 255;

export function createTileScheduler<Image>(options: {
  tiling: CubeTiling;
  /** Encoded bytes of each level's tiles, from the representation: a tile's expected size is its level's mean. */
  levelBytes: readonly number[];
  slots: number;
  /** Slots along an atlas row: a slot's column and row in the table. */
  perRow: number;
  url(tile: number): string;
  transport: TileTransport;
  stages: TileStages<Image>;
  limits: TileSchedulerLimits;
  /** Something arrived or finished that the next frame should take up. */
  wake(): void;
}): TileScheduler {
  const { tiling, transport, stages, wake } = options;
  let limits = options.limits;
  const count = tiling.count;
  const C = tiling.cells;
  const cellCount = 6 * C * C;
  const slots = Math.max(1, Math.floor(options.slots));
  const selector = createTileSelector(tiling);
  const expectedBytes = (tile: number): number => {
    const level = tiling.level(tile);
    return (options.levelBytes[level] ?? 0) / tiling.levelCount(level);
  };

  const state = new Uint8Array(count);
  const slotOf = new Int16Array(count).fill(-1);
  const lastUsed = new Float64Array(count);
  const attempts = new Uint8Array(count);
  const retryAt = new Float64Array(count);
  const slotTile = new Int32Array(slots).fill(-1);
  const freeSlots = Array.from({ length: slots }, (_, k) => slots - 1 - k);
  const inflight = new Map<number, { abort(): number; view: boolean }>();
  const payloads = new Map<number, Uint8Array>();
  const decoded = new Map<number, Image>();
  let decoding = 0;
  const shown = new Int32Array(cellCount).fill(-1);
  const previous = new Int32Array(cellCount).fill(-1);
  const fadeStart = new Float64Array(cellCount).fill(Number.NEGATIVE_INFINITY);
  const table = new Uint8Array(cellCount * 2 * 4);
  for (let at = 3; at < table.length; at += 4) table[at] = FADE_STEPS;
  let tableSent = false;
  let fading = 0;
  let disposed = false;
  let now = 0;
  let selection: TileSelection | null = null;
  let tableDirty = true;
  let wanted = new Set<number>();
  let near = new Set<number>();
  let onScreen = new Set<number>();
  const counters = { requests: 0, receivedBytes: 0, failures: 0, cancelled: 0, evictions: 0 };

  const pending = (): number => payloads.size + decoded.size + decoding;
  const standing = (tile: number): number => {
    if (slotOf[tile] >= 0 && onScreen.has(tile)) return 3;
    if (wanted.has(tile)) return 2;
    return near.has(tile) ? 1 : 0;
  };
  const rank = (tile: number): number => (wanted.has(tile) ? 2 : near.has(tile) ? 1 : 0);

  // ─── Asking ──────────────────────────────────────────────────────────
  function failed(tile: number): void {
    counters.failures += 1;
    attempts[tile] = Math.min(255, attempts[tile] + 1);
    // After the last retry the tile is left alone for a long while; what is on screen stays there.
    const doublings = attempts[tile] > limits.retries ? LONGEST_BACKOFF_DOUBLINGS : Math.min(LONGEST_BACKOFF_DOUBLINGS, attempts[tile]);
    retryAt[tile] = now + limits.retryDelayMs * 2 ** doublings;
    state[tile] = ABSENT;
  }

  function startRequest(tile: number, view: boolean): void {
    state[tile] = LOADING;
    counters.requests += 1;
    let finished = false;
    const handle = transport.start({
      tile, url: options.url(tile), expectedBytes: expectedBytes(tile),
      done(result) {
        if (finished) return;
        finished = true;
        if (disposed) return;
        inflight.delete(tile);
        counters.receivedBytes += result.received;
        if (!result.ok || !result.payload) failed(tile);
        else {
          attempts[tile] = 0;
          payloads.set(tile, result.payload);
          state[tile] = FETCHED;
        }
        wake();
      },
    });
    inflight.set(tile, {
      view,
      abort() {
        if (finished) return 0;
        finished = true;
        return handle.abort();
      },
    });
  }

  function cancel(tile: number): void {
    const request = inflight.get(tile);
    if (!request) return;
    inflight.delete(tile);
    counters.cancelled += 1;
    counters.receivedBytes += request.abort();
    if (state[tile] === LOADING) state[tile] = ABSENT;
  }

  function schedule(): void {
    if (!selection) return;
    const list: { tile: number; view: boolean; weight: number }[] = [];
    for (const [tile, weight] of selection.visible) if (state[tile] === ABSENT && now >= retryAt[tile]) list.push({ tile, view: true, weight });
    list.sort((a, b) => b.weight - a.weight || a.tile - b.tile);
    const margin: number[] = [];
    for (const tile of selection.margin.keys()) if (state[tile] === ABSENT && now >= retryAt[tile]) margin.push(tile);
    margin.sort((a, b) => a - b);
    for (const tile of margin) list.push({ tile, view: false, weight: 0 });
    for (const candidate of list) {
      if (pending() >= limits.waiting) break;
      if (inflight.size >= limits.requests) {
        // Full. Something the view needs may take the place of a request nothing wants any more.
        if (!candidate.view) break;
        let victim = -1;
        for (const [tile, request] of inflight) if (!wanted.has(tile) && !near.has(tile) && !request.view) { victim = tile; break; }
        if (victim < 0) for (const tile of inflight.keys()) if (!wanted.has(tile) && !near.has(tile)) { victim = tile; break; }
        if (victim < 0) break;
        cancel(victim);
        if (inflight.size >= limits.requests) break;
      }
      startRequest(candidate.tile, candidate.view);
    }
  }

  // ─── Decoding and uploading ──────────────────────────────────────────
  function decodeReady(): void {
    if (decoding >= limits.decodes || payloads.size === 0) return;
    const order = [...payloads.keys()].sort((p, q) => rank(q) - rank(p));
    for (const tile of order) {
      if (decoding >= limits.decodes) break;
      const payload = payloads.get(tile)!;
      payloads.delete(tile);
      state[tile] = DECODING;
      decoding += 1;
      stages.decode(tile, payload).then(image => {
        if (disposed) { stages.release(image); return; }
        decoding -= 1;
        state[tile] = DECODED;
        decoded.set(tile, image);
        wake();
      }, () => {
        if (disposed) return;
        decoding -= 1;
        failed(tile);
        wake();
      });
    }
  }

  function uploadReady(): void {
    if (decoded.size === 0) return;
    let budget = limits.uploadsPerFrame;
    const order = [...decoded.keys()].sort((p, q) => rank(q) - rank(p) || tiling.level(p) - tiling.level(q));
    for (const tile of order) {
      if (budget <= 0) break;
      const image = decoded.get(tile)!;
      decoded.delete(tile);
      let slot = freeSlots.pop();
      if (slot === undefined) {
        // Full: the resident tile of lowest standing gives up its slot, if the new tile outranks it.
        let victim = -1;
        let lowest = Number.POSITIVE_INFINITY;
        let oldest = Number.POSITIVE_INFINITY;
        for (let s = 0; s < slots; s++) {
          const held = slotTile[s];
          const heldStanding = standing(held);
          if (heldStanding < lowest || (heldStanding === lowest && lastUsed[held] < oldest)) { victim = held; lowest = heldStanding; oldest = lastUsed[held]; }
        }
        const own = rank(tile);
        // Swapping one tile the view wants for another would only churn, so an equal standing gives way only below that.
        if (victim < 0 || lowest > own || (lowest === own && lowest >= 2)) {
          stages.release(image);
          state[tile] = ABSENT;
          retryAt[tile] = now + limits.retryDelayMs;
          continue;
        }
        slot = slotOf[victim];
        slotOf[victim] = -1;
        state[victim] = ABSENT;
        counters.evictions += 1;
        // A cell still fading out of the evicted tile fades from the preview instead.
        for (let cell = 0; cell < cellCount; cell++) {
          if (previous[cell] !== victim) continue;
          previous[cell] = -1;
          writeEntry(cell, -1, 1, FADE_STEPS);
        }
      }
      try {
        stages.upload(slot, tile, image);
      } catch {
        freeSlots.push(slot);
        stages.release(image);
        failed(tile);
        continue;
      }
      stages.release(image);
      slotOf[tile] = slot;
      slotTile[slot] = tile;
      state[tile] = RESIDENT;
      lastUsed[tile] = now;
      budget -= 1;
      tableDirty = true;
    }
  }

  // ─── The display table ───────────────────────────────────────────────
  function writeEntry(cell: number, tile: number, half: number, fade: number): void {
    const face = Math.floor(cell / (C * C));
    const cx = cell % C;
    const cy = Math.floor(cell / C) % C;
    const at = ((half * C + cy) * 6 * C + face * C + cx) * 4;
    const slot = tile >= 0 ? slotOf[tile] : -1;
    table[at] = slot >= 0 ? slot % options.perRow : 0;
    table[at + 1] = slot >= 0 ? Math.floor(slot / options.perRow) : 0;
    table[at + 2] = slot >= 0 ? tiling.level(tile) + 1 : 0;
    table[at + 3] = fade;
  }

  /** The tile a cell should show: the finest resident at or below its level, else the least fine above it, else the preview (−1). */
  function choose(cell: number): number {
    const face = Math.floor(cell / (C * C));
    const cx = cell % C;
    const cy = Math.floor(cell / C) % C;
    const needed = selection && selection.cells[cell] >= 0 ? selection.cells[cell] : tiling.maxLevel;
    for (let level = needed; level >= 0; level--) {
      const shift = tiling.maxLevel - level;
      const tile = tiling.id(face, level, cx >> shift, cy >> shift);
      if (state[tile] === RESIDENT) return tile;
    }
    for (let level = needed + 1; level <= tiling.maxLevel; level++) {
      const shift = tiling.maxLevel - level;
      const tile = tiling.id(face, level, cx >> shift, cy >> shift);
      if (state[tile] === RESIDENT) return tile;
    }
    return -1;
  }

  /**
   * Shows each cell's tile, fading in where the view sees the change, and
   * uploads the table when anything in it moved. Returns whether a fade is
   * still under way.
   */
  function refreshTable(): boolean {
    // The first tick sends the whole table, so the atlas's starts out as written here.
    let changed = !tableSent;
    tableSent = true;
    if (tableDirty) {
      tableDirty = false;
      for (let cell = 0; cell < cellCount; cell++) {
        const next = choose(cell);
        if (next === shown[cell]) continue;
        const fades = limits.fadeMs > 0 && selection?.inView[cell] === 1;
        previous[cell] = fades ? shown[cell] : -1;
        fadeStart[cell] = fades ? now : Number.NEGATIVE_INFINITY;
        shown[cell] = next;
        writeEntry(cell, previous[cell], 1, FADE_STEPS);
        writeEntry(cell, next, 0, fades ? 0 : FADE_STEPS);
        changed = true;
      }
    }
    fading = 0;
    const screen = new Set<number>();
    for (let cell = 0; cell < cellCount; cell++) {
      if (fadeStart[cell] > Number.NEGATIVE_INFINITY) {
        const progress = limits.fadeMs > 0 ? Math.min(1, (now - fadeStart[cell]) / limits.fadeMs) : 1;
        if (progress < 1) {
          fading += 1;
          // The tile fading out stays on screen until it has.
          if (previous[cell] >= 0) screen.add(previous[cell]);
          writeEntry(cell, shown[cell], 0, Math.round(progress * FADE_STEPS));
        } else {
          previous[cell] = -1;
          fadeStart[cell] = Number.NEGATIVE_INFINITY;
          writeEntry(cell, -1, 1, FADE_STEPS);
          writeEntry(cell, shown[cell], 0, FADE_STEPS);
        }
        changed = true;
      }
      if (shown[cell] >= 0 && selection?.inView[cell] === 1) {
        screen.add(shown[cell]);
        lastUsed[shown[cell]] = now;
      }
    }
    onScreen = screen;
    if (changed) stages.setTable(table);
    return fading > 0;
  }

  function viewComplete(): boolean {
    if (!selection) return false;
    for (const tile of selection.visible.keys()) if (state[tile] !== RESIDENT) return false;
    return true;
  }

  return {
    tick(time, view, parameters) {
      if (disposed) return false;
      now = time;
      const next = selector.selectWithin(view, parameters, Math.floor(slots * VIEW_SHARE_OF_SLOTS));
      if (next !== selection) {
        selection = next;
        tableDirty = true;
        wanted = new Set(next.visible.keys());
        near = new Set(next.margin.keys());
      }
      uploadReady();
      const stillFading = refreshTable();
      decodeReady();
      schedule();
      return stillFading || decoded.size > 0;
    },
    setLimits(next) {
      limits = next;
      tableDirty = true;
    },
    stats() {
      let shownInView = 0;
      let levelWanted = 0;
      if (selection) {
        for (const tile of selection.visible.keys()) {
          if (state[tile] === RESIDENT) shownInView += 1;
          levelWanted = Math.max(levelWanted, tiling.level(tile));
        }
      }
      return {
        inView: selection?.visible.size ?? 0, shownInView, levelWanted,
        resident: slots - freeSlots.length, slots, loading: inflight.size, waiting: pending(),
        requests: counters.requests, receivedBytes: counters.receivedBytes, failures: counters.failures,
        cancelled: counters.cancelled, evictions: counters.evictions, complete: viewComplete(),
      };
    },
    shown: () => shown,
    get selection() { return selection; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const tile of [...inflight.keys()]) cancel(tile);
      for (const image of decoded.values()) stages.release(image);
      decoded.clear();
      payloads.clear();
    },
  };
}
