import { MIB, rgba8Bytes } from "../../scenes/budget";
import type { DeviceContext, ParameterBounds, ParameterSpec, ParameterUnit } from "../types";

/**
 * Scenes and their panoramas (docs/proposals/panorama-scenes.md §6), in three
 * tabs. The Scenes tab holds what the globe shows and what both sides share:
 * the scene, its orbs, their motion and the loading budgets. The panorama's
 * own tab holds its image detail. The 360 image settings tab, shown only
 * inside a panorama, holds what matters only there: sharpness, the field of
 * view, looking and levelling. Only mechanisms that exist register here; the
 * mesh-sphere, fisheye, output-cache, decluttering and terrain-streaming
 * choices join when their stages land. Defaults not derived from the device
 * are provisional development values, not measured device recommendations.
 */
export const SCENES_TAB = "scenes";
/** The tab of the panorama on screen, titled "360: <title>". */
export const PANORAMA_TAB = "panorama";
/** Shown only inside a panorama. */
export const PANORAMA_SETTINGS_TAB = "panorama-settings";

const LOADER = "src/scenes/loadScene.ts";
const RESOURCES = "src/scenes/panoramaResources.ts";
const RENDERER = "src/engine/babylon/panorama/panoramaRenderer.ts";
const INPUT = "src/scenes/panoramaInput.ts";
const PROVISIONAL = "A provisional development value chosen to exercise a bounded path; not measured on a device.";
const TEXELS_PER_PX: ParameterUnit = { id: "texels-per-px", text: "texels/px" };
const CSS_PX: ParameterUnit = { id: "css-px", text: "CSS px" };

/** The device's largest 2D texture side, bounding sizes that become one texture. */
function textureSideBounds(min: number, cap: number): (context: DeviceContext) => ParameterBounds {
  return context => (context.maxTextureSize
    ? { min, max: Math.max(min, Math.min(cap, context.maxTextureSize)), reason: `this renderer's largest texture is ${context.maxTextureSize} px` }
    : { min, max: cap, reason: "the renderer's texture limit is not known until it starts" });
}

/** WebGPU's default largest texture side, assumed until the renderer reports its own. */
const DEFAULT_TEXTURE_SIDE = 8192;
/** Room for orb previews: 64 cubes of 256 px faces, 2 MiB each with mips. */
const PREVIEW_ROOM_MIB = 128;
/** Room for preview faces decoding while a whole image arrives: ten 256 px cubes. */
const PREVIEW_DECODE_MIB = 16;

/** The widest whole panorama the renderer can hold: an equirectangular image as wide as its texture limit. */
function widestImage(context: DeviceContext): { width: number; from: string } {
  return context.maxTextureSize
    ? { width: context.maxTextureSize, from: `this renderer's ${context.maxTextureSize} px texture limit` }
    : { width: DEFAULT_TEXTURE_SIDE, from: `${DEFAULT_TEXTURE_SIDE} px, WebGPU's default texture limit, until the renderer reports its own` };
}
/** GPU MiB of that image with its mips. */
const widestGpuMiB = (width: number): number => rgba8Bytes(width, width / 2) / MIB;
/** Decoded MiB of that image: four bytes a pixel. */
const widestDecodedMiB = (width: number): number => (4 * width * (width / 2)) / MIB;

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

