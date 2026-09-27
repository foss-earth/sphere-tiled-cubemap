import type { DeviceContext, ParameterBounds, ParameterSpec, ParameterUnit } from "../types";

/**
 * The Scenes tab: loading custom scenes and navigating their panoramas
 * (docs/proposals/panorama-scenes.md §6). Only mechanisms that exist register
 * here; the mesh-sphere, fisheye, output-cache, decluttering and
 * terrain-streaming choices join when their stages land. Every default is a
 * provisional development value, not a measured device recommendation.
 */
export const SCENES_TAB = "scenes";

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

interface Quantity {
  id: string;
  label: string;
  description: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  fallback: number;
  reason: string;
  section: "content" | "appearance" | "loading" | "navigation";
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
    home: { tab: SCENES_TAB, section: spec.section, level: spec.level ?? "main" },
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

const APPEARANCE: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.previewFov", label: "Orb window angle", unit: "deg", min: 30, max: 150, fallback: 90, step: 1, section: "appearance",
    description: "How much of the panorama an orb shows at once, as a flat window toward it. Wider shows more and bends it less on entry.",
    reason: "The CPU visual contract's baseline, a 90° flat window.", source: RENDERER,
  }),
  quantity({
    id: "scene.panorama.previewDensity", label: "Orb image sharpness", unit: TEXELS_PER_PX, min: 0.25, max: 4, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "Image texels per rendered pixel at an orb's centre that preview loading aims for. Higher loads larger previews.",
    reason: "One texel per pixel, an understandable heuristic; centre density is not a bound on the rim.", source: RESOURCES,
  }),
  {
    id: "scene.panorama.previewFaceRange", label: "Preview cube size", description: "The smallest and largest preview cube faces that may be loaded for orbs.",
    unit: "px", kind: "range", bounds: textureSideBounds(16, 2048), step: 1, scale: "log2",
    default: { min: 64, max: 256 }, defaultReason: "Small previews: 43 cubes of 128 px take about 21.5 MiB with mips.",
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: RESOURCES,
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
    reason: "44 px, the common minimum touch target, as a separate tolerance from the drawn silhouette.", source: "src/scenes/loadScene.ts",
  }),
  quantity({
    id: "scene.panorama.immersionDensity", label: "Immersion sharpness", unit: TEXELS_PER_PX, min: 0.25, max: 4, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "Image texels per rendered pixel at the centre of the view that loading aims for inside a panorama.",
    reason: "One texel per pixel, the visible quality target.", source: RESOURCES,
  }),
];

const LOADING: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.immersionMaxSide", label: "Largest immersion image", description: "The widest image loaded for immersion, whatever the budgets allow.",
    unit: "px", kind: "number", bounds: textureSideBounds(256, 16384), step: 0.25, scale: "log2",
    default: context => ({ value: Math.min(8192, context.maxTextureSize ?? 8192), derivedFrom: context.maxTextureSize ? `8192 px or this renderer's ${context.maxTextureSize} px limit` : "8192 px" }),
    defaultReason: "A dimensional cap only; the memory budgets decide admission.",
    home: { tab: SCENES_TAB, section: "loading", level: "main" }, appliesLive: true, source: RESOURCES,
  },
  quantity({
    id: "scene.panorama.sourceGpuMiB", label: "Panorama GPU memory", unit: "MiB", min: 1, max: 4096, fallback: 128, scale: "log2", step: 0.25, section: "loading",
    description: "GPU memory for panorama images and their mips: previews, the one on screen and a replacement coming in.",
    reason: "Room for the previews and two 4096-wide images, to exercise a bounded path. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.overlapMiB", label: "Replacement overlap", unit: "MiB", min: 0, max: 4096, fallback: 48, scale: "linear", step: 1, section: "loading",
    description: "How much of the panorama GPU memory an incoming image may hold while the outgoing one is still shown. Part of that memory, never extra.",
    reason: "One 4096-wide replacement. " + PROVISIONAL, source: RESOURCES,
  }),
  quantity({
    id: "scene.panorama.decodedMiB", label: "Decoded images", unit: "MiB", min: 1, max: 2048, fallback: 64, scale: "log2", step: 0.25, section: "loading",
    description: "Memory for images decoded and waiting to be copied to the GPU, reserved from each image's header before it is decoded.",
    reason: "Room for a 4096-wide decode. " + PROVISIONAL, source: RESOURCES,
  }),
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
    id: "scene.panorama.requests", label: "Image requests at once", unit: "count", min: 1, max: 16, fallback: 4, step: 1, section: "loading",
    description: "Image downloads in flight at the same time.", reason: "Lets previews load without fanning out across a scene.", source: RESOURCES,
  }),
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

