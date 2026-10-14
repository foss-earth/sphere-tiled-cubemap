import { describe, expect, it, vi } from "vitest";
import type { BaseTexture } from "@babylonjs/core";
import type { ImageRegionDevicePorts, UploadTicket } from "@foss-earth/renderer/babylon";
import { createSphereTileAtlas } from "./tileAtlas.js";

function harness() {
  let tableAdmitted = true; let tileAdmitted = true;
  const textures = Array.from({ length: 2 }, () => ({ dispose: vi.fn() } as unknown as BaseTexture));
  let created = 0;
  const submitted: UploadTicket[] = [];
  const device: ImageRegionDevicePorts = {
    createTexture: vi.fn(() => textures[created++]),
    copyImage: vi.fn((_texture, _image, _x, _y, ticket) => { submitted.push(ticket); }),
    copyBytes: vi.fn((_texture, _bytes, ticket) => { submitted.push(ticket); }),
  };
  const releases: ReturnType<typeof vi.fn>[] = [];
  const reserveUpload = vi.fn((_bytes: number, label: string) => {
    if (label.endsWith("table") ? !tableAdmitted : !tileAdmitted) return null;
    const release = vi.fn(); releases.push(release); return { release };
  });
  const layout = { width: 4, height: 4, stored: 2, slots: 4, perRow: 2, gpuBytes: 112 };
  const atlas = createSphereTileAtlas({ device, layout, cells: 1, label: "fixture", reserveUpload });
  return { atlas, device, submitted, releases, textures, reserveUpload, tableAdmission(value: boolean) { tableAdmitted = value; }, tileAdmission(value: boolean) { tileAdmitted = value; } };
}
describe("tiled atlas atomic upload admission", () => {
  it("disposes a partial allocation when the shared device refuses the second texture", () => {
    const first = { dispose: vi.fn() } as unknown as BaseTexture;
    const device: ImageRegionDevicePorts = { createTexture: vi.fn().mockReturnValueOnce(first).mockImplementationOnce(() => { throw new Error("table allocation"); }), copyImage: vi.fn(), copyBytes: vi.fn() };
    expect(() => createSphereTileAtlas({ device, layout: { width: 4, height: 4, stored: 2, slots: 4, perRow: 2, gpuBytes: 112 }, cells: 1, label: "partial", reserveUpload: () => null })).toThrow("table allocation");
    expect(first.dispose).toHaveBeenCalledOnce();
  });
  it("validates byte cost and slot dimensions before any native allocation", () => {
    const device: ImageRegionDevicePorts = { createTexture: vi.fn(), copyImage: vi.fn(), copyBytes: vi.fn() };
    expect(() => createSphereTileAtlas({ device, layout: { width: 4, height: 4, stored: 2, slots: 5, perRow: 2, gpuBytes: 112 }, cells: 1, label: "bad", reserveUpload: () => null })).toThrow("inconsistent");
    expect(device.createTexture).not.toHaveBeenCalled();
  });
  it("leaves a partially submitted throwing tile grant with the device, freeing only unused table admission", () => {
    const h = harness();
    vi.mocked(h.device.copyImage).mockImplementation((_texture, _image, _x, _y, ticket) => { h.submitted.push(ticket); throw new Error("partial tile copy"); });
    expect(h.atlas.beginUpdate()).toBe(true);
    expect(() => h.atlas.uploadTile(0, { width: 2, height: 2 } as ImageBitmap)).toThrow("partial tile copy");
    h.atlas.endUpdate(); h.atlas.dispose();
    expect(h.releases[0]).toHaveBeenCalledOnce(); expect(h.releases[1]).not.toHaveBeenCalled();
    h.submitted[0].release(); expect(h.releases[1]).toHaveBeenCalledOnce();
  });
  it("does not release a throwing submitted table grant again at endUpdate or disposal", () => {
    const h = harness();
    vi.mocked(h.device.copyBytes).mockImplementation((_texture, _bytes, ticket) => { h.submitted.push(ticket); throw new Error("partial table copy"); });
    h.atlas.beginUpdate(); expect(() => h.atlas.setTable(new Uint8Array(48))).toThrow("partial table copy");
    h.atlas.endUpdate(); h.atlas.dispose(); expect(h.releases[0]).not.toHaveBeenCalled();
    h.submitted[0].release(); expect(h.releases[0]).toHaveBeenCalledOnce();
  });
  it("does not overwrite a slot when a display table cannot be admitted", () => {
    const h = harness(); h.tableAdmission(false);
    expect(h.atlas.beginUpdate()).toBe(false);
    expect(h.atlas.uploadTile(0, { width: 2, height: 2 } as ImageBitmap)).toBe(false);
    expect(h.device.copyImage).not.toHaveBeenCalled();
    h.atlas.dispose();
  });
  it("holds the table grant across a refused tile and releases it when the update ends", () => {
    const h = harness(); h.tileAdmission(false);
    expect(h.atlas.beginUpdate()).toBe(true);
    expect(h.atlas.uploadTile(0, { width: 2, height: 2 } as ImageBitmap)).toBe(false);
    expect(h.releases[0]).not.toHaveBeenCalled();
    h.atlas.endUpdate(); expect(h.releases[0]).toHaveBeenCalledOnce();
    h.atlas.dispose();
  });
  it("passes slot geometry and grants to renderer and leaves submitted lifetime with it", () => {
    const h = harness(); const image = { width: 2, height: 2 } as ImageBitmap;
    expect(h.atlas.beginUpdate()).toBe(true); expect(h.atlas.uploadTile(3, image)).toBe(true);
    expect(h.device.copyImage).toHaveBeenCalledWith(h.atlas.atlas, image, 2, 2, h.submitted[0]);
    expect(h.atlas.setTable(new Uint8Array(48))).toBe(true);
    h.atlas.endUpdate(); h.atlas.dispose(); h.atlas.dispose();
    expect(h.releases.every(release => release.mock.calls.length === 0)).toBe(true);
    expect(h.textures[0].dispose).toHaveBeenCalledOnce(); expect(h.textures[1].dispose).toHaveBeenCalledOnce();
    for (const ticket of h.submitted) ticket.release();
    expect(h.releases.every(release => release.mock.calls.length === 1)).toBe(true);
  });
});
