/**
 * `foss-earth-scene` version 1: the document a scene manifest holds. See
 * docs/scenes/format.md and the published JSON Schema,
 * src/scenes/foss-earth-scene-1.schema.json (`foss-earth/scenes/schema.json`).
 *
 * Assets identify pixel content and its complete representations; panorama
 * entities place and orient that content; groups are ordered lists of entity
 * ids. References are by id, never array position.
 */
import type { CubeFaceName } from "./panoramaMath";

export const SCENE_FORMAT = "foss-earth-scene";
export const SCENE_FORMAT_VERSION = 1;

/** Namespaced extension data, such as `{"example.tour": {...}}`. Never executed. */
export type SceneExtensions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface HeightRecord {
  /** Metres above the WGS84 ellipsoid. */
  meters: number;
  datum: "WGS84-ellipsoid";
  /** Where the value came from, and any conversion made during preparation. */
  source?: string;
  uncertaintyMeters?: number;
}

export interface CaptureRecord {
  longitudeDeg: number;
  latitudeDeg: number;
  /** Absent or null when unknown; never a silent zero. */
  height?: HeightRecord | null;
  horizontalAccuracyMeters?: number;
}

export interface ImagePoseRecord {
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /**
   * Whether the heading was set against true north. False: the image faces
   * an arbitrary direction, though pitch and roll may still level it.
   * Absent: the scene does not say.
   */
  aligned?: boolean;
}

/**
 * How orbs look: the scene's `markerStyle`, which a marker's own `style`
 * overrides one property at a time. Null turns an inherited property off.
 */
export interface MarkerStyleRecord {
  /** A ring just outside the orb's silhouette: a CSS hex colour, `#rrggbb` or `#rrggbbaa`, and its width in CSS px. */
  outline?: { color: string; widthPx: number } | null;
  /** While a pointer is over the orb, it grows to `scale` times its size on screen. Entering still takes a click. */
  hover?: { scale: number } | null;
}

export interface MarkerRecord {
  mode: "ground-relative" | "capture-relative";
  eastM: number;
  northM: number;
  offsetM: number;
  /** Overrides `scene.panorama.markerRadiusMeters`; screen-size bounds still apply. */
  radiusMeters?: number;
  style?: MarkerStyleRecord;
}

/** A marker's style with the scene's filled in. */
export interface ResolvedMarkerStyle {
  /** sRGB channels and alpha, 0–1, as authored; width in CSS px. */
  outline: { color: readonly [number, number, number, number]; widthPx: number } | null;
  /** 1 when the orb does not grow on hover. */
  hoverScale: number;
}

export interface ViewRecord {
  headingDeg: number;
  pitchDeg: number;
  verticalFovDeg: number;
}

export interface LinkRecord {
  id: string;
  target: string;
  label: string;
  /** Where the hotspot sits in the source panorama's ENU view; without it the link is list-only. */
  direction?: { headingDeg: number; pitchDeg: number };
  /** Overrides the destination's initial view for this arrival. */
  arrivalView?: ViewRecord;
  extensions?: SceneExtensions;
}

export interface AttributionRecord {
  text: string;
  license?: string;
  url?: string;
}

interface RepresentationBase {
  id: string;
  role: "preview" | "immersion";
  mimeType: "image/jpeg" | "image/png";
  /** Prepared files' total bytes, six faces summed for a cube. */
  encodedBytes: number;
  extensions?: SceneExtensions;
}

export interface CubeRepresentationRecord extends RepresentationBase {
  projection: "cube";
  faceSize: number;
  faces: Readonly<Record<CubeFaceName, string>>;
}

/**
 * The extension that holds a scene's preview sheets (docs/scenes/format.md,
 * "Preview sheets"): on the scene, a `PreviewSheetsExtension`; on a cube, its
 * `SheetPlaceRecord`. An extension, so that a loader from before sheets, which
 * refuses a property it does not know, reads the scene and loads the cubes'
 * own files.
 */
export const PREVIEW_SHEETS_EXTENSION = "foss-earth.preview-sheets";

/** What the scene's `extensions` hold under PREVIEW_SHEETS_EXTENSION. */
export interface PreviewSheetsExtension {
  sheets: readonly SheetRecord[];
}

/**
 * One image that holds the faces of several preview cubes, so that every orb
 * of a scene can be shown after one request. Each cube in it has its own face
 * files too, which a loader uses when it does not read sheets or the sheet
 * fails.
 */
export interface SheetRecord {
  id: string;
  /** Changes whenever the file does; the loader keeps the file under it between visits. */
  revision: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  encodedBytes: number;
  url: string;
}

/**
 * A cube's place in a sheet, in the cube's `extensions` under
 * PREVIEW_SHEETS_EXTENSION: its faces px, nx, py, ny, pz and nz from (x, y)
 * rightwards, each `faceSize` square.
 */
export interface SheetPlaceRecord {
  id: string;
  x: number;
  y: number;
}

/** A cube's place in a sheet with the sheet itself, its URL resolved. */
export interface ResolvedSheetPlace extends SheetRecord {
  x: number;
  y: number;
}

export interface EquirectRepresentationRecord extends RepresentationBase {
  projection: "equirectangular";
  width: number;
  height: number;
  url: string;
}

