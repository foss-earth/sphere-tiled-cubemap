import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ImageSamplingPlan, LinearImage, SourceSampler } from "@foss-earth/images";
import { CUBE_FACE_NAMES } from "@foss-earth/sphere-cubemap/core";
import type { CubeWarp } from "./cubeTiling.js";
import { renderCubeTile, renderTileFace } from "./preparation.js";

const CUBE_PREPARATION_LEVEL = Symbol.for("foss-earth.equirectangular.cubePreparationLevel");

function testLevel(width: number, height: number, seed: number): LinearImage {
  const data = new Float32Array(width * height * 3);
  let s = seed;
  for (let k = 0; k < data.length; k++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    data[k] = k % 101 === 0 ? -0 : k % 211 === 0 ? 1e-40 : k % 307 === 0 ? 3e38 : (s >>> 0) / 2 ** 32;
  }
  return { width, height, data };
}

function markedPlan(faceSize: number): ImageSamplingPlan {
  const pyramid = [testLevel(128, 64, 1), testLevel(64, 32, 2), testLevel(33, 17, 3)];
  const ratio = pyramid[0].width / 4 / faceSize;
  const index = Math.max(0, Math.min(pyramid.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))));
  const sampler: SourceSampler = { sample() { throw new Error("marked level was sampled one direction at a time"); } };
  Object.defineProperty(sampler, CUBE_PREPARATION_LEVEL, { value: pyramid[index] });
  return { samplesPerAxis: pyramid[index].width / 4 / faceSize > 1.5 ? 3 : 2, footprintRadians: Math.PI / (2 * faceSize), source: sampler };
}

function digest(images: readonly LinearImage[]): string {
  const hash = createHash("sha256");
  for (const { width, height, data } of images) hash.update(`${width}x${height}:`).update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return hash.digest("hex");
}

// What the tiles were when every sample went through the plan's sampler, at tiled-cubemap 9c2a45b.
const TILES: Record<string, string> = {
  "equi-angular 8/4+1": "105f9fea23f5f9f53cc599cb6684b569fbc93a6c21648985e539d357648a38c6",
  "equi-angular 16/8+1": "7df3d62501cac180057cdaa87b1b05f6352c28dfb3ca13feb141c3c2ce629dcf",
  "equi-angular 21/7+1": "701c7b6d284adac23568157beb7d381f8c4d15ce5657e4bd8d0e7b826355e2c0",
  "equi-angular 12/4+0": "57cd6b73675066791de61c6d9ed2495d705938f12090d2c53de8e78b49cba15f",
  "equi-angular 12/6+2": "8a98f88390f9b3d3f37da6f1032774da05fcac87652da9f3155a617616798eff",
  "equi-angular 5/5+3": "39b5067a5b571b2196651a9e29aa4f95eb026bfcef085b6266f06ec7fdfd414e",
  "gnomonic 8/4+1": "b96f11e97b3fc38c23a0c8967e6bdc153fb76e74992a041020b6880fe521550e",
  "gnomonic 16/8+1": "13f27a424bddf105ca328cfd002d4c1a845a72e457913caff5ad6d3f157ea384",
  "gnomonic 21/7+1": "accf328e6f80eacf3b1166f1a270f3e5f9329165ce11251eeaf847ff6f1f21b4",
  "gnomonic 12/4+0": "ae9b19167ee2ae9cda2bf725133385a2952b6a92ac61134b12b61b9f74ca3287",
  "gnomonic 12/6+2": "5c8c4d05e372b9ccb7f094d19203ae567566a1faf0aed729df7552478acad32e",
  "gnomonic 5/5+3": "62d3d2d006ebd6f026a3b7c256f6ddcee554a2d4c78ed024e6d90a7aa6cc29eb",
};

describe("tiled preparation sample phase and gutters", () => {
  const plan: ImageSamplingPlan = { samplesPerAxis: 3, footprintRadians: 0.01, source: { sample(d, _footprint, out) { const n = Math.hypot(...d); for (let k = 0; k < 3; k++) out[k] = d[k] / n * 0.5 + 0.5; } } };
  for (const warp of ["equi-angular", "gnomonic"] as const) for (const face of CUBE_FACE_NAMES) it(`${warp}/${face} crop matches full face including adjoining gutters`, () => {
    const full = renderTileFace(plan, face, 8, warp, 1);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const tile = renderCubeTile(plan, face, 8, warp, 1, 4, x, y);
      for (let j = 0; j < 6; j++) expect(Array.from(tile.data.slice(j * 6 * 3, (j + 1) * 6 * 3))).toEqual(Array.from(full.data.slice(((y * 4 + j) * 10 + x * 4) * 3, ((y * 4 + j) * 10 + x * 4 + 6) * 3)));
    }
  });
  it("rejects a partial face grid before sampling", () => expect(() => renderCubeTile(plan, "px", 7, "equi-angular", 1, 4, 0, 0)).toThrow("complete face grid"));

  it("gives the bits the per-sample loop gave, without calling a marked level's sampler", () => {
    for (const [label, sha256] of Object.entries(TILES)) {
      const [warp, rest] = label.split(" ") as [CubeWarp, string];
      const [grid, gutterText] = rest.split("+");
      const [faceSize, tileSize] = grid.split("/").map(Number);
      const gutter = Number(gutterText);
      const marked = markedPlan(faceSize);
      const images: LinearImage[] = [];
      for (const face of CUBE_FACE_NAMES) {
        images.push(renderTileFace(marked, face, faceSize, warp, gutter));
        for (let y = 0; y < faceSize / tileSize; y++) for (let x = 0; x < faceSize / tileSize; x++) images.push(renderCubeTile(marked, face, faceSize, warp, gutter, tileSize, x, y));
      }
      expect(digest(images), label).toBe(sha256);
    }
  });

  it("reads a mark that is not a level one direction at a time", () => {
    const bad: SourceSampler = { sample(d, _f, out) { const n = Math.hypot(...d); for (let k = 0; k < 3; k++) out[k] = d[k] / n; } };
    Object.defineProperty(bad, CUBE_PREPARATION_LEVEL, { value: { width: 4, height: 2, data: new Float64Array(24) } });
    const tile = renderCubeTile({ samplesPerAxis: 1, footprintRadians: 0, source: bad }, "px", 4, "gnomonic", 0, 4, 0, 0);
    expect(tile.width).toBe(4);
    expect(tile.data[0]).toBeGreaterThan(0);
  });
});
