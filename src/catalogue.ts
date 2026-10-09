/** Extracted unchanged tiled controls/default forecasts; one host registry owns homes. */
import { MIB } from '@foss-earth/images';
import type { DerivedDefault, DeviceContext, ParameterSpec, ParameterUnit } from '@foss-earth/ui/settings';
import { tileAtlasLayout } from './layout.js';
const SCENES_TAB = 'scenes';
const PANORAMA_SETTINGS_TAB = 'panorama-settings';
const LOADER = 'src/scenes/loadScene.ts';
const RESOURCES = 'src/scenes/panoramaResources.ts';
const RENDERER = 'src/engine/babylon/panorama/panoramaRenderer.ts';

interface Quantity {
  id: string;
  label: string;
  description: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  fallback: number;
  reason: string;
  tab?: string;
  section: string;
  source: string;
  level?: "main" | "all";
  scale?: "linear" | "log2";
  step?: number;
}

function quantity(spec: Quantity): ParameterSpec {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    unit: spec.unit,
    kind: "number",
    bounds: () => ({ min: spec.min, max: spec.max }),
    scale: spec.scale ?? "linear",
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    default: spec.fallback,
    defaultReason: spec.reason,
    home: { tab: spec.tab ?? SCENES_TAB, section: spec.section, level: spec.level ?? "main" },
    appliesLive: true,
    source: spec.source,
  };
}


const TILE_BYTES = 194 * 194 * 4;
/** The tiles of a prepared cube: four levels of 1536-texel faces in 192-texel tiles, 6 · (1 + 4 + 16 + 64). */
const TILES_OF_A_CUBE = 510;
/** A phone's view and its margin, as the prototype held them. */
const TILES_OF_A_VIEW = 196;
/** The tiled cubes' source of truth: the prototype that measured them. */
const TILE_EVIDENCE = "benchmarks/eac-progressive-prototype";
/** MiB that `count` stored tiles take, up to the control's next quarter MiB. */
const tilesMiB = (count: number): number => Math.ceil((count * TILE_BYTES) / MIB * 4) / 4;
/** A prepared tiled cube's shape: 192-texel tiles with a texel of gutter, four levels to 1536-texel faces. */
const PREPARED_CUBE = { tileSize: 192, gutter: 1, faceSize: 1536 };
/** GPU MiB of the atlas a tile memory lays out for a prepared cube, up to the next quarter MiB: a square of slots, some empty, and the display table. */
const atlasMiB = (tileMemoryMiB: number): number => Math.ceil(((tileAtlasLayout(PREPARED_CUBE, tileMemoryMiB * MIB)?.gpuBytes ?? 0) / MIB) * 4) / 4;
/** The share of the device's memory a panorama's tiles may take: the map's imagery takes the same for its own GPU budget. */
const DEVICE_MEMORY_SHARE = 32;

/**
 * The tile memory's default, from what the browser says of the device: every
 * tile of a panorama where 1/32 of its memory holds them, else that share,
 * and never less than a phone's view and its margin. A browser that does not
 * say has room, unless it is a touch screen's, most often a phone's.
 */
export function tileMemoryDefault(context: DeviceContext): DerivedDefault<number> {
  const all = tilesMiB(TILES_OF_A_CUBE);
  const view = tilesMiB(TILES_OF_A_VIEW);
  if (context.deviceMemoryGiB) {
    const share = Math.floor((context.deviceMemoryGiB * 1024) / DEVICE_MEMORY_SHARE * 4) / 4;
    const value = Math.min(all, Math.max(view, share));
    const of = `1/${DEVICE_MEMORY_SHARE} of the ${context.deviceMemoryGiB} GiB the browser reports`;
    return {
      value,
      derivedFrom: value === all ? `every tile of a panorama, which ${of} holds`
        : value === view ? `a phone's view and its margin, ${TILES_OF_A_VIEW} tiles, more than ${of}`
          : of,
    };
  }
  return context.touch
    ? { value: view, derivedFrom: `a phone's view and its margin, ${TILES_OF_A_VIEW} tiles, because this touch screen's browser does not say how much memory the device has` }
    : { value: all, derivedFrom: "every tile of a panorama, because this browser does not say how much memory the device has and it has no touch screen" };
}

/** What stays on the GPU of panoramas not on screen: the atlas of the one left, where the tile memory holds every tile, else nothing. */
export function keptGpuDefault(context: DeviceContext): DerivedDefault<number> {
  const tiles = tileMemoryDefault(context);
  return tiles.value >= tilesMiB(TILES_OF_A_CUBE)
    ? { value: atlasMiB(tiles.value), derivedFrom: `the tiles of the panorama you left, as their atlas takes them; the tile memory holds ${tiles.derivedFrom}` }
    : { value: 0, derivedFrom: `nothing that is not on screen; the tile memory holds ${tiles.derivedFrom}` };
}