const NAVIGATION: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.verticalFovRange", label: "Zoom range", description: "The narrowest and widest vertical view inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: 20, max: 120, reason: "Beyond these a flat view distorts or magnifies past any source." }), step: 1,
    default: { min: 35, max: 90 }, defaultReason: "A prototype look range.",
    home: { tab: SCENES_TAB, section: "navigation", level: "main" }, appliesLive: true, source: INPUT,
  },
  {
    id: "scene.panorama.pitchRange", label: "Look up and down", description: "How far below and above the horizon you may look inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: -89.9, max: 89.9, reason: "Looking exactly up or down leaves no heading to turn about." }), step: 0.1,
    default: { min: -85, max: 85 }, defaultReason: "Avoids the degenerate straight-up and straight-down looks.",
    home: { tab: SCENES_TAB, section: "navigation", level: "main" }, appliesLive: true, source: INPUT,
  },
  {
    id: "scene.panorama.entryOrientation", label: "On entering", description: "Where you look after entering: level at your current heading, or where the scene suggests.",
    unit: "none", kind: "choice",
    choices: [
      { id: "level-current", label: "Level, same heading", description: "Keep the heading you came in with, then level the view." },
      { id: "authored", label: "The scene's view", description: "Turn to the panorama's suggested view." },
    ],
    default: "level-current", defaultReason: "Keeps your bearing; a scene's view may be applied from the list.",
    home: { tab: SCENES_TAB, section: "navigation", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.expandDuration", label: "Entry reveal", unit: "ms", min: 0, max: 2000, fallback: 350, step: 10, section: "navigation",
    description: "How long an orb takes to open out to the whole view on entry.", reason: "A short reveal prototype; motion trial pending.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.orientDuration", label: "Levelling", unit: "ms", min: 0, max: 2000, fallback: 250, step: 10, section: "navigation",
    description: "How long the view takes to level or turn after entering.", reason: "A separate, short levelling phase.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.fadeDuration", label: "Fades", unit: "ms", min: 0, max: 1000, fallback: 150, step: 10, section: "navigation",
    description: "How long exits, links and entries without a visible orb take to fade.", reason: "A short blend; visual check pending.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.hoverDuration", label: "Hover growth", unit: "ms", min: 0, max: 1000, fallback: 120, step: 10, section: "navigation",
    description: "How long an orb takes to grow while the pointer is over it, and to shrink back, when its scene asks it to grow; 0 jumps.",
    reason: "Quick enough to follow the pointer, long enough to read as growth; visual check pending.", source: LOADER,
  }),
  {
    id: "scene.panorama.reducedMotion", label: "Motion", description: "Whether panorama transitions animate, or cut with the short fade below.",
    unit: "none", kind: "choice",
    choices: [
      { id: "system", label: "As the system asks", description: "Follow the operating system's reduced-motion preference." },
      { id: "reduce", label: "Reduce", description: "Always cut or fade briefly; no reveal, levelling or glide." },
    ],
    default: "system", defaultReason: "Respect the operating system, and allow a stricter choice here.",
    home: { tab: SCENES_TAB, section: "navigation", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.reducedFadeDuration", label: "Reduced-motion fade", unit: "ms", min: 0, max: 250, fallback: 0, step: 10, section: "navigation",
    description: "The fade used instead of animation when motion is reduced; 0 cuts.", reason: "A cut avoids animation.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.dragSensitivity", label: "Drag to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, section: "navigation",
    description: "How far the view turns for each CSS pixel you drag inside a panorama.", reason: "A starting pointer gain; user trial pending.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.swipeSensitivity", label: "Swipe to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, section: "navigation",
    description: "How far the view turns for each CSS pixel a two-finger trackpad swipe scrolls inside a panorama, with the input method set to Trackpad.",
    reason: "The same as dragging; user trial pending.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.lookRate", label: "Key and stick look", unit: "deg/s", min: 1, max: 360, fallback: 90, scale: "log2", step: 0.1, section: "navigation",
    description: "How fast arrow keys and a fully pushed stick turn the view.", reason: "A quarter turn a second.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomPerNotch", label: "Wheel zoom", unit: "per-notch", min: 0.01, max: 1, fallback: 0.1, scale: "log2", step: 0.1, section: "navigation",
    description: "How much one wheel notch narrows or widens the view, as a fraction of the view's tangent.", reason: "A tenth: multiplicative steps.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomRate", label: "Key and trigger zoom", unit: "per-s", min: 0.01, max: 4, fallback: 0.5, scale: "log2", step: 0.1, section: "navigation",
    description: "How fast held keys and triggers zoom, as a fraction of the view's tangent per second.", reason: "Halves or doubles the tangent in about 1.4 s.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.pinchGain", label: "Pinch zoom", unit: "ratio", min: 0.1, max: 4, fallback: 1, scale: "log2", step: 0.1, section: "navigation",
    description: "How strongly spreading two fingers narrows the view; 1 keeps the image under your fingers.", reason: "One to one with finger separation.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.inertiaHalfLife", label: "Look glide", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10, section: "navigation",
    description: "How long the view keeps turning after a drag, as the time for its speed to halve; 0 stops at once.", reason: "A brief optional continuation.", source: INPUT,
  }),
];

export const SCENE_PARAMETERS: readonly ParameterSpec[] = [...CONTENT, ...APPEARANCE, ...LOADING, ...NAVIGATION];

export const SCENE_SECTION_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  [SCENES_TAB, "content", "Content"],
  [SCENES_TAB, "appearance", "Appearance"],
  [SCENES_TAB, "loading", "Loading and memory"],
  [SCENES_TAB, "navigation", "Navigation"],
  [SCENES_TAB, "credits", "Credits"],
];