const CONTENT: readonly ParameterSpec[] = [
  quantity({
    id: "scene.manifestMiB", label: "Largest scene manifest", unit: "MiB", min: 0.1, max: 16, fallback: 2, scale: "log2", section: "content", level: "all",
    description: "A manifest larger than this is refused before it is parsed.", reason: "Bounds parsing; far above a scene of a few thousand panoramas.", source: LOADER,
  }),
  quantity({
    id: "scene.entityLimit", label: "Most entities in a scene", unit: "count", min: 1, max: 100_000, fallback: 2000, scale: "log2", step: 0.25, section: "content", level: "all",
    description: "A scene listing more entities is refused before anything is built for it.", reason: "Bounds the discovery data held for the list; the stage 2 scale fixture uses 200.", source: LOADER,
  }),
  quantity({
    id: "scene.assetLimit", label: "Most images in a scene", unit: "count", min: 1, max: 100_000, fallback: 2000, scale: "log2", step: 0.25, section: "content", level: "all",
    description: "A scene describing more images is refused before any resource is described.", reason: "Bounds resource descriptors, one per image.", source: LOADER,
  }),
  quantity({
    id: "scene.linkLimit", label: "Most links in a scene", unit: "count", min: 0, max: 1_000_000, fallback: 10_000, scale: "linear", step: 1, section: "content", level: "all",
    description: "A scene with more links between its panoramas is refused.", reason: "Bounds the navigation graph: five links for each of 2000 panoramas.", source: LOADER,
  }),
];

/** Scenes → Orbs: how the orbs on the globe look and are picked. */
const APPEARANCE: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.previewFov", label: "Orb window angle", unit: "deg", min: 30, max: 150, fallback: 90, step: 1, section: "appearance",
    description: "How much of the panorama an orb shows at once, as a flat window toward it. Wider shows more and bends it less on entry.",
    reason: "The CPU visual contract's baseline, a 90° flat window.", source: RENDERER,
  }),
  quantity({
    id: "scene.panorama.previewDensity", label: "Orb image sharpness", unit: TEXELS_PER_PX, min: 0.25, max: 4, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "Image texels per rendered pixel at an orb's centre, as it is drawn, that preview loading aims for. Higher loads larger previews.",
    reason: "One texel per pixel, an understandable heuristic; centre density is not a bound on the rim.", source: LOADER,
  }),
  {
    id: "scene.panorama.previewFaceRange", label: "Preview cube size", description: "The smallest and largest preview cube faces that may be loaded for orbs. Each orb shows its smallest allowed preview first. An orb on screen that is drawn with more pixels than that loads the preview its size asks for at the orb image sharpness, the largest orb first, and entering a panorama loads its largest.",
    unit: "px", kind: "range", bounds: textureSideBounds(16, 2048), step: 1, scale: "log2",
    default: { min: 64, max: 256 }, defaultReason: "A 64 px cube is as sharp as an orb at its smallest on most screens, so a whole scene's first previews are small; 256 px serves an orb at its largest and the moment a panorama opens.",
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.markerRadiusMeters", label: "Orb radius", unit: "m", min: 0.1, max: 100, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "The size of an orb whose scene gives none. The on-screen size limits below still apply.",
    reason: "A metre: a person-sized marker.", source: RENDERER,
  }),
  {
    id: "scene.panorama.markerDiameter", label: "Orb size on screen", description: "The smallest and largest an orb is drawn, whatever its distance; its effective radius follows, for drawing, depth and picking alike.",
    unit: CSS_PX, kind: "range", bounds: () => ({ min: 4, max: 256 }), step: 1, scale: "log2",
    default: { min: 24, max: 96 }, defaultReason: "Prototype discoverability; a portrait-phone trial has not been run.",
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: RENDERER,
  },
  quantity({
    id: "scene.panorama.hitTargetDiameter", label: "Orb touch target", unit: CSS_PX, min: 24, max: 96, fallback: 44, step: 1, section: "appearance",
    description: "How close to a small orb's centre a click or tap still selects it. Where several are that close, the Scenes list offers them.",
    reason: "44 px, the common minimum touch target, as a separate tolerance from the drawn silhouette.", source: LOADER,
  }),
];

/**
 * Scenes → Motion: the animations between the globe and a panorama, and the
 * reduced-motion choice that governs them all. They play on the globe side
 * too, so they stay where the globe can reach them.
 */
