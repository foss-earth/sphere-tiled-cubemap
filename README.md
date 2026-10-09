# @foss-earth/tiled-cubemap

Private source draft for the existing version-1 six-face tile pyramid. Both equi-angular and gnomonic warps retain face coordinates, gutters, view selection, ancestor fallback, cancellation, residency and the byte display table. A host ticks the pure scheduler; it creates no loop, renderer or resource broker. Public core imports only images and cubemap/core.


The atlas layout preserves the historical memory parameter: `tileMemoryBytes` sizes atlas slots; the display table is additional and included in `gpuBytes`. The images session reserves that complete value. This is an unchecked source candidate. No checked artifact, app adoption, supported runtime range, hardware qualification or publication is claimed.

Root and `./core` expose `createCubeTiling`, spherical regions, `createTileSelector`, `createTileScheduler`, `DEFAULT_TILE_CAPACITY_POLICY`, layout and count contracts; root additionally exports the tiled record validator, `tiledCubeFiles`, `tiledCubeFilesWithLevel`, `estimateTiledCube` and `createTiledCubeRepresentation`. Files retain `<face>/<level>/<x>/<y>.<jpg|png>`, level groups and `.tiles[address]` diagnostic paths. The immutable face order and axes come only from public cubemap/core. `./schema.json` describes the same version-1 immersion-only record, gutter, byte-total and directory rules. Malformed direct public grid arguments fail before allocation/counting.

`./preparation` exports `renderTileFace` and `renderCubeTile`. The caller supplies one reusable format-neutral source sampler, angular footprint and samples per axis. Both EAC and gnomonic paths preserve the original full-face sample phase, including exterior and shared gutters; a tile is exactly its full-face crop. This package does not normalize or decode the source image. `./shaders` provides the original tile-table/gutter/ancestor/preview sampling fragments for the host renderer; shader assembly and device compilation stay with the viewer/renderer.

`./browser` exports `createTiledPanorama`: supply a validated representation, computed layout, the one common image broker and dedicated scope, common `obtain`/`decode` ports, atlas factory, named limits and host `wake`. Optional `priority` passes unchanged to the common request/decode queue. The transport's tile order remains view-first, largest visible share first, then margin. The host calls `tick(now, view, parameters)` on its existing frame; `true` means useful frame work remains. Refused upload capacity returns `false` and subscribes to real pool release/resize/limit events, waking only when the next complete table-plus-tile update fits. It never polls capacity or starts a private clock. Ending the source unsubscribes capacity and aborts every child operation; late acquisition/decode resources close. `settleReplacement` is only the host's acknowledgement after its atomic visibility swap and outgoing disposal.

`./babylon` exports the thin `createPanoramaTileAtlas`. It borrows the actual public renderer `ImageRegionDevicePorts`; allocation, GL state, GPU copy completion and device loss remain renderer-owned. Its `reserveUpload(bytes,label)` must reserve **directly from `broker.pools`**, returning a grant or `null`, not from the abortable operation scope. `beginUpdate` reserves table bytes before a slot can be overwritten. `false` from upload/table means refusal before pixel submission and retains decoded work and victim residency. Submitted grants transfer to `copyImage`/`copyBytes` even if native submission throws; `endUpdate` releases only unused table admission. Disposal frees textures and unused admission, never an already submitted grant. The host pumps its renderer transfer tracker on the same frame and reports actual device loss. Retired tracker/device closures require host recreation on backend restoration.

The scheduler keeps table updates pending through refusal and pins the union of old/new on-screen tiles until a table succeeds. A native exception is **not** a transactional pixel rollback: a partial slot copy removes the victim's residency claim, and a table exception preserves the pending union and propagates for host retry/source teardown. Device recovery and user-visible error reporting are host responsibilities. No GPU/backend behavior has yet been qualified by this candidate's mock fixtures.

