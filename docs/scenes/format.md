# Scene format: `foss-earth-scene` version 1

A scene is one JSON manifest that places 360° panoramas on the globe. FOSS Earth
shows each panorama as an orb above the map. Clicking or tapping the orb enters
it, and links between panoramas lead from one to the next.

This page is the reference for writing a manifest. The design and its reasons
are in the proposal: [panorama scenes](../proposals/panorama-scenes.md).

- **JSON Schema:** [`src/scenes/foss-earth-scene-1.schema.json`](../../src/scenes/foss-earth-scene-1.schema.json).
  Packages import it as `foss-earth/scenes/schema.json`.
- **Validator:** `validateScene` from `foss-earth/scenes`. It checks everything
  the schema checks, plus references between records. It stops a scene before any
  request is made or any GPU memory is used, and names the JSON path of each
  failure. [`scripts/check-scene.mjs`](../../scripts/check-scene.mjs) runs it on a
  manifest on disk and checks its media files too, below.
- **Examples:** [`public/examples/panorama-scenes/`](../../public/examples/panorama-scenes/),
  built by [`scripts/build-panorama-examples.mjs`](../../scripts/build-panorama-examples.mjs).

## Loading a scene

In the app:

- Open **+ → Scenes → Content**, then pick an example or paste a manifest URL.
- Or open the app with `?scene=<id>`, such as `?scene=umn-single`. Only scenes
  the app offers load this way. An arbitrary URL in the address bar never loads.
- An application built on FOSS Earth offers its own scenes instead of the
  examples. It lists them with `mountGlobeApp`'s `scenes` option and names the
  one to open at start with `initialScene`.

From code:

```ts
import { loadScene } from "foss-earth/scenes";

const result = await loadScene(runtime, "https://example.org/campus.scene.json");
if (result.ok) {
  const scene = result.handle; // enter(), exit(), follow(), replace(), dispose()
} else {
  console.error(result.errors); // [{ path: "$.entities[0].capture.latitudeDeg", message: "…" }]
}
```

### Progressive delivery and progress

Keep a scene in a folder with a small `scene.json` index and separate image
files. The manifest contains URLs and metadata, never embedded image bytes:

```text
scene/
├── scene.json
└── media/
    └── garden/
        ├── preview-64/{px,nx,py,ny,pz,nz}.jpg
        ├── preview-256/{px,nx,py,ny,pz,nz}.jpg
        ├── immersion-2048.jpg
        └── immersion-6144.jpg
```

The loader fetches and validates the index before scheduling images. It does
not wait for all images to show the scene:

1. List the scene's metadata and request terrain at its overview, independently
   of image downloads. A ground-relative orb appears once its own ground and
   preview are available.
2. Load each panorama's smallest preview inside `scene.panorama.previewFaceRange`
   first. Show it as soon as its six faces are downloaded, decoded and uploaded.
   A slow or failed panorama does not block the others.
3. Sharpen only what is drawn larger than it is sharp. An orb on screen whose
   diameter has more pixels than its preview has texels loads the preview its
   size asks for at `scene.panorama.previewDensity`, the largest orb first,
   behind the first previews. An orb that stays small, or out of view, keeps
   the preview it has: nothing is loaded for a size it has not reached.
4. On entry, ask for the panorama's largest allowed preview and, while the
   camera flies in, for the tiles of the view it will open on. The orb's image
   opens out across the view, and the selected immersion representation shows
   over it within the user's image detail and memory limits: a tiled cube at
   once, sharpening as the view's tiles arrive; a whole image once it is
   usable. Either way it requests the detail it needs directly, without
   downloading every intermediate size.