const MOTION: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.hoverDuration", label: "Hover growth", unit: "ms", min: 0, max: 1000, fallback: 120, step: 10, section: "motion",
    description: "How long an orb takes to grow while the pointer is over it, and to shrink back, when its scene asks it to grow; 0 jumps.",
    reason: "Quick enough to follow the pointer, long enough to read as growth; visual check pending.", source: LOADER,
  }),
  {
    id: "scene.panorama.flightDuration", label: "Fly into and out of 360 images",
    description: "How long the camera takes to fly into an orb when its 360 image is entered, and to pull back out of it, facing the way the view faces, when it is left. Cut short by a press, a swipe or Escape, the map takes the camera where it got to, still moving, and slows it as its glide does (Camera → Glide); the swipe or drag goes on moving it. Off opens the orb where it stands (Entry reveal) and fades back to the map view it was entered from.",
    unit: "ms", kind: "number", named: [{ id: "off", label: "Off" }], bounds: () => ({ min: 100, max: 5000 }), step: 50, scale: "linear",
    default: 1000, defaultReason: "On, as asked: a second is long enough to follow the camera in and out, and short enough not to wait on; motion trial pending.",
    home: { tab: SCENES_TAB, section: "motion", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.expandDuration", label: "Entry reveal", unit: "ms", min: 0, max: 2000, fallback: 350, step: 10, section: "motion",
    description: "How long an orb takes to open out to the whole view on entry when the camera does not fly into it.", reason: "A short reveal prototype; motion trial pending.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.fadeDuration", label: "Fades", unit: "ms", min: 0, max: 1000, fallback: 150, step: 10, section: "motion",
    description: "How long exits without a flight, links, sharper images and entries without a visible orb take to fade.", reason: "A short blend; visual check pending.", source: LOADER,
  }),
  {
    id: "scene.panorama.reducedMotion", label: "Motion", description: "Whether panorama transitions animate, or cut with the short fade below.",
    unit: "none", kind: "choice",
    choices: [
      { id: "system", label: "As the system asks", description: "Follow the operating system's reduced-motion preference." },
      { id: "reduce", label: "Reduce", description: "Always cut or fade briefly; no flight, reveal, levelling or glide." },
    ],
    default: "system", defaultReason: "Respect the operating system, and allow a stricter choice here.",
    home: { tab: SCENES_TAB, section: "motion", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.reducedFadeDuration", label: "Reduced-motion fade", unit: "ms", min: 0, max: 250, fallback: 0, step: 10, section: "motion",
    description: "The fade used instead of animation when motion is reduced; 0 cuts.", reason: "A cut avoids animation.", source: LOADER,
  }),
];

/** A default no larger than the parameter's bound. */
function capped(value: number, max: number): number {
  return Math.min(max, Math.ceil(value));
}

/**
 * Scenes → Loading and memory. The budgets serve both sides: the orbs'
 * previews load on the globe and the whole images inside a panorama, from
 * the same pools. The three GPU and decode budgets are derived from the
 * renderer's texture limit, so the default loads the largest image a scene
 * offers that the renderer can hold.
 */
