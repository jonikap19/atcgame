import { type Airport, type GateId, gateNear, inCone, liftoffPoint } from './airport';
import { type Vec, angleDiff, closestOnSegment, dist, headingTo } from './geom';

/**
 * A saved route any suitable plane can be sent onto.
 * - `arr`: ends in a landing cone; following it clears the plane to land on `endId`.
 * - `dep`: starts at a runway's liftoff point; departures from `endId` join it automatically.
 * - `gen`: anything else (transit, holding detours, exits towards `gate`).
 */
export type RouteKind = 'arr' | 'dep' | 'gen';

export interface Route {
  id: string;
  name: string;
  kind: RouteKind;
  points: Vec[];
  endId: string | null;
  gate: GateId | null;
  color: string;
}

export const ROUTE_COLORS = ['#9fb6ff', '#ffd27a', '#9ff0b8', '#f5a3d8', '#8fe0e8', '#e2c29f', '#c7a4ff', '#eef09a'];

/** Thins a freehand stroke so points are at least `spacing` apart. */
export function simplify(points: Vec[], spacing = 10, maxPoints = 240): Vec[] {
  if (points.length === 0) return [];
  const out: Vec[] = [points[0]];
  for (const p of points) {
    if (dist(p, out[out.length - 1]) >= spacing) out.push(p);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last && dist(last, out[out.length - 1]) > 2) out.push(last);
  return out.slice(0, maxPoints);
}

/**
 * Cuts a drawn path so a plane joins it at the point nearest to where the plane
 * is now. The plane keeps flying while the player draws, so without this it
 * would turn back to reach the start of the line.
 */
export function trimToNearest(pos: Vec, points: Vec[]): Vec[] {
  if (points.length < 2) return points.slice();
  const hits = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p = closestOnSegment(pos, points[i], points[i + 1]);
    hits.push({ i, p, d: dist(pos, p) });
  }
  const best = Math.min(...hits.map((h) => h.d));
  // Take the earliest part of the line that is about as close, so a loop
  // drawn later that passes near the plane is still flown.
  const hit = hits.find((h) => h.d <= best + 20) ?? hits[0];
  return [hit.p, ...points.slice(hit.i + 1)];
}

/** Works out what kind of route a drawn stroke is. */
export function classifyRoute(
  airport: Airport,
  points: Vec[],
): Pick<Route, 'kind' | 'endId' | 'gate'> {
  const start = points[0];
  const last = points[points.length - 1];
  const gate = gateNear(airport, last, 70)?.id ?? null;

  for (const end of Object.values(airport.ends)) {
    if (inCone(end, last)) return { kind: 'arr', endId: end.id, gate: null };
  }

  const probe = points.find((p) => dist(p, start) > 40) ?? last;
  const initialHeading = headingTo(start, probe);
  for (const end of Object.values(airport.ends)) {
    const nearLiftoff = dist(start, liftoffPoint(airport, end)) < 110;
    if (nearLiftoff && Math.abs(angleDiff(end.heading, initialHeading)) < 60) {
      return { kind: 'dep', endId: end.id, gate };
    }
  }
  return { kind: 'gen', endId: null, gate };
}

export function describeRoute(r: Route): string {
  if (r.kind === 'arr') return `ARRIVAL · RWY ${r.endId}`;
  if (r.kind === 'dep') return `DEPARTURE · RWY ${r.endId}${r.gate ? ` → ${r.gate}` : ''}`;
  return r.gate ? `EXIT → ${r.gate}` : 'GENERAL';
}