/**
 * A cube of square tiles in a quadtree a face, fetched a tile at a time for
 * the part of the view that needs it (docs/scenes/format.md, "Tiled cubes").
 * Tile (face, level, x, y) is `<url><face>/<level>/<x>/<y>.<jpg|png>`, of
 * `tileSize + 2·gutter` texels a side. Immersion only: the panorama's preview
 * cube shows wherever a tile has not arrived.
 */
export interface TiledCubeRepresentationRecord extends RepresentationBase {
  projection: "tiled-cube";
  /** How a face position maps to a direction: tan(s·π/4) for "equi-angular", s itself for "gnomonic". */
  warp: "equi-angular" | "gnomonic";
  /** The finest level's face, texels: `tileSize · 2^(levels − 1)`. */
  faceSize: number;
  /** A tile's logical texels a side. */
  tileSize: number;
  /** Texels a stored tile adds on every side, sampled past the tile's edge. */
  gutter: number;
  /** Encoded bytes of each level's tiles, level 0 first; they add up to `encodedBytes`. */
  levelBytes: readonly number[];
  /** The folder the tiles are in, ending with "/". */
  url: string;
}

export type RepresentationRecord = CubeRepresentationRecord | EquirectRepresentationRecord | TiledCubeRepresentationRecord;

export interface PanoramaAssetRecord {
  id: string;
  revision: string;
  type: "panorama-image";
  colorSpace: "srgb";
  alpha: "opaque";
  attribution: AttributionRecord;
  representations: readonly RepresentationRecord[];
  extensions?: SceneExtensions;
}

export interface PanoramaEntityRecord {
  id: string;
  type: "panorama";
  assetId: string;
  title: string;
  description?: string;
  capture: CaptureRecord;
  imagePose: ImagePoseRecord;
  marker: MarkerRecord;
  initialView?: ViewRecord;
  links?: readonly LinkRecord[];
  required?: boolean;
  extensions?: SceneExtensions;
}

export interface GroupRecord {
  id: string;
  title: string;
  members: readonly string[];
  extensions?: SceneExtensions;
}

export interface OverviewRecord {
  target: { longitudeDeg: number; latitudeDeg: number; height?: HeightRecord | null };
  /** Positive camera-to-target metres. */
  distanceMeters: number;
  headingDeg: number;
  /** Camera forward; negative looks down. */
  pitchDeg: number;
  verticalFovDeg: number;
}

export interface SceneDocument {
  format: typeof SCENE_FORMAT;
  version: typeof SCENE_FORMAT_VERSION;
  id: string;
  revision: string;
  title: string;
  requiredExtensions?: readonly string[];
  extensions?: SceneExtensions;
  assets: readonly PanoramaAssetRecord[];
  entities: readonly (PanoramaEntityRecord | { id: string; type: string; required?: boolean })[];
  groups?: readonly GroupRecord[];
  initialPanorama?: string;
  overview?: OverviewRecord;
  /** Every orb's style, unless its marker's `style` overrides it. */
  markerStyle?: MarkerStyleRecord;
}

// ─── The validated model ──────────────────────────────────────────────

/** A representation with its URLs resolved against the manifest. */
export type ResolvedRepresentation =
  | (Omit<CubeRepresentationRecord, "faces"> & { faces: Readonly<Record<CubeFaceName, string>>; sheet?: ResolvedSheetPlace })
  | EquirectRepresentationRecord
  | TiledCubeRepresentationRecord;

/** The tiled representations of a resolved asset. */
export type ResolvedTiledCube = Extract<ResolvedRepresentation, { projection: "tiled-cube" }>;
/** A representation that is one texture: a cube or an equirectangular image. */
export type ResolvedWholeRepresentation = Exclude<ResolvedRepresentation, ResolvedTiledCube>;

export interface ResolvedAsset extends Omit<PanoramaAssetRecord, "representations" | "attribution"> {
  attribution: AttributionRecord;
  representations: readonly ResolvedRepresentation[];
}

export interface ResolvedPanorama extends Omit<PanoramaEntityRecord, "links"> {
  links: readonly LinkRecord[];
  markerStyle: ResolvedMarkerStyle;
}

/** An entity the loader does not know how to show; it stays in the list with a reason. */
export interface UnsupportedEntity {
  id: string;
  type: string;
  reason: string;
}

export interface SceneDiagnostic {
  /** JSON path of the offending value, such as `$.entities[1].capture.latitudeDeg`. */
  path: string;
  message: string;
}

export interface ValidatedScene {
  format: typeof SCENE_FORMAT;
  version: typeof SCENE_FORMAT_VERSION;
  id: string;
  revision: string;
  title: string;
  /** Where relative URLs were resolved from. */
  baseUrl: string | null;
  assets: ReadonlyMap<string, ResolvedAsset>;
  /** The scene's sheets by id, their URLs resolved. */
  sheets: ReadonlyMap<string, SheetRecord>;
  panoramas: ReadonlyMap<string, ResolvedPanorama>;
  /** Every entity id in document order, supported or not, for the list. */
  entityOrder: readonly string[];
  unsupported: ReadonlyMap<string, UnsupportedEntity>;
  groups: readonly GroupRecord[];
  initialPanorama: string | null;
  overview: OverviewRecord | null;
  extensions: SceneExtensions;
  /** Kept and reported, not fatal. */
  warnings: readonly SceneDiagnostic[];
  /** Encoded bytes of the manifest itself. */
  manifestBytes: number;
}

export type SceneValidation =
  | { ok: true; scene: ValidatedScene }
  | { ok: false; errors: readonly SceneDiagnostic[] };
