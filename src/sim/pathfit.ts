import { KT_TO_UPS, TURN_RATE } from './constants';
import { type Vec, add, dist, dot, headingVec, mul, sub } from './geom';
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
