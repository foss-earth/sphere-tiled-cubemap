import { describe, expect, it } from "vitest";
import { cross, normalize, type Vec3 } from "../panoramaMath";
import { createCubeTiling, type CubeWarp } from "./cubeTiling";
import { createTileSelector, tilesUnderPixels, type TileView } from "./tileSelection";

/** A camera in the image's axes from heading (clockwise from +Y), pitch and roll, degrees. */
function view(headingDeg: number, pitchDeg: number, rollDeg: number, verticalFovDeg: number, widthPx: number, heightPx: number): TileView {
  const h = (headingDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
  const forward: Vec3 = [Math.cos(p) * Math.sin(h), Math.cos(p) * Math.cos(h), Math.sin(p)];
  const right0 = normalize(cross(forward, [0, 0, 1]));
  const up0 = cross(right0, forward);
  const right: Vec3 = [right0[0] * Math.cos(r) + up0[0] * Math.sin(r), right0[1] * Math.cos(r) + up0[1] * Math.sin(r), right0[2] * Math.cos(r) + up0[2] * Math.sin(r)];
  const up = cross(right, forward);
  const tanV = Math.tan((verticalFovDeg * Math.PI) / 360);
  return { forward, right, up, tanHalfHeight: tanV, tanHalfWidth: (tanV * widthPx) / heightPx, heightPx };
}

const VIEWS: [string, TileView, number][] = [
  ["a face's middle", view(0, 0, 0, 75, 108, 240), 108],
  ["between two faces", view(45, 0, 0, 75, 108, 240), 108],
  ["a cube corner", view(45, 35.26, 0, 75, 108, 240), 108],
  ["off axis and rolled", view(23, 17, 9, 75, 108, 240), 108],
  ["straight up", view(0, 89, 0, 90, 240, 160), 240],
  ["straight down", view(140, -89, 0, 90, 240, 160), 240],
  ["zoomed in", view(80, -10, 0, 25, 160, 120), 160],
];

describe("tile selection", () => {
  for (const warp of ["equi-angular", "gnomonic"] as CubeWarp[]) {
    const tiling = createCubeTiling({ warp, tileSize: 192, maxLevel: 3, gutter: 1 });
    const selector = createTileSelector(tiling);
    const C = tiling.cells;

    it(`${warp}: misses no cell any pixel of the view falls in`, () => {
      for (const [, camera, width] of VIEWS) {
        const selection = selector.select(camera, { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 });
        for (const tile of tilesUnderPixels(tiling, camera, width, tiling.maxLevel)) {
          const { face, x, y } = tiling.address(tile);
          const cell = (face * C + y) * C + x;
          expect(selection.inView[cell]).toBe(1);
          expect(selection.cells[cell]).toBeGreaterThanOrEqual(0);
        }
        // Every cell the view touches has a wanted tile covering it.
        for (let cell = 0; cell < 6 * C * C; cell++) {
          if (!selection.inView[cell]) continue;
          const face = Math.floor(cell / (C * C)), shift = tiling.maxLevel - selection.cells[cell];
          expect(selection.visible.has(tiling.id(face, selection.cells[cell], (cell % C) >> shift, (Math.floor(cell / C) % C) >> shift))).toBe(true);
        }
      }
    });

    it(`${warp}: asks for finer levels as the view narrows or has more pixels, and none past the cap`, () => {
      const finest = (selection: ReturnType<typeof selector.select>) => Math.max(...[...selection.visible.keys()].map(tile => tiling.level(tile)));
      // The cell straight ahead: a perspective view's pixels are largest there.
      const ahead = (selection: ReturnType<typeof selector.select>) => selection.cells[(2 * C + C / 2) * C + C / 2];
      const wide = selector.select(view(0, 0, 0, 100, 400, 300), { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 });
      const narrow = selector.select(view(0, 0, 0, 20, 400, 300), { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 });
      const phone = selector.select(view(0, 0, 0, 75, 1081, 2401), { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 });
      expect(ahead(wide)).toBeLessThan(ahead(narrow));
      expect(finest(phone)).toBe(3);
      expect(finest(selector.select(view(0, 0, 0, 75, 1081, 2401), { texelsPerPixel: 1, marginDeg: 0, levelCap: 1 }))).toBe(1);
      expect(ahead(selector.select(view(0, 0, 0, 75, 1081, 2401), { texelsPerPixel: 0.125, marginDeg: 0, levelCap: 3 }))).toBeLessThan(ahead(phone));
    });

    it(`${warp}: keeps margin tiles apart, and lowers the level until the view fits a short budget`, () => {
      const camera = view(10, 5, 0, 75, 1081, 2401);
      const withMargin = selector.select(camera, { texelsPerPixel: 1, marginDeg: 10, levelCap: 3 });
      expect(withMargin.margin.size).toBeGreaterThan(0);
      for (const tile of withMargin.margin.keys()) expect(withMargin.visible.has(tile)).toBe(false);
      const roomy = selector.selectWithin(camera, { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 }, 1000);
      const tight = selector.selectWithin(camera, { texelsPerPixel: 1, marginDeg: 0, levelCap: 3 }, 12);
      expect(tight.visible.size).toBeLessThanOrEqual(12);
      expect(tight.levelCap).toBeLessThan(roomy.levelCap);
    });
  }
});