Every file is read from the [saved images](#saved-images) before the network is
asked, so steps 2 to 4 ask for a file only the first time.

Scene replacement and disposal cancel obsolete work. A new camera gesture
cancels a pending overview move, so terrain arriving later cannot take the
camera back. Request counts, decode concurrency, timeouts, preview detail and
memory budgets live in the Scenes tab's settings.

The shared log reports scene-file bytes, preview readiness, and entered-image
progress with bars. Missing response lengths produce indeterminate progress;
image totals come from each representation's `encodedBytes`. Downloaded bytes
can reach their total before decoding and GPU upload finish. The Scenes list
shows preview readiness separately from waiting for ground and entering a
panorama. Programs can observe transfers through `loadScene`'s `onProgress`
option or `SceneController.onProgress`, exported from `foss-earth/scenes`.

A whole image or cube still finishes before its texture is usable. A tiled
cube is fetched a tile at a time, for the part of the view that needs it, at the
level it needs: see [Tiled cubes](#tiled-cubes). Incremental JPEG decoding is
not implemented.

Panoramas render with WebGPU, WebGL 2 or WebGL 1 using the same analytic orb
geometry and depth. WebGL 1 requires `EXT_frag_depth`,
`OES_standard_derivatives` and high-precision fragment shaders. Missing a
required capability produces a specific diagnostic. `EXT_shader_texture_lod`
is optional; without it, implicit sampling can be softer at the longitude seam.

WebGL uploads use row strips within `scene.panorama.uploadMiBPerFrame` and
`scene.panorama.uploadOutstandingMiB`. WebGL 2 tracks outstanding uploads with
GPU fences and supports mipmaps for non-power-of-two images. WebGL 1 has no
fences, so it caps frame submissions by both allowances and releases staging
bytes once the API consumes their source. Its non-power-of-two images use
clamp-to-edge and bilinear filtering without mipmaps; include power-of-two
representations when mipmapped detail is needed on WebGL 1. Both WebGL paths
blend panorama transitions in linear light. These capabilities do not imply
equal performance across devices, and a backend's presence alone does not
qualify a phone.

The manifest and its relative media paths may live on a different static
origin from the app, provided that origin allows fetches from the app with
CORS. For independent content releases, publish images first and an immutable,
versioned manifest last; keep earlier media while apps still reference it.
The scene format does not require images to be bundled with application code.

### Saved images

The loader keeps every image file it downloads, in the browser's IndexedDB,
and reads it from there the next time: on a reload, on a later visit, and when
a tile that left the GPU is looked at again. A file is downloaded once.

It can, where the browser's own cache cannot, because of one promise the format
makes: an asset's `revision` changes whenever any of its files does. A file is
kept under its asset's id and revision, its representation's id and its URL.
So:

- **Publishing.** Change an asset's `revision` whenever a file of it changes,
  whatever the reason: other pixels, another encoder, another size.
  `prepare-panorama.mjs` derives it from the source image, its settings and
  its `TOOL_VERSION`, which must go up with any change to what the tool writes
  for the same input. A scene that changes a file and keeps the revision shows
  returning visitors the old file.
- **What is not kept.** The manifest: it is fetched every time, since it is
  what says which revisions are current.
- **How much.** Scenes → Saved images sets the limit, `scene.panorama.savedMiB`
  (256 MiB; 0 keeps nothing), shows what is kept and what the visit took from
  it, and clears it. Past the limit, the representations unused longest go
  first, whole. An old revision's files go the same way, since nothing asks for
  them again.
- **When it fails.** A kept file is checked as a download is: one whose header
  is not the image declared, or that the browser cannot decode, is dropped and
  fetched again. With no IndexedDB, a full disk or a refused write, images come
  from the network as before.

Why not leave it to HTTP: a static host decides how long the browser may reuse
a file, and GitHub Pages says ten minutes. After that every file costs a
request to find it unchanged, and on the UMN tour 306 of 720 such requests
downloaded the file again (`docs/proposals/panorama-scenes.md`, "Loading
once"). [`scripts/validation/scene-revisit.mjs`](../../scripts/validation/scene-revisit.mjs)
counts what a first visit, a reload, a look around and a revisit ask the
network for, and fails when a build asks for anything twice.

## Rules for the whole document

- **Top-level fields:** `format` must be `"foss-earth-scene"` and `version` must
  be `1`. Other versions are refused rather than guessed at; migrating from one
  version to another is a separate, explicit tool.
- **Fields:** every record lists its allowed properties. An unknown property is an
  error. Additions go in `extensions`, under a namespaced key such as
  `"example.tour"`. Extension data is kept, never executed.
- **Required extensions:** `requiredExtensions` lists the extensions a scene
  cannot be shown without. A loader that lacks one refuses the scene.
- **Ids:** nonempty ASCII made of letters, digits, `.`, `_` and `-`. Records
  refer to each other by id, never by array position. Ids are unique within
  their kind: assets, entities, groups, the representations of one asset, and
  the links of one panorama.
- **URLs:**
  - Relative URLs resolve against the manifest's final URL, after any redirect.
  - Every resolved URL must be `http` or `https`, and must not carry a user name
    or password.
  - Local files go through a file resolver, not `file:` URLs.
- **Sizes:** a scene larger than these parameters is refused before anything is
  built. All four are in Scenes → Content:
  - `scene.manifestMiB`: the manifest's size;
  - `scene.entityLimit`: the number of entities;
  - `scene.assetLimit`: the number of assets;
  - `scene.linkLimit`: the number of links.

## Coordinates and conventions

- **Positions:** longitude and latitude are WGS84, in degrees. Heights are metres
  above the WGS84 ellipsoid: a `HeightRecord` is `{ meters, datum: "WGS84-ellipsoid",
  source?, uncertaintyMeters? }`. An unknown height is absent or `null`, never 0.
- **Image-local directions:** X is right, Y is forward and Z is up. At a zero pose,
  forward is north, right is east and up is up.
- **Image pose:** `{ headingDeg, pitchDeg, rollDeg, aligned? }` rotates
  image-local directions into the capture's east-north-up frame, as
  R = Rz(−heading) · Rx(pitch) · Ry(roll). Heading is clockwise from north.
  `aligned` says whether the heading was set against true north: `false` means
  the image faces an arbitrary direction, though pitch and roll may still level
  it. Leave it out when that is not known. The panorama's tab shows it.
- **Equirectangular images** are full 2:1 images:
  - the centre column looks forward (+Y), and u runs right, from the back through
    the left to the front and on through the right;
  - the top row looks straight up.
- **Cube faces** are named `px nx py ny pz nz`, after the image-local axis each
  one faces. Each face is drawn as seen from inside the cube:

  | Face | Looks along | Image right is | Image top is |
  | --- | --- | --- | --- |
  | `px` | +X | −Y | +Z |
  | `nx` | −X | +Y | +Z |
  | `py` | +Y | +X | +Z |
  | `ny` | −Y | −X | +Z |
  | `pz` | +Z | +X | −Y |
  | `nz` | −Z | +X | +Y |

## Records

### Document

| Field | Required | Meaning |
| --- | --- | --- |
| `format`, `version` | yes | `"foss-earth-scene"`, `1` |
| `id`, `revision`, `title` | yes | The scene's identity; `revision` changes whenever its content does |
| `assets` | yes | Pixel content, below |
| `entities` | yes | What the scene places, below |
| `groups` | no | `{ id, title, members: [entity ids] }`, ordered lists for the Scenes tab |
| `initialPanorama` | no | The panorama the list suggests first |
| `overview` | no | Where the globe camera goes when the scene loads, below |
| `markerStyle` | no | How every orb looks: an outline, and growth under the pointer, below |
| `requiredExtensions`, `extensions` | no | See the document rules above |

### Asset: `type: "panorama-image"`

An asset is one image. Its `representations` are complete versions of it at
different sizes and projections.

| Field | Meaning |
| --- | --- |
| `id`, `revision` | The asset's identity. `revision` changes whenever any of its files does; the loader [keeps files under it](#saved-images) between visits. |
| `colorSpace` | `"srgb"`: the only colour space in version 1 |
| `alpha` | `"opaque"`: panoramas have no transparency |
| `attribution` | `{ text, license?, url? }`, shown while the image is on screen |
| `representations` | At least one complete `preview` cube; any number of `immersion` representations |

Every representation has these fields:
- `id`;
- `role`: `"preview"` or `"immersion"`;
- `mimeType`: `"image/jpeg"` or `"image/png"`;
- `encodedBytes`: the prepared files' total size, all six faces summed for a cube.

The projections add their own fields:
- A **cube** adds `faceSize` in pixels and `faces`, one URL for each of the six faces.
- An **equirectangular** image adds `width`, `height` (half the width) and `url`.
- A **tiled cube** (`"tiled-cube"`, immersion only) adds `warp`, `faceSize`, `tileSize`,
  `gutter`, `levelBytes` and `url`, the tiles' folder: see [Tiled cubes](#tiled-cubes).

A representation of a projection the loader does not know is skipped with a warning,
and the asset shows its others. So a scene may offer newer kinds of image beside the
ones an older viewer reads. The schema accepts any projection for the same reason.

The loader uses these sizes to choose a representation within the memory
budgets before it downloads anything. Inside a panorama it shows the tiled cube
the person's representation asks for, when the asset has one (360 image settings →
Image → Representation; equi-angular tiles by default). Otherwise, or with "Whole
image" chosen, it shows the largest whole immersion representation within the
panorama tab's image detail, the device's texture limit and the budgets, so offer
the largest you have: by default every budget has room for an image as wide as the
renderer's texture limit. An asset of an unknown `type` makes the entities that use
it unsupported, and the scene still loads.

### Tiled cubes

A tiled cube is a cube of the format's six faces, each cut into a quadtree of square
tiles, fetched a tile at a time. Level 0 is one tile a face; each level after it
doubles the face and has four times the tiles. Inside a panorama the loader asks only
for the tiles the view needs, at the level the view's pixels need, and a few degrees
around it; a tile not yet there shows the asset's preview cube, which is on the GPU
already. A view therefore sharpens in about a second on a slow link, where a whole
image is sharp only once every byte of it has arrived.

| Field | Meaning |
| --- | --- |
| `warp` | `"equi-angular"`: a face position s from −1 to 1 is the direction `f + tan(s·π/4)·r` (and likewise along the face's top axis), so texels are spread almost evenly over the face. `"gnomonic"`: the direction is `f + s·r`, an ordinary cube map, coarser at a face's middle and finer at its corners. |
| `faceSize` | The finest level's face, texels: `tileSize · 2^(levels − 1)` |
| `tileSize` | A tile's logical texels a side |
| `gutter` | Texels a stored tile adds on every side, sampled past its edge: inside a face from the neighbouring tile's place, past the face's edge from the next face. A stored tile is `tileSize + 2·gutter` square. 0 or more, and less than half the tile. |
| `levelBytes` | Each level's tiles' total bytes, level 0 first, 1 to 8 levels. They add up to `encodedBytes`; the loader expects a tile to weigh its level's mean. |
| `url` | The tiles' folder, ending with `/`. Tile (face, level, x, y) is `<url><face>/<level>/<x>/<y>.jpg`, or `.png` for `image/png`: `face` is `px nx py ny pz nz`, x counts right from 0 and y down from 0, as on the cube face table above. |

`role` must be `"immersion"`: a tiled cube shows over its asset's preview cube, which
the asset must have anyway. Every level is resampled from the source, not reduced from
the level above, and the gutter lets each tile be filtered from its own texels alone, so
no seam shows between tiles, levels or faces. `scripts/check-scene.mjs` checks every
tile's header for the stored size and every level's bytes.

```json
{
  "id": "eac-tiles", "role": "immersion", "projection": "tiled-cube", "warp": "equi-angular",
  "mimeType": "image/jpeg", "encodedBytes": 4697568, "faceSize": 1536, "tileSize": 192, "gutter": 1,
  "levelBytes": [68839, 278956, 1032090, 3317683], "url": "media/garden/eac-tiles/"
}
```

**Choosing the sizes.** A face of a quarter of the source's width matches its density at
the horizon: 1536 for a 6144-pixel panorama. 192-texel tiles were the fastest in
[the prototype's measurements](../../benchmarks/eac-progressive-prototype/REPORT.md), and
equi-angular faces needed 15% fewer bytes than gnomonic ones for the same view quality.
`scripts/prepare-panorama.mjs --tiles eac,cube` writes both.

**Loading.** The scheduler, its caches and the levels it chooses follow the person's
settings: Scenes → Tiled images for tile memory, requests, uploads a frame and the margin
around the view; the sharpness target and the image detail for the levels; the fades for
how a tile replaces what was there. A panorama entered again finds its tiles still on
the GPU while the panorama memory has room for them.

### Entity: `type: "panorama"`

| Field | Required | Meaning |
| --- | --- | --- |
| `id`, `title` | yes | Shown in the list and on the orb |
| `description` | no | Shown in the list and the panorama's tab |
| `assetId` | yes | The asset it shows |
| `capture` | yes | `{ longitudeDeg, latitudeDeg, height?, horizontalAccuracyMeters? }`: where the photograph was taken, and to what accuracy |
| `imagePose` | yes | The image's orientation, and whether its north is set, as defined above |
| `marker` | yes | Where the orb floats, below |
| `initialView` | no | `{ headingDeg, pitchDeg, verticalFovDeg }` on entering |
| `links` | no | Links to other panoramas, below |
| `required` | no | `true`: refuse the whole scene if this entity cannot be shown |

**Marker.** `{ mode, eastM, northM, offsetM, radiusMeters?, style? }`. The two modes
differ in what the offset is measured from:

- `ground-relative`: `offsetM` metres above the ground the map displays, at a
  point `eastM` and `northM` metres from the capture. The orb follows that ground
  as the terrain loads and refines. It shows as pending until there is ground to
  place it on.
- `capture-relative`: offset from the capture's own height. It needs a known
  `capture.height`, or the scene is refused.

`radiusMeters` replaces the default orb size, the `scene.panorama.markerRadiusMeters`
parameter. The orb's size on screen still stays within Scenes → Orbs'
bounds.

`style` overrides the scene's `markerStyle` for this orb, below.

**Marker style.** `{ outline?, hover? }`, as the document's `markerStyle` for
every orb and as a marker's `style` for one. A marker's `style` replaces the
scene's one property at a time: an `outline` of its own replaces the scene's
outline, and leaves the scene's `hover` in place. `null` turns off a property the
scene gives, for that marker.

- `outline`: `{ color, widthPx }`, a ring drawn just outside the orb's
  silhouette. `color` is a CSS hex colour, `#rrggbb` or `#rrggbbaa` with alpha.
  `widthPx` is 0 to 32 CSS px, the same on screen at any distance; 0 draws none.
  The ring is part of what a click selects.
- `hover`: `{ scale }`, 1 to 4. While a mouse or pen pointer is over the orb, it
  grows to `scale` times its size on screen, over `scene.panorama.hoverDuration`,
  and shrinks back when the pointer leaves. It grows past the size bounds, which
  apply first. Entering still takes a click.

Without a style the orb has no outline and does not grow.

```json
"markerStyle": { "outline": { "color": "#ffffff", "widthPx": 2 }, "hover": { "scale": 1.25 } }
```

**Links.** `{ id, target, label, direction?, arrivalView?, extensions? }`:

- `target` is another panorama of the same scene. A link to an unsupported
  entity is listed, but disabled.
- `direction` (`{ headingDeg, pitchDeg }`, in the source panorama's east-north-up
  frame) places a hotspot. A link without one appears only in the list.
- `arrivalView` overrides the destination's `initialView` for this link only.

An entity of another `type` is listed with the reason it cannot be shown,
unless it is marked `required`, which refuses the scene.

### Overview

`{ target: { longitudeDeg, latitudeDeg, height? }, distanceMeters, headingDeg, pitchDeg, verticalFovDeg }`.
This sets where the globe camera goes when the scene loads:

- The camera looks at `target` from `distanceMeters` away, along `headingDeg`.
- `pitchDeg` is negative when looking down.
- With no `height`, the target is on the displayed ground. The overview then
  requests terrain at that destination and waits until there is ground to put
  it on. Panorama previews download independently during that wait.

## Preparing images

[`scripts/prepare-panorama.mjs`](../../scripts/prepare-panorama.mjs) turns a
2:1 equirectangular JPEG or PNG into a panorama asset:

- **Checks:** it validates the input, applies EXIF orientation once and converts
  the image to opaque sRGB.
- **Outputs:** it writes the preview cubes and immersion images, a manifest
  fragment, and a provenance record.
- **Pose:** the image's pose comes from `--pose file.json` or from GPano data in
  the image. Without either, the tool stops rather than invent a north.
- **Network:** it never fetches anything.

```sh
node scripts/prepare-panorama.mjs --input garden.jpg --pose garden-pose.json \
  --preview-face-sizes 64,128 --immersion-widths 2048 --tiles eac,cube \
  --attribution "Garden by A. Photographer" --out build/prepared-scenes/garden
```

`--tiles eac,cube` adds an equi-angular and a gnomonic tiled cube, in tiles of
`--tile-size` (192) up to `--tile-face-size` (the input width / 4).

## Checking a scene before publishing

[`scripts/check-scene.mjs`](../../scripts/check-scene.mjs) checks a manifest on
disk the way the loader will read it once published:

- it validates the manifest with `validateScene`, with the loader's default
  limits;
- it checks every media file against its representation: the file exists, its
  header gives the declared type and pixel size, and the files of a
  representation add up to its `encodedBytes`.

Pass the address the manifest will be served from. Relative media URLs resolve
against it, and a URL under its folder is read from the manifest's folder on
disk. The check fetches nothing.

```sh
node scripts/check-scene.mjs ../site/tour/scene.json --base-url https://example.org/tour/scene.json
```

From code, `checkSceneFiles(scene, read)` from `foss-earth/scenes` makes the file
checks on a validated scene, with `read` turning a resolved URL into bytes.

## A minimal scene

```json
{
  "format": "foss-earth-scene",
  "version": 1,
  "id": "garden",
  "revision": "1",
  "title": "Garden",
  "assets": [{
    "id": "garden-photo", "revision": "a1", "type": "panorama-image", "colorSpace": "srgb", "alpha": "opaque",
    "attribution": { "text": "Garden by A. Photographer", "license": "CC-BY-4.0" },
    "representations": [{
      "id": "preview-64", "role": "preview", "projection": "cube", "faceSize": 64, "mimeType": "image/jpeg", "encodedBytes": 14000,
      "faces": { "px": "garden/px.jpg", "nx": "garden/nx.jpg", "py": "garden/py.jpg", "ny": "garden/ny.jpg", "pz": "garden/pz.jpg", "nz": "garden/nz.jpg" }
    }]
  }],
  "entities": [{
    "id": "garden-gate", "type": "panorama", "assetId": "garden-photo", "title": "Garden gate",
    "capture": { "longitudeDeg": -93.235, "latitudeDeg": 44.974, "height": null },
    "imagePose": { "headingDeg": 0, "pitchDeg": 0, "rollDeg": 0 },
    "marker": { "mode": "ground-relative", "eastM": 0, "northM": 0, "offsetM": 10 }
  }]
}
```
