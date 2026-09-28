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

- Open **Scenes (◎) → Content**, then pick an example or paste a manifest URL.
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
| `id`, `revision` | The asset's identity. `revision` changes whenever its pixels do; caches key on it. |
| `colorSpace` | `"srgb"`: the only colour space in version 1 |
| `alpha` | `"opaque"`: panoramas have no transparency |
| `attribution` | `{ text, license?, url? }`, shown while the image is on screen |
| `representations` | At least one complete `preview` cube; any number of `immersion` representations |

Every representation has these fields:
- `id`;
- `role`: `"preview"` or `"immersion"`;
- `mimeType`: `"image/jpeg"` or `"image/png"`;
- `encodedBytes`: the prepared files' total size, all six faces summed for a cube.

The two projections add their own fields:
- A **cube** adds `faceSize` in pixels and `faces`, one URL for each of the six faces.
- An **equirectangular** image adds `width`, `height` (half the width) and `url`.

The loader uses these sizes to choose a representation within the memory
budgets before it downloads anything. Inside a panorama it shows the largest
immersion representation within the panorama tab's image detail, the device's
texture limit and the budgets, so offer the largest you have: by default every
budget has room for an image as wide as the renderer's texture limit. An asset of an unknown `type` makes the
entities that use it unsupported, and the scene still loads.

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
  waits until there is ground to put it on.

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
  --preview-face-sizes 64,128 --immersion-widths 2048 \
  --attribution "Garden by A. Photographer" --out build/prepared-scenes/garden
```

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