export const TILED_CUBEMAP_PARAMETERS: readonly ParameterSpec[] = [
{
    id: "scene.panorama.tileMemoryMiB", label: "Tile memory",
    description: "The most GPU memory the tiles of a panorama may take: one atlas, allocated when the panorama is entered, with a slot for each of its tiles up to this. With room for all of them, a part you looked at stays sharp when you look back. With less, the GPU holds the view and its margin: the tiles out of view give up their slots and are read again from the saved images when you look back, and the view drops a level of detail before it would go without tiles. Part of the panorama GPU memory.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 1, max: 1024 }), step: 0.25, scale: "log2",
    default: tileMemoryDefault,
    defaultReason: `Every tile of a panorama as the tools prepare it, ${TILES_OF_A_CUBE} tiles of 194 texels (${tilesMiB(TILES_OF_A_CUBE)} MiB, about what its whole 6144 px image takes), where 1/${DEVICE_MEMORY_SHARE} of the device's memory holds them, as the map's imagery takes for its own: nothing looked at is loaded twice. A device with less keeps its GPU for the view: that share, and no less than a phone's view and its margin, the ${TILES_OF_A_VIEW} tiles (${tilesMiB(TILES_OF_A_VIEW)} MiB) ${TILE_EVIDENCE} ran on; what it looked at before comes back from the saved images.`,
    home: { tab: SCENES_TAB, section: "tiles", level: "main" }, appliesLive: true, source: RESOURCES,
  },
quantity({
    id: "scene.panorama.tileRequests", label: "Tile requests at once", unit: "count", min: 1, max: 16, fallback: 6, step: 1, section: "tiles",
    description: "Tile downloads in flight at the same time, beside the previews' image requests.",
    reason: `The fastest in ${TILE_EVIDENCE}'s measurements: two at once were much slower, twelve no faster.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileUploadsPerFrame", label: "Tiles uploaded per frame", unit: "count", min: 1, max: 64, fallback: 2, step: 1, section: "tiles",
    description: "Tiles copied to the GPU in one frame. More shows a view you come back to sooner; fewer keeps each frame's work small.",
    reason: `${TILE_EVIDENCE}'s setting: no frame was late on a desktop, and a view seen before was sharp again in half a second.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileMarginDeg", label: "Tiles beyond the view", unit: "deg", min: 0, max: 45, fallback: 5, step: 1, section: "tiles",
    description: "How far past the edge of the view tiles load, after the view's own, so a small turn finds them already there.",
    reason: `${TILE_EVIDENCE}'s setting.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileDecodes", label: "Tile decodes at once", unit: "count", min: 1, max: 8, fallback: 2, step: 1, section: "tiles", level: "all",
    description: "Tiles the browser decodes at the same time.", reason: `${TILE_EVIDENCE}'s setting.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tilesWaiting", label: "Tiles waiting to show", unit: "count", min: 1, max: 64, fallback: 12, step: 1, section: "tiles", level: "all",
    description: "Tiles downloaded and not yet on screen before no more are asked for, so a fast connection cannot pile up decoding.",
    reason: `${TILE_EVIDENCE}'s setting.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileRetries", label: "Tile retries", unit: "count", min: 0, max: 10, fallback: 3, step: 1, section: "tiles", level: "all",
    description: "How many times a tile that failed is asked for again, each after twice the wait before; then it is left alone for a while. Until it arrives, the preview shows there.",
    reason: `${TILE_EVIDENCE}'s setting.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileRetryDelay", label: "First tile retry after", unit: "ms", min: 50, max: 10_000, fallback: 250, scale: "log2", step: 0.25, section: "tiles", level: "all",
    description: "The wait before a failed tile is first asked for again.", reason: `${TILE_EVIDENCE}'s setting.`, source: LOADER,
  }),
quantity({
    id: "scene.panorama.tileViewShare", label: "Atlas available to the view", unit: "fraction", min: 0.05, max: 1, fallback: 0.75, section: "tiles", level: "all",
    description: "The fraction of atlas slots the visible view may use. Remaining slots hold the margin and arriving tiles; less space may select a coarser level.",
    reason: "Preserves the prior scheduler's three-quarter share and makes its capacity policy visible. This extraction adds no new performance qualification.", source: "src/tileScheduler.ts",
  }),
quantity({
    id: "scene.panorama.tileRetryBackoffDoublings", label: "Retry delay doublings", unit: "count", min: 0, max: 16, fallback: 8, step: 1, section: "tiles", level: "all",
    description: "Maximum number of times the first retry delay doubles. After the retry count is exceeded, a tile waits this maximum delay before another attempt.",
    reason: "Preserves the prior scheduler's eight doublings while exposing the maximum wait. This extraction adds no network performance qualification.", source: "src/tileScheduler.ts",
  }),
{
    id: "scene.panorama.tileOutlines", label: "Tile outlines",
    description: "Draws each tile's edges and tints it by its level, from the coarsest: orange, yellow, green and blue; red where the preview shows because no tile has arrived.",
    unit: "none", kind: "boolean", default: false, defaultReason: "Off shows the photograph; on shows how it loads.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: RENDERER,
  }
];
