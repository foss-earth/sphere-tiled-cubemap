import { describe, expect, it } from "vitest";
import type { ImageSamplingPlan } from "@foss-earth/images";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { renderCubeTile, renderTileFace } from "./preparation.js";

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
});
