import { CONE_HALF_ANGLE, CONE_LEN, WORLD_H, WORLD_W } from './constants';
import { type Vec, dot, headingVec, mul, sub, tanDeg, vec } from './geom';

export type GateId = 'N' | 'E' | 'S' | 'W';
export type Side = 'top' | 'right' | 'bottom' | 'left';

/** An exit gate on the map edge that departures must leave through. */
export interface Gate {
  id: GateId;
  side: Side;
  /** Position along the edge (x for top/bottom, y for left/right). */
  center: number;
  half: number;
  color: string;
}

/** One direction of a runway. Planes land and take off from `threshold` heading `heading`. */
export interface RunwayEnd {
  id: string;
  runwayId: string;
  threshold: Vec;
  heading: number;
  oppositeId: string;
}

export interface Runway {
  id: string;
  a: Vec;
  b: Vec;
  endIds: [string, string];
}

export interface Airport {
  code: string;
  name: string;
  center: Vec;
  runways: Runway[];
  ends: Record<string, RunwayEnd>;
  gates: Gate[];
}

function runway(id: string, a: Vec, b: Vec, idA: string, headingA: number, idB: string): [Runway, RunwayEnd, RunwayEnd] {
  const endA: RunwayEnd = { id: idA, runwayId: id, threshold: a, heading: headingA, oppositeId: idB };
  const endB: RunwayEnd = { id: idB, runwayId: id, threshold: b, heading: (headingA + 180) % 360, oppositeId: idA };
  return [{ id, a, b, endIds: [idA, idB] }, endA, endB];
}

/** The prototype airport: two staggered parallel runways, 09/27. */
export function makeAirport(): Airport {
  const north = runway('N', vec(700, 455), vec(900, 455), '09L', 90, '27R');
  const south = runway('S', vec(735, 545), vec(935, 545), '09R', 90, '27L');
  const ends: Record<string, RunwayEnd> = {};
  for (const e of [north[1], north[2], south[1], south[2]]) ends[e.id] = e;
  return {
    code: 'HVL',
    name: 'HARROW VALE',
    center: vec(WORLD_W / 2, WORLD_H / 2),
    runways: [north[0], south[0]],
    ends,
    gates: [
      { id: 'N', side: 'top', center: 520, half: 70, color: '#c9a7ff' },
      { id: 'E', side: 'right', center: 270, half: 70, color: '#5fe0c0' },
      { id: 'S', side: 'bottom', center: 1080, half: 70, color: '#c6e86b' },
      { id: 'W', side: 'left', center: 730, half: 70, color: '#ff9fd0' },
    ],
  };
}

export function gateSegment(g: Gate): [Vec, Vec] {
  switch (g.side) {
    case 'top':
      return [vec(g.center - g.half, 0), vec(g.center + g.half, 0)];
    case 'bottom':
      return [vec(g.center - g.half, WORLD_H), vec(g.center + g.half, WORLD_H)];
    case 'left':
      return [vec(0, g.center - g.half), vec(0, g.center + g.half)];
    case 'right':
      return [vec(WORLD_W, g.center - g.half), vec(WORLD_W, g.center + g.half)];
  }
}

export function gatePoint(g: Gate): Vec {
  const [a, b] = gateSegment(g);
  return vec((a.x + b.x) / 2, (a.y + b.y) / 2);
}

/** Heading pointing out of the map through this gate. */
export function gateOutHeading(g: Gate): number {
  return { top: 0, right: 90, bottom: 180, left: 270 }[g.side];
}

/** Which edge a point outside the map has crossed (the one it is furthest past). */
export function sideOf(p: Vec): Side {
  const over: [Side, number][] = [
    ['top', -p.y],
    ['bottom', p.y - WORLD_H],
    ['left', -p.x],
    ['right', p.x - WORLD_W],
  ];
  over.sort((a, b) => b[1] - a[1]);
  return over[0][0];
}

/** The gate a point outside the map left through, if any. */
export function gateAt(airport: Airport, p: Vec): Gate | null {
  const side = sideOf(p);
  const along = side === 'top' || side === 'bottom' ? p.x : p.y;
  return airport.gates.find((g) => g.side === side && Math.abs(along - g.center) <= g.half) ?? null;
}

/** Nearest gate within `radius` of a point inside the map. */
export function gateNear(airport: Airport, p: Vec, radius: number): Gate | null {
  let best: Gate | null = null;
  let bestD = radius;
  for (const g of airport.gates) {
    const [a, b] = gateSegment(g);
    const cx = Math.min(Math.max(p.x, Math.min(a.x, b.x)), Math.max(a.x, b.x));
    const cy = Math.min(Math.max(p.y, Math.min(a.y, b.y)), Math.max(a.y, b.y));
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d <= bestD) {
      best = g;
      bestD = d;
    }
  }
  return best;
}

/**
 * Position relative to a runway end's approach.
 * `along` = distance out from the threshold on the approach side (negative = over the runway),
 * `lateral` = signed distance from the extended centerline.
 */
export function approachCoords(end: RunwayEnd, p: Vec): { along: number; lateral: number } {
  const dir = headingVec(end.heading);
  const rel = sub(p, end.threshold);
  return { along: -dot(rel, dir), lateral: rel.x * dir.y - rel.y * dir.x };
}

export function inCone(end: RunwayEnd, p: Vec): boolean {
  const { along, lateral } = approachCoords(end, p);
  return along >= 25 && along <= CONE_LEN && Math.abs(lateral) <= along * tanDeg(CONE_HALF_ANGLE) + 8;
}

/** Outline of the landing cone: threshold, then the two far corners. */
export function conePolygon(end: RunwayEnd): Vec[] {
  const back = mul(headingVec(end.heading), -1);
  const far = vec(end.threshold.x + back.x * CONE_LEN, end.threshold.y + back.y * CONE_LEN);
  const w = CONE_LEN * tanDeg(CONE_HALF_ANGLE);
  const perp = vec(-back.y, back.x);
  return [end.threshold, vec(far.x + perp.x * w, far.y + perp.y * w), vec(far.x - perp.x * w, far.y - perp.y * w)];
}

/** Glide path altitude at a given distance out from the threshold. */
export function glideAltitude(along: number, entryAlt: number): number {
  return Math.min(entryAlt, Math.max(0, (along / CONE_LEN) * entryAlt));
}

/** Where a departure from this end lifts off: the far end of the runway. */
export function liftoffPoint(airport: Airport, end: RunwayEnd): Vec {
  return airport.ends[end.oppositeId].threshold;
}