const LOADING: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.sourceGpuMiB", label: "Panorama GPU memory",
    description: "GPU memory for panorama images and their mips: the orbs' previews, the image on screen and a sharper one replacing it.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 1, max: 4096 }), step: 0.25, scale: "log2",
    default: context => {
      const { width, from } = widestImage(context);
      return { value: capped(PREVIEW_ROOM_MIB + 2 * widestGpuMiB(width), 4096), derivedFrom: `${PREVIEW_ROOM_MIB} MiB of previews and two ${width} px images with mips, for ${from}` };
    },
    defaultReason: `Room for the orbs' previews (${PREVIEW_ROOM_MIB} MiB: 64 cubes of 256 px faces) and two of the widest images the renderer can hold, the one on screen and a sharper one replacing it, so no panorama stays below the largest image it offers.`,
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  {
    id: "scene.panorama.overlapMiB", label: "Replacement overlap",
    description: "How much of the panorama GPU memory an incoming image may hold while the outgoing one is still shown. Part of that memory, never extra.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 0, max: 4096 }), step: 1, scale: "linear",
    default: context => {
      const { width, from } = widestImage(context);
      return { value: capped(widestGpuMiB(width), 4096), derivedFrom: `one ${width} px image with mips, for ${from}` };
    },
    defaultReason: "One of the widest images the renderer can hold, with mips: the largest sharper image that can replace the one on screen.",
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  {
    id: "scene.panorama.decodedMiB", label: "Decoded images",
    description: "Memory for images decoded and waiting to be copied to the GPU, reserved from each image's header before it is decoded.",
    unit: "MiB", kind: "number", bounds: () => ({ min: 1, max: 2048 }), step: 0.25, scale: "log2",
    default: context => {
      const { width, from } = widestImage(context);
      return { value: capped(widestDecodedMiB(width) + PREVIEW_DECODE_MIB, 2048), derivedFrom: `one ${width} × ${width / 2} image and ${PREVIEW_DECODE_MIB} MiB of preview faces, for ${from}` };
    },
    defaultReason: `One decoded image as wide as the renderer can hold, four bytes a pixel, and ${PREVIEW_DECODE_MIB} MiB for preview faces decoding while it arrives.`,
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  quantity({
    id: "scene.panorama.encodedMiB", label: "Downloaded images", unit: "MiB", min: 1, max: 512, fallback: 32, scale: "log2", step: 0.25, section: "loading",
    description: "Downloaded image files held or arriving before they are decoded.", reason: "Bounds response storage. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.responseMiB", label: "Largest image file", unit: "MiB", min: 0.25, max: 256, fallback: 16, scale: "log2", step: 0.25, section: "loading", level: "all",
    description: "A single image file larger than this is stopped while it downloads. Never more than Downloaded images.",
    reason: "Catches an oversized response early. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.requests", label: "Image requests at once", unit: "count", min: 1, max: 32, fallback: 16, step: 1, section: "loading",
    description: "Preview and whole-image downloads in flight at the same time; tiles have their own count. An orb's preview is six small files, which wait on the connection's round trips, not on its bandwidth, so more at once shows a scene's orbs sooner. Files already saved are read from the disk and do not count.",
    reason: "Sixteen showed every orb of a 60-panorama tour in 3 s on its HTTP/2 host, where four took 6 to 19 s (docs/proposals/panorama-scenes.md, \"Loading once\"). Over HTTP/1.1 the browser sends six at once whatever this says.", source: RESOURCES,
  }),
  {
    id: "scene.panorama.previewSheets", label: "Orb previews in one file",
    description: "Where a scene has put its orbs' smallest previews into one image, load that image and show every orb from it: one request, not six for each orb. Off, each orb loads its own six files. Either way an orb drawn larger than that preview loads its own sharper one.",
    unit: "none", kind: "boolean", default: true,
    defaultReason: "One request shows a scene's orbs. On the UMN tour's build with every response held 100 ms, all 60 orbs were shown 1.5 s after the page opened from the sheet, as the app finished starting, and after 4.0 s from their 360 files sixteen at a time (docs/proposals/panorama-scenes.md, \"Loading once\").",
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  quantity({
    id: "scene.panorama.decodes", label: "Image decodes at once", unit: "count", min: 1, max: 8, fallback: 1, step: 1, section: "loading", level: "all",
    description: "Images the browser decodes at the same time.", reason: "One prevents decode bursts. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.uploadMiBPerFrame", label: "Upload per frame", unit: "MiB", min: 0.25, max: 64, fallback: 4, scale: "log2", step: 0.25, section: "loading",
    description: "Image data copied to the GPU in one frame; a larger image is copied in rows over several frames.",
    reason: "Bounds upload work per frame; it is not a timing guarantee. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.uploadOutstandingMiB", label: "Uploads in flight", unit: "MiB", min: 0.25, max: 256, fallback: 16, scale: "log2", step: 0.25, section: "loading", level: "all",
    description: "Image data submitted to the GPU and not yet confirmed complete.", reason: "Bounds outstanding staging. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.requestTimeout", label: "Image request timeout", unit: "s", min: 1, max: 120, fallback: 30, step: 1, section: "loading", level: "all",
    description: "An image download that takes longer is stopped and reported; retrying is by hand.", reason: "Recovers from a hanging load.", source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.prefetchCount", label: "Linked panoramas loaded ahead", unit: "count", min: 0, max: 8, fallback: 0, step: 1, section: "loading",
    description: "How many panoramas linked from the one you are in may be loaded before you follow a link. Both this and the size below must allow it.",
    reason: "None: no speculative transfer unless you ask for it.", source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.prefetchMiB", label: "Loaded ahead, most", unit: "MiB", min: 0, max: 128, fallback: 0, step: 0.25, section: "loading",
    description: "Downloaded bytes spent on linked panoramas before you follow a link, per panorama you are in.",
    reason: "None: no speculative transfer unless you ask for it.", source: RESOURCES,
  }),
];

/** Bytes of one stored tile of the prepared tiled cubes: 194 texels a side, RGBA. */
const TILE_BYTES = 194 * 194 * 4;
/** The tiles of a prepared cube: four levels of 1536-texel faces in 192-texel tiles, 6 · (1 + 4 + 16 + 64). */
const TILES_OF_A_CUBE = 510;
/** The tiled cubes' source of truth: the prototype that measured them. */
const TILE_EVIDENCE = "benchmarks/eac-progressive-prototype";

/**
 * Scenes → Tiled images: how a tiled cube loads (src/scenes/tiles/). The
 * sharpness target and the image detail choose its levels, the fades its
 * tiles fade in over, and the request timeout and largest file bound each
 * tile; these are what only tiles have.
 */
const TILES: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.tileMemoryMiB", label: "Tile memory", unit: "MiB", min: 1, max: 1024, fallback: Math.ceil((TILES_OF_A_CUBE * TILE_BYTES) / MIB * 4) / 4, scale: "log2", step: 0.25, section: "tiles",
    description: "The most GPU memory the tiles of a panorama may take: one atlas, allocated when the panorama is entered, with a slot for each of its tiles up to this. With room for all of them, a part you looked at stays sharp when you look back. With less, the tiles out of view give up their slots and are read again from the saved images, and the view drops a level of detail before it would go without tiles. Part of the panorama GPU memory.",
    reason: `Every tile of a panorama as the tools prepare it: ${TILES_OF_A_CUBE} tiles of 194 texels, about what its whole 6144 px image takes. Nothing looked at is loaded twice. ${TILE_EVIDENCE} ran on 196 tiles, a phone's view and its margin; a turn right round at a laptop's window needs more, and brought tiles back in on every look back.`, source: RESOURCES,
  }),
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
];

