import { describe, expect, it } from "vitest";
import { createSettingsRegistry, type DeviceContext } from "@foss-earth/ui/settings";
import { TILED_CUBEMAP_PARAMETERS, keptGpuDefault, tileMemoryDefault } from "../src/catalogue.js";
import { DEFAULT_TILE_CAPACITY_POLICY } from "../src/tileScheduler.js";

describe("one host registry for tiled policy", () => {
  it("keeps the original homes and exposes unchanged scheduler capacity costs", () => {
    const registry = createSettingsRegistry();
    registry.register(TILED_CUBEMAP_PARAMETERS);
    const share = TILED_CUBEMAP_PARAMETERS.find(spec => spec.id === "scene.panorama.tileViewShare")!;
    const doubling = TILED_CUBEMAP_PARAMETERS.find(spec => spec.id === "scene.panorama.tileRetryBackoffDoublings")!;
    expect(share.home).toEqual({ tab: "scenes", section: "tiles", level: "all" });
    expect(doubling.home).toEqual(share.home);
    expect(registry.get(share.id)).toBe(DEFAULT_TILE_CAPACITY_POLICY.viewSlotShare);
    expect(registry.get(doubling.id)).toBe(DEFAULT_TILE_CAPACITY_POLICY.retryBackoffDoublings);
    expect(share.unit).toBe("fraction"); expect(doubling.unit).toBe("count");
    expect(TILED_CUBEMAP_PARAMETERS.find(spec => spec.id === "scene.panorama.tileOutlines")!.home).toEqual({ tab: "panorama-settings", section: "image", level: "main" });
    expect(TILED_CUBEMAP_PARAMETERS.map(spec => spec.id)).not.toContain("scene.panorama.previewSheets");
  });
  it("retains the prepared-cube device forecasts without importing a device", () => {
    const context = (overrides: Partial<DeviceContext> = {}): DeviceContext => ({ rendererMode: null, maxTextureSize: null, devicePixelRatio: 1, hardwareConcurrency: null, deviceMemoryGiB: null, touch: false, frameTimeMs: null, refreshIntervalMs: null, rendererDevicePixels: null, ...overrides });
    expect(tileMemoryDefault(context()).value).toBe(73.25);
    expect(tileMemoryDefault(context({ touch: true })).value).toBe(28.25);
    expect(keptGpuDefault(context({ touch: true })).value).toBe(0);
    expect(keptGpuDefault(context()).value).toBeGreaterThan(tileMemoryDefault(context()).value);
    expect(tileMemoryDefault(context({ touch: true, deviceMemoryGiB: 1 })).value).toBe(32);
  });
});
