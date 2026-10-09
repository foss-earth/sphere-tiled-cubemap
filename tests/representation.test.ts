import { describe, expect, it } from "vitest";
import { createTiledCubeRepresentation, estimateTiledCube, tiledCubeFilesWithLevel, validateTiledCubeRepresentation } from "../src/representation.js";
import { tileAtlasLayout, tiledCubeTileCount } from "../src/layout.js";

const record = { id: "tiles", role: "immersion", projection: "tiled-cube", warp: "equi-angular", faceSize: 16, tileSize: 8, gutter: 1, mimeType: "image/png", encodedBytes: 30, levelBytes: [6, 24], url: "tiles/" };
describe("tiled format diagnostics and supplied resource policy", () => {
  it("resolves its directory and retains per-address diagnostic paths and levels", () => {
    const checked = validateTiledCubeRepresentation(record, { path: "$.representation", baseUrl: "https://example.invalid/scene.json" });
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    const files = [...tiledCubeFilesWithLevel(checked.representation)];
    expect(files).toHaveLength(30);
    expect(files[0]).toMatchObject({ url: "https://example.invalid/tiles/px/0/0/0.png", fieldPath: ".tiles[px/0/0/0.png]", level: 0, width: 10, height: 10 });
    const hooks = createTiledCubeRepresentation(() => ({ tileMemoryBytes: 800, responseBytes: 100, requests: 2, waiting: 3, uploadOutstandingBytes: 448 }));
    expect(hooks.filePath!(checked.representation, files[0], 0)).toBe(files[0].fieldPath);
    expect(estimateTiledCube(checked.representation, { tileMemoryBytes: 800, responseBytes: 100, requests: 2, waiting: 3, uploadOutstandingBytes: 448, maxTextureSide: 128 })).toEqual({ encoded: 700, decoded: 2000, sourceGpu: 992, uploadOutstanding: 448 });
  });
  it("rejects inconsistent level totals, preview roles, gutters and non-directory URLs", () => {
    for (const changed of [{ levelBytes: [6, 23] }, { role: "preview" }, { gutter: 4 }, { faceSize: 17 }, { url: "tiles.png" }]) {
      expect(validateTiledCubeRepresentation({ ...record, ...changed }, { path: "$", baseUrl: "https://example.invalid/s.json" }).ok).toBe(false);
    }
  });
  it("rejects malformed public grid inputs before counting or allocating, including a zero divisor", () => {
    for (const malformed of [{ tileSize: 0, faceSize: 8 }, { tileSize: 8, faceSize: 12 }, { tileSize: 8, faceSize: Infinity }, { tileSize: 8, faceSize: 2048 }]) expect(() => tiledCubeTileCount(malformed)).toThrow("complete power-of-two");
    expect(() => tileAtlasLayout({ tileSize: 8, faceSize: 8, gutter: 4 }, 1000)).toThrow("gutter");
    expect(tileAtlasLayout({ tileSize: 8, faceSize: 8, gutter: 1 }, 0)).toBeNull();
  });
});
