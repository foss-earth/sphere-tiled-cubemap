import { createTiledPanorama, type TiledPanoramaOptions } from "@foss-earth/tiled-cubemap/browser";
import { createPanoramaTileAtlas } from "@foss-earth/tiled-cubemap/babylon";
import { createImageRegionDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";
import { createSettingsRegistry, type DeviceContext } from "@foss-earth/ui/settings";
import { TILED_CUBEMAP_PARAMETERS, keptGpuDefault } from "@foss-earth/tiled-cubemap/settings";
import { createImageResourceParameters } from "@foss-earth/images/settings";
import type { ImageSessionBroker } from "@foss-earth/images";
import type { Scene } from "@babylonjs/core";

/** The app owns one renderer tracker and ticks it through its existing frame. */
export function atlasPorts(scene: Scene, broker: ImageSessionBroker, requestRender: () => void) {
  const tracker = createTextureTransferTracker({ scene, requestRender, admit(bytes, label) { const grant = broker.pools.reserve("uploadOutstanding", bytes, label); return grant.ok ? grant.reservation : null; } });
  const device = createImageRegionDevicePorts({ scene, track: tracker.track });
  return { tracker, createAtlas(layout: TiledPanoramaOptions["layout"], cells: number) { return createPanoramaTileAtlas({ device, layout, cells, label: "host panorama", reserveUpload(bytes, label) { const grant = broker.pools.reserve("uploadOutstanding", bytes, label); return grant.ok ? grant.reservation : null; } }); } };
}
export function resourceSettings(context: DeviceContext) {
  const settings = createSettingsRegistry({ deviceContext: context });
  settings.register([...TILED_CUBEMAP_PARAMETERS, ...createImageResourceParameters({ keptGpuDefault })]);
  return settings;
}
export const mountTiled = (options: TiledPanoramaOptions) => createTiledPanorama(options);
