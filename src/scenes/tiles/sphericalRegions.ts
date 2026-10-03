/**
 * Convex regions of the sphere bounded by great-circle arcs: a cube tile and
 * a camera's view are both such regions. Two of them overlap exactly when a
 * corner of one is inside the other or two of their edges cross; nothing is
 * sampled, so a sliver of a tile at the edge of a view counts.
 *
 * A region is its unit corners in order round the boundary and, for each edge,
 * the inward normal of its great circle. Regions must be smaller than a
 * hemisphere.
 */
import { cross, dot, type Vec3 } from "../panoramaMath";

export interface SphericalRegion {
  corners: readonly Vec3[];
  normals: readonly Vec3[];
}

/** Float error a direction exactly on an edge may show. */
const EDGE_TOLERANCE = 1e-12;

export function sphericalRegion(corners: readonly Vec3[]): SphericalRegion {
  const centre: [number, number, number] = [0, 0, 0];
  for (const corner of corners) for (let c = 0; c < 3; c++) centre[c] += corner[c];
  const normals = corners.map((corner, k) => {
    const normal = cross(corner, corners[(k + 1) % corners.length]);
    return dot(normal, centre) < 0 ? [-normal[0], -normal[1], -normal[2]] as const : normal;
  });
  return { corners, normals };
}

export function regionContains(region: SphericalRegion, point: Vec3): boolean {
  return region.normals.every(normal => dot(normal, point) >= -EDGE_TOLERANCE);
}

/** Whether direction x, on the great circle through p0 and p1, lies on the arc between them. */
function onArc(p0: Vec3, p1: Vec3, x: Vec3): boolean {
  const whole = cross(p0, p1);
  return dot(cross(p0, x), whole) >= -EDGE_TOLERANCE && dot(cross(x, p1), whole) >= -EDGE_TOLERANCE;
}

export function regionsOverlap(a: SphericalRegion, b: SphericalRegion): boolean {
  if (a.corners.some(corner => regionContains(b, corner)) || b.corners.some(corner => regionContains(a, corner))) return true;
  for (let i = 0; i < a.corners.length; i++) {
    const a0 = a.corners[i], a1 = a.corners[(i + 1) % a.corners.length];
    const na = cross(a0, a1);
    for (let j = 0; j < b.corners.length; j++) {
      const b0 = b.corners[j], b1 = b.corners[(j + 1) % b.corners.length];
      const line = cross(na, cross(b0, b1));
      if (line[0] === 0 && line[1] === 0 && line[2] === 0) continue;
      for (const sign of [1, -1]) {
        const x: Vec3 = [line[0] * sign, line[1] * sign, line[2] * sign];
        if (onArc(a0, a1, x) && onArc(b0, b1, x)) return true;
      }
    }
  }
  return false;
}