/** One panorama's tiles as the tools prepare them, MiB: 510 tiles, 6.5 KB each at the finest level. */
const TILED_PANORAMA_MIB = 3.3;
/** The saved images' default limit, MiB. */
const SAVED_MIB = 256;

/**
 * Scenes → Saved images: what is kept on disk between visits
 * (src/scenes/mediaStore.ts), so that no file is downloaded twice.
 */
const SAVED: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.savedMiB", label: "Saved images", unit: "MiB", min: 0, max: 4096, fallback: SAVED_MIB, step: 1, section: "saved",
    description: "Disk space for the scene images the app keeps between visits: orb previews, tiles and whole images. Each file is kept under its image's revision, so it is downloaded once; a reload, a later visit and a look back at part of a 360 image read it from the disk. Past this, the images unused longest go first, whole. 0 keeps nothing.",
    reason: `Room for the tiles of about ${Math.floor(SAVED_MIB / TILED_PANORAMA_MIB)} panoramas looked all around, ${TILED_PANORAMA_MIB} MiB each as the tools prepare them, with every orb's previews; only what was looked at is kept.`,
    source: "src/scenes/mediaStore.ts",
  }),
];

/** The panorama's tab → Image detail: the one control the tab has, beside what it shows and why. */
const PANORAMA: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.immersionWidth", label: "Image detail",
    description: "The widest image loaded inside a panorama, in pixels around the whole turn: an equirectangular image's width, or four cube faces. The largest image a panorama offers up to this is shown, within the memory budgets; at its largest, only the renderer's texture limit applies.",
    unit: "px", kind: "number", scale: "log2", track: { reversed: true, ramp: "detail" },
    bounds: context => (context.maxTextureSize
      ? { min: 256, max: Math.max(256, context.maxTextureSize), reason: `this renderer's largest texture is ${context.maxTextureSize} px` }
      : { min: 256, max: 16384, reason: "the renderer's texture limit is not known until it starts" }),
    default: context => {
      const { width, from } = widestImage(context);
      return { value: width, derivedFrom: from };
    },
    defaultReason: "The most detailed image: each panorama opens at the largest image it offers. Lower it to spend less memory and download.",
    home: { tab: PANORAMA_TAB, section: "detail", level: "main" }, appliesLive: true, source: LOADER,
  },
];

