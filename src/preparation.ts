import type { ImageSamplingPlan, LinearImage } from "@foss-earth/images";
import { SOURCE_CUBE_FACES, type CubeFaceName } from "@foss-earth/cubemap/core";
import type { CubeWarp } from "./cubeTiling.js";

/** Full face including exterior gutter, preserving renderTileFace's sample grid. */
export function renderTileFace(plan: ImageSamplingPlan, face: CubeFaceName, size: number, warp: CubeWarp, gutter: number): LinearImage {
  return renderRegion(plan, face, size, warp, gutter, 0, 0, size);
}
/** Same pixels as cropping the full face at x*tileSize,y*tileSize, without its allocation. */
export function renderCubeTile(plan: ImageSamplingPlan, face: CubeFaceName, faceSize: number, warp: CubeWarp, gutter: number, tileSize: number, x: number, y: number): LinearImage {
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || faceSize % tileSize !== 0 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= faceSize / tileSize || y >= faceSize / tileSize) throw new RangeError("Tile coordinates must address a complete face grid.");
  return renderRegion(plan, face, faceSize, warp, gutter, x * tileSize, y * tileSize, tileSize);
}
function renderRegion(plan: ImageSamplingPlan, face: CubeFaceName, size: number, warp: CubeWarp, gutter: number, x: number, y: number, regionSize: number): LinearImage {
  const { samplesPerAxis: samples } = plan;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(gutter) || gutter < 0 || !Number.isSafeInteger(samples) || samples < 1 || !Number.isFinite(plan.footprintRadians) || plan.footprintRadians < 0 || !["equi-angular", "gnomonic"].includes(warp)) throw new RangeError("Preparation needs valid face/grid/gutter/warp and angular footprint.");
  const { f, r, t } = SOURCE_CUBE_FACES[face];
  const side = regionSize + 2 * gutter;
  const data = new Float32Array(side * side * 3);
  const colour = [0, 0, 0];
  const warped = (s: number): number => warp === "equi-angular" ? Math.tan(s * Math.PI / 4) : s;
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    let red = 0, green = 0, blue = 0;
    for (let sj = 0; sj < samples; sj++) for (let si = 0; si < samples; si++) {
      const a = warped(2 * ((x + i - gutter + (si + 0.5) / samples) / size) - 1);
      const b = warped(1 - 2 * ((y + j - gutter + (sj + 0.5) / samples) / size));
      plan.source.sample([f[0] + a * r[0] + b * t[0], f[1] + a * r[1] + b * t[1], f[2] + a * r[2] + b * t[2]], plan.footprintRadians, colour);
      red += colour[0]; green += colour[1]; blue += colour[2];
    }
    const n = samples * samples, d = (j * side + i) * 3;
    data[d] = red / n; data[d + 1] = green / n; data[d + 2] = blue / n;
  }
  return { width: side, height: side, data };
}
