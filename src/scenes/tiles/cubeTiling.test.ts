import { describe, expect, it } from "vitest";
import { SOURCE_CUBE_FACES, CUBE_FACE_NAMES, cross, dot, normalize, type Vec3 } from "../panoramaMath";
import { createCubeTiling, type CubeWarp } from "./cubeTiling";

const WARPS: CubeWarp[] = ["equi-angular", "gnomonic"];

/** A fixed spread of directions over the sphere: a Fibonacci lattice. */
function directions(count: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, k) => {
    const z = 1 - (2 * (k + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(golden * k), r * Math.sin(golden * k), z] as const;
  });
}

describe("a tiled cube's geometry", () => {
  for (const warp of WARPS) {
    const tiling = createCubeTiling({ warp, tileSize: 192, maxLevel: 3, gutter: 1 });

    it(`${warp}: maps a direction to its face position and back`, () => {
      const place = [0, 0, 0];
      const back = [0, 0, 0];
      let worst = 0;
      for (const d of directions(2000)) {
        tiling.locate(d[0], d[1], d[2], place);
        expect(place[1]).toBeGreaterThanOrEqual(0);
        expect(place[1]).toBeLessThanOrEqual(1);
        tiling.direction(place[0], place[1], place[2], back);
        worst = Math.max(worst, Math.hypot(back[0] - d[0], back[1] - d[1], back[2] - d[2]));
      }
      expect(worst).toBeLessThan(1e-12);
    });

    it(`${warp}: faces follow the format's cube table`, () => {
      const at = [0, 0, 0];
      CUBE_FACE_NAMES.forEach((name, face) => {
        const { f, r, t } = SOURCE_CUBE_FACES[name];
        expect(tiling.direction(face, 0.5, 0.5, at).map(value => Math.round(value * 1e9) / 1e9)).toEqual([...f].map(value => value + 0));
        // u grows along the face's right axis, v down its top axis.
        const right = tiling.direction(face, 0.75, 0.5, [0, 0, 0]);
        const down = tiling.direction(face, 0.5, 0.75, [0, 0, 0]);
        expect(dot(right as unknown as Vec3, r)).toBeGreaterThan(0.3);
        expect(dot(down as unknown as Vec3, t)).toBeLessThan(-0.3);
      });
    });

    it(`${warp}: numbers tiles level by level, with consistent parents, children and ancestors`, () => {
      expect(tiling.count).toBe(6 * (1 + 4 + 16 + 64));
      for (let id = 0; id < tiling.count; id++) {
        const { face, level, x, y } = tiling.address(id);
        expect(tiling.id(face, level, x, y)).toBe(id);
        for (const child of tiling.children(id)) expect(tiling.parent(child)).toBe(id);
        if (level > 0) expect(tiling.ancestor(id, level - 1)).toBe(tiling.parent(id));
      }
      expect(tiling.path(tiling.id(4, 2, 3, 1))).toBe("pz/2/3/1");
    });

    it(`${warp}: tile edges are great-circle arcs, so selection can be exact`, () => {
      // The middle of each edge lies on the great circle through its two corners.
      const middle = [0, 0, 0];
      for (let id = tiling.firstOfLevel(2); id < tiling.firstOfLevel(3); id++) {
        const corners = tiling.corners(id);
        const { face, level, x, y } = tiling.address(id);
        const n = 1 << level;
        const mids = [[(x + 0.5) / n, y / n], [(x + 1) / n, (y + 0.5) / n], [(x + 0.5) / n, (y + 1) / n], [x / n, (y + 0.5) / n]];
        mids.forEach(([u, v], k) => {
          tiling.direction(face, u, v, middle);
          const normal = normalize(cross(corners[k], corners[(k + 1) % 4]));
          expect(Math.abs(dot(normal, middle as unknown as Vec3))).toBeLessThan(1e-12);
        });
      }
    });
  }

  it("gives an equi-angular face nearly even texels, where a gnomonic one is coarse at its centre", () => {
    const eac = createCubeTiling({ warp: "equi-angular", tileSize: 192, maxLevel: 3, gutter: 1 });
    const cube = createCubeTiling({ warp: "gnomonic", tileSize: 192, maxLevel: 3, gutter: 1 });
    const spread = (tiling: typeof eac) => tiling.texelAngle(0, 0.5, 0.5) / tiling.texelAngle(0, 0.02, 0.02);
    // A finest equi-angular texel at the centre matches a 6144-wide equirectangular image's at the horizon.
    expect((eac.texelAngle(0, 0.5, 0.5) / 8) / ((2 * Math.PI) / 6144)).toBeCloseTo(1, 2);
    expect(spread(eac)).toBeLessThan(1.1);
    expect(spread(cube)).toBeGreaterThan(1.5);
  });
});