The browser adapter retains actual common decoded pixels before invoking a
synchronous tile copy. Reentrant scope disposal during that callback cannot
close its input until the callback returns or throws. Supplied `uploadTile` and
`setTable` ports must capture their image/table inputs synchronously before
returning; the table array may be mutated by the next scheduler update. A
deferred port must explicitly retain its own input or reserve an owned snapshot
before native work. An upload-byte ticket by itself owns no pixels. Foreign
decoders without the common `retain` capability cannot use this route. Two new
causal fixtures use actual common acquisition/decode and cancel the scope from
inside successful and throwing native-copy callbacks; both remain UNRUN.

`./settings` exports `TILED_CUBEMAP_PARAMETERS`, `tileMemoryDefault` and `keptGpuDefault`, using only a type-level UI/settings contract. They register nothing. Existing IDs, homes, units, reasons and prepared-cube device forecasts remain intact; the host injects `keptGpuDefault` into common images' `createImageResourceParameters`. Tile outlines remain Panorama settings → Image. All other tile controls remain Scenes → Tiles. The extracted previously hidden constants are named controls at Scenes → Tiles → All:

| Setting | Unit and bounds | Default | Scheduler port |
| --- | --- | --- | --- |
| `scene.panorama.tileViewShare` | fraction, 0.05–1 | 0.75 | `viewSlotShare` |
| `scene.panorama.tileRetryBackoffDoublings` | count, 0–16 | 8 | `retryBackoffDoublings` |

Omitting those ports preserves original three-quarter selection capacity and eight-doubling backoff. Lower share can choose a coarser level to fit the view; exhausted retries wait `retryDelayMs * 2 ** retryBackoffDoublings`. The original first retry doubles the base delay. These authored visibility changes preserve defaults and add no new performance claim. After `setLimits`, the host supplies its next frame.

`fixtures/public-consumer.ts` composes actual common settings and renderer declarations. `scripts/check-installed-artifact.mjs` prepares a fresh offline archive consumer, checks mandatory artifact digests, guards runtime realpaths and an outside negative control, poisons DOM/runtime peer access in pure imports, and checks pure/public declarations plus schema bytes. It requires exact local archives for tiled-cubemap, images, cubemap, renderer, UI, Babylon, jpeg-js and TypeScript. It has not run. Full checks wait for the coordinator's reserved slot; owner logs/caches stay under `build/` and `node_modules/.tmp/.cache`.

The installed fixture obtains and decodes valid tile bytes with the actual common
`ImageFileService`, whose decoded source supplies the required reliable input hold.
It retains the original completion, single-close, texture disposal, submitted-ticket
and empty-pool assertions. Additional cancellation and throwing-copy cases verify
the native input and decoded charge survive synchronous scope disposal inside the
copy, then close once after it returns or throws; submitted tickets remain held
until the supplied completion proof. No GPU qualification is inferred from these
mock device ports. Every supplied archive is checked for its installed physical
name, exact version and confined package/manifest realpaths. Both pure and public
declaration passes use `skipLibCheck: false`, with their existing DOM versus
DOM.Iterable libraries and empty ambient `types` preserved. These corrections are
source-only and unrun.

The reviewed local CI9e046dd caller/scaffold is preserved unchanged. Installed common positive/negative conformance, complete actual-ref audit, public caller availability, source history, final artifacts and actual remote admission remain coordinator/primary gates. Metadata checks apply to docs, schema and assets as well as code. See [admission](docs/admission.md) and `PROVENANCE.json`; original mixed backend responsibilities and authored fixes are explicitly mapped. Retain the old app and frozen archives until accepted artifacts and real consumer adoption justify source removal; rollback uses those preserved releases, not destructive cache/evidence deletion.

Declaration fixtures include DOM typings for images' standard `AbortSignal`
contract. Runtime pure-import guards still prohibit DOM/renderer initialization;
this source receipt does not qualify declarations with an ES-only type library.

## Project policies

- [Code of conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](SECURITY.md)
