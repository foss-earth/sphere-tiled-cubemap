# @foss-earth/sphere-tiled-cubemap

The tiled six-face cubemap representation for FOSS Earth, a browser globe app built with TypeScript, React and Babylon.js. It covers the version-1 tile pyramid: equi-angular (EAC) and gnomonic face warps, face coordinates and gutters, view-based tile selection, ancestor fallback, cancellation, residency and the byte display table.

The host ticks the scheduler on its own frame. The package creates no loop, renderer or resource broker. Its public core depends only on [images](https://github.com/foss-earth/images) and the core of [cubemap](https://github.com/foss-earth/cubemap).

## Entry points

| Entry | What it provides |
| --- | --- |
| `@foss-earth/sphere-tiled-cubemap` and `/core` | `createCubeTiling`, spherical regions, `createTileSelector`, `createTileScheduler`, `DEFAULT_TILE_CAPACITY_POLICY`, layout and count contracts. The root entry also exports the tiled record validator, `tiledCubeFiles`, `tiledCubeFilesWithLevel`, `estimateTiledCube` and `createTiledCubeRepresentation`. |
| `/schema.json` | JSON schema for the version-1, immersion-only record: gutter, byte totals and directory rules. |
| `/preparation` | `renderTileFace` and `renderCubeTile`. |
| `/browser` | `createTiledSphere`. |
| `/babylon` | `createSphereTileAtlas`. |
| `/shaders` | Tile-table, gutter, ancestor and preview sampling fragments. |
| `/settings` | `TILED_CUBEMAP_PARAMETERS`, `tileMemoryDefault`, `keptGpuDefault`. |

Tile files are laid out as `<face>/<level>/<x>/<y>.<jpg|png>`, with level groups and `.tiles[address]` diagnostic paths. Face order and axes come from the public cubemap core. Malformed grid arguments fail before any allocation or counting.

## Atlas memory

`tileMemoryBytes` sizes the atlas slots. The display table is additional and is included in `gpuBytes`. The images session reserves that full value.

## Preparation

`renderTileFace` and `renderCubeTile` take one reusable, format-neutral source sampler, an angular footprint and samples per axis. EAC and gnomonic paths keep the full-face sample phase, including exterior and shared gutters, so a tile is exactly its crop of the full face. This package does not decode or normalize the source image. `/shaders` provides the sampling fragments; shader assembly and device compilation stay with the viewer and renderer.

## Browser: `createTiledSphere`

Supply:

- a validated representation and its computed layout
- the common image broker and a dedicated scope
- the common `obtain` and `decode` ports
- an atlas factory, named limits and a host `wake` callback
- optionally `priority`, passed unchanged to the common request and decode queue

Transport order is view-first, largest visible share first, then margin. The host calls `tick(now, view, parameters)` on its existing frame. A return value of `true` means useful frame work remains. When upload capacity is refused, `tick` returns `false` and subscribes to pool release, resize and limit events. It wakes the host only when the next complete table-plus-tile update fits, and never polls or runs its own clock. After `setLimits`, the host supplies its next frame. Ending the source unsubscribes from capacity and aborts every child operation, and late resources are closed. `settleReplacement` is the host's acknowledgement after its atomic visibility swap and disposal of the outgoing source.

The adapter retains the common decoded pixels before a synchronous tile copy. If the scope is disposed during that callback, the input isn't closed until the callback returns or throws. The supplied `uploadTile` and `setTable` ports must capture their image or table inputs synchronously, because the table array can be mutated by the next scheduler update. A deferred port must retain its input or reserve an owned snapshot before starting native work. An upload-byte ticket alone owns no pixels. Decoders without the common `retain` capability can't be used here.

## Babylon: `createSphereTileAtlas`

A thin adapter over the renderer's `ImageRegionDevicePorts`. Allocation, GL state, GPU copy completion and device loss belong to the renderer.

- `reserveUpload(bytes, label)` must reserve directly from `broker.pools`, not from the abortable operation scope, and returns a grant or `null`.
- `beginUpdate` reserves table bytes before any slot can be overwritten.
- `false` from the upload or table means refusal before pixels were submitted; decoded work and the victim's residency are kept.
- Submitted grants pass to `copyImage` or `copyBytes` even if native submission throws. `endUpdate` releases only unused table admission. Disposal frees textures and unused admission, never a submitted grant.
- The host pumps its renderer's transfer tracker on the same frame and reports actual device loss. Retired tracker or device closures need recreation by the host when the backend is restored.

The scheduler keeps table updates pending through refusals and pins the union of old and new on-screen tiles until a table update succeeds. A native exception does not roll back pixels transactionally. A partially copied slot drops the victim's residency claim, and a table exception keeps the pending union and propagates so the host can retry or tear the source down. Device recovery and user-visible error reporting are the host's job. The GPU path has been exercised only with mock device ports.

## Settings

`TILED_CUBEMAP_PARAMETERS`, `tileMemoryDefault` and `keptGpuDefault` use only a type-level dependency on the UI settings contract and register nothing. The host passes `keptGpuDefault` to images' `createImageResourceParameters`. Tile outlines are under Sphere settings, Image. The other tile controls are under Scenes, Tiles. Two scheduler constants are exposed as controls at Scenes, Tiles, All:

| Setting | Unit and bounds | Default | Scheduler port |
| --- | --- | --- | --- |
| `scene.panorama.tileViewShare` | fraction, 0.05 to 1 | 0.75 | `viewSlotShare` |
| `scene.panorama.tileRetryBackoffDoublings` | count, 0 to 16 | 8 | `retryBackoffDoublings` |

Omitting the ports gives three-quarter selection capacity and eight-doubling backoff. A lower share can pick a coarser level to fit the view. Once retries are exhausted, the wait is `retryDelayMs * 2 ** retryBackoffDoublings`; the first retry doubles the base delay.

## Earlier package name

This package was named `@foss-earth/tiled-cubemap`. Nothing is published under that name
any more: consumers import `@foss-earth/sphere-tiled-cubemap`. Records and documents did
not change: the `tiled-cube` projection, the schema `$id` and media URLs are as before. The
repository keeps the name `tiled-cubemap` until it is renamed on the host.

## Development

This package's own `npm install`, tests and build don't work on their own yet, because it names `@foss-earth/images` and `@foss-earth/sphere-cubemap` by versions that aren't published. Libraries are normally developed through the app, which uses them straight from their checkouts. See [local source](https://github.com/foss-earth/app#local-source).

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party packages, map and terrain data, online services and trademarks have their own notices and terms.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