/** 360 image settings: what matters only inside a panorama. */
const PANORAMA_SETTINGS: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.representation", label: "Representation",
    description: "How the photograph arrives inside a panorama, where the panorama offers more than one kind. Tiles load the part of the view that needs them, at the detail it needs, so the view sharpens in a second or two; a whole image is sharp only once all of it has arrived. A panorama without the chosen kind shows the kind it has.",
    unit: "none", kind: "choice",
    choices: [
      { id: "equi-angular-tiles", label: "Equi-angular cube tiles", description: "A cube whose texels are spread evenly over each face: the fewest bytes for the same sharpness." },
      { id: "cube-tiles", label: "Cube tiles", description: "An ordinary cube map in the same tiles: coarser in the middle of each face, finer at its corners." },
      { id: "whole", label: "Whole image", description: "One equirectangular image, the largest the image detail allows." },
    ],
    default: "equi-angular-tiles",
    defaultReason: `Measured in ${TILE_EVIDENCE}: at 2 Mbit/s the view was within 1 dB of finished in 1.3 s with equi-angular tiles, where whole images of 4.7 and 5.5 MiB took 20 s and more; and cube tiles needed 15% more bytes for the same quality.`,
    home: { tab: PANORAMA_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.tileOutlines", label: "Tile outlines",
    description: "Draws each tile's edges and tints it by its level, from the coarsest: orange, yellow, green and blue; red where the preview shows because no tile has arrived.",
    unit: "none", kind: "boolean", default: false, defaultReason: "Off shows the photograph; on shows how it loads.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: RENDERER,
  },
  {
    id: "scene.panorama.immersionDensity", label: "Sharpness target",
    description: "Off, a panorama shows the largest image its image detail allows. A number loads instead the smallest image that gives this many image texels per rendered pixel at the centre of the view, which saves memory and download on small screens.",
    unit: TEXELS_PER_PX, kind: "number", named: [{ id: "off", label: "Off" }], bounds: () => ({ min: 0.25, max: 4 }), step: 0.25, scale: "log2",
    default: "off", defaultReason: "Off: the most detailed image, as the image detail asks.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.verticalFovRange", label: "Zoom range", description: "The narrowest and widest vertical view inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: 20, max: 120, reason: "Beyond these a flat view distorts or magnifies past any source." }), step: 1,
    default: { min: 35, max: 90 }, defaultReason: "A prototype look range.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: INPUT,
  },
  {
    id: "scene.panorama.pitchRange", label: "Look up and down", description: "How far below and above the horizon you may look inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: -89.9, max: 89.9, reason: "Looking exactly up or down leaves no heading to turn about." }), step: 0.1,
    default: { min: -85, max: 85 }, defaultReason: "Avoids the degenerate straight-up and straight-down looks.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: INPUT,
  },
  quantity({
    id: "scene.panorama.dragSensitivity", label: "Drag to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How far the view turns for each CSS pixel you drag inside a panorama.", reason: "A starting pointer gain; user trial pending.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.swipeSensitivity", label: "Swipe to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How far the view turns for each CSS pixel a two-finger trackpad swipe scrolls inside a panorama, with the input method set to Trackpad.",
    reason: "The same as dragging; user trial pending.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.lookRate", label: "Key and stick look", unit: "deg/s", min: 1, max: 360, fallback: 90, scale: "log2", step: 0.1, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How fast arrow keys and a fully pushed stick turn the view.", reason: "A quarter turn a second.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomPerNotch", label: "Wheel zoom", unit: "per-notch", min: 0.01, max: 1, fallback: 0.1, scale: "log2", step: 0.1, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How much one wheel notch narrows or widens the view, as a fraction of the view's tangent.", reason: "A tenth: multiplicative steps.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomRate", label: "Key and trigger zoom", unit: "per-s", min: 0.01, max: 4, fallback: 0.5, scale: "log2", step: 0.1, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How fast held keys and triggers zoom, as a fraction of the view's tangent per second.", reason: "Halves or doubles the tangent in about 1.4 s.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.pinchGain", label: "Pinch zoom", unit: "ratio", min: 0.1, max: 4, fallback: 1, scale: "log2", step: 0.1, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How strongly spreading two fingers narrows the view; 1 keeps the image under your fingers.", reason: "One to one with finger separation.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.inertiaHalfLife", label: "Look glide", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10, tab: PANORAMA_SETTINGS_TAB, section: "looking",
    description: "How long the view keeps turning after a drag, as the time for its speed to halve; 0 stops at once.", reason: "A brief optional continuation.", source: INPUT,
  }),
  {
    id: "scene.panorama.entryOrientation", label: "On entering", description: "Where you look after entering: level at your current heading, or where the scene suggests.",
    unit: "none", kind: "choice",
    choices: [
      { id: "level-current", label: "Level, same heading", description: "Keep the heading you came in with, then level the view." },
      { id: "authored", label: "The scene's view", description: "Turn to the panorama's suggested view." },
    ],
    default: "level-current", defaultReason: "Keeps your bearing; a scene's view may be applied from the list.",
    home: { tab: PANORAMA_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.orientDuration", label: "Levelling", unit: "ms", min: 0, max: 2000, fallback: 250, step: 10, tab: PANORAMA_SETTINGS_TAB, section: "entering",
    description: "How long the view takes to level or turn after entering.", reason: "A separate, short levelling phase.", source: LOADER,
  }),
];

export const SCENE_PARAMETERS: readonly ParameterSpec[] = [...CONTENT, ...APPEARANCE, ...MOTION, ...LOADING, ...TILES, ...SAVED, ...PANORAMA, ...PANORAMA_SETTINGS];

export const SCENE_SECTION_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  [SCENES_TAB, "content", "Content"],
  [SCENES_TAB, "appearance", "Orbs"],
  [SCENES_TAB, "motion", "Motion"],
  [SCENES_TAB, "loading", "Loading and memory"],
  [SCENES_TAB, "tiles", "Tiled images"],
  [SCENES_TAB, "saved", "Saved images"],
  [SCENES_TAB, "credits", "Credits"],
  [PANORAMA_TAB, "photograph", "Photograph"],
  [PANORAMA_TAB, "links", "Links"],
  [PANORAMA_TAB, "detail", "Image detail"],
  [PANORAMA_SETTINGS_TAB, "image", "Image"],
  [PANORAMA_SETTINGS_TAB, "looking", "Looking"],
  [PANORAMA_SETTINGS_TAB, "entering", "Entering"],
];
