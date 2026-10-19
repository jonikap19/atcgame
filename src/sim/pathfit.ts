import { KT_TO_UPS, TURN_RATE } from './constants';
import { type Vec, add, angleDiff, dist, dot, headingTo, headingVec, mul, pathLength, sub } from './geom';
import { simplify } from './routes';

/** Radius of the circle a plane flies when turning at full rate. */
export function turnRadius(speedKt: number): number {
  return (speedKt * KT_TO_UPS) / ((TURN_RATE * Math.PI) / 180);
}

/** Chaikin corner cutting: rounds off corners while keeping both ends fixed. */
export function chaikin(points: Vec[], iterations: number): Vec[] {
  let pts = points;
  for (let n = 0; n < iterations && pts.length > 2; n++) {
    const out: Vec[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Points evenly spaced along a polyline, keeping its last point. */
export function resample(points: Vec[], spacing: number): Vec[] {
  if (points.length < 2) return points.slice();
  const out: Vec[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = dist(a, b);
    let t = spacing - carry;
    while (t <= len) {
      out.push({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
      t += spacing;
    }
    carry = len - (t - spacing);
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > 1) out.push(last);
  return out;
}

function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/**
 * Turns a hand-drawn line into a smooth path the plane can fly from where it is now.
 *
 * The plane keeps moving while the line is drawn, so the start of the line is
 * usually behind it. Instead of turning back, the plane joins the smoothed line
 * at the first point ahead that it can turn onto, via a curve that starts on its
 * current heading and meets the line going the same way as the line.
 */
export function fitTrack(pos: Vec, heading: number, speedKt: number, raw: Vec[]): Vec[] {
  const track = resample(chaikin(simplify(raw, 8), 3), 12);
  if (track.length < 2) return track.filter((p) => dist(p, pos) > 12);

  // Nearest point on the line (earliest of the near ones, so later loops are kept).
  const dists = track.map((p) => dist(p, pos));
  const nearest = Math.min(...dists);
  const n = dists.findIndex((d) => d <= nearest + 20);

  // The first point from there that is ahead of the plane and outside its turn circles.
  const r = turnRadius(speedKt);
  const fwd = headingVec(heading);
  const right = { x: -fwd.y, y: fwd.x };
  const centres = [add(pos, mul(right, r)), sub(pos, mul(right, r))];
  const reachable = (p: Vec): boolean =>
    dot(sub(p, pos), fwd) > 0 && dist(p, pos) >= r * 1.5 && centres.every((c) => dist(p, c) >= r * 1.3);
  let j = -1;
  for (let i = n; i < track.length; i++) {
    if (reachable(track[i])) {
      j = i;
      break;
    }
  }
  // Nothing ahead to join (the line turns back on itself): fly it from the nearest point.
  if (j < 0) return track.slice(n).filter((p) => dist(p, pos) > 12);

  const join = track[j];
  const next = track[Math.min(j + 1, track.length - 1)];
  const dir = j + 1 < track.length ? mul(sub(next, join), 1 / Math.max(1e-6, dist(next, join))) : fwd;
  const d = dist(pos, join);
  const k = d * 0.4;
  const c1 = add(pos, mul(fwd, k));
  const c2 = sub(join, mul(dir, k));
  const steps = Math.max(2, Math.ceil(d / 12));
  const lead: Vec[] = [];
  for (let s = 1; s < steps; s++) lead.push(cubic(pos, c1, c2, join, s / steps));
  return [...lead, ...track.slice(j)].filter((p) => dist(p, pos) > 12);
}

/** A circle a plane orbits. `dir` 1 = clockwise (right turns), -1 = anticlockwise. */
export interface Hold {
  center: Vec;
  radius: number;
  dir: 1 | -1;
}

export interface EndLoop {
  /** The line before the loop (ends where the loop starts). */
  lead: Vec[];
  loop: Vec[];
  hold: Hold;
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Total turning along a polyline, in degrees. Positive = clockwise. */
function winding(points: Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length - 1; i++) {
    total += angleDiff(headingTo(points[i - 1], points[i]), headingTo(points[i], points[i + 1]));
  }
  return total;
}

const MIN_LOOP_LENGTH = 100;
const CLOSE_GAP = 30;

/**
 * Detects a circle drawn at the end of a line. A loop counts when the line
 * crosses (or comes back to) itself near its end and the closed part turns
 * most of the way round.
 */
export function detectEndLoop(raw: Vec[]): EndLoop | null {
  const pts = simplify(raw, 6);
  if (pts.length < 8) return null;
  const total = pathLength(pts);
  const last = pts.length - 1;

  const accept = (startIdx: number, endIdx: number): EndLoop | null => {
    const loop = pts.slice(startIdx, endIdx + 1);
    const length = pathLength(loop);
    const turn = winding(loop);
    if (length < MIN_LOOP_LENGTH || Math.abs(turn) < 270) return null;
    const ring = resample([...loop, loop[0]], 6);
    const center = {
      x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
      y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
    };
    const radius = ring.reduce((s, p) => s + dist(p, center), 0) / ring.length;
    return { lead: pts.slice(0, startIdx + 1), loop, hold: { center, radius, dir: turn > 0 ? 1 : -1 } };
  };

  // The line crosses itself: look for a later segment (near the end) crossing an earlier one.
  let tail = 0;
  for (let k = last - 1; k >= 2; k--) {
    tail += dist(pts[k], pts[k + 1]);
    if (tail > Math.max(80, total * 0.3)) break;
    for (let j = 0; j < k - 2; j++) {
      if (segmentsCross(pts[j], pts[j + 1], pts[k], pts[k + 1])) {
        const found = accept(j + 1, k);
        if (found) return found;
      }
    }
  }
  // The line comes back to (almost) where the circle started without crossing.
  for (let j = 0; j < last - 5; j++) {
    if (dist(pts[last], pts[j]) <= CLOSE_GAP) {
      const found = accept(j, last);
      if (found) return found;
    }
  }
  return null;
}
