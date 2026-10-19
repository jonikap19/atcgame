// 2D vector helpers. Headings are compass degrees: 0 = north (-y), 90 = east (+x).

export interface Vec {
  x: number;
  y: number;
}

const RAD = Math.PI / 180;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Signed shortest turn from `from` to `to`, in (-180, 180]. Positive = right turn. */
export function angleDiff(from: number, to: number): number {
  let d = norm360(to - from);
  if (d > 180) d -= 360;
  return d;
}

export const headingVec = (heading: number): Vec => ({
  x: Math.sin(heading * RAD),
  y: -Math.cos(heading * RAD),
});

export const headingTo = (a: Vec, b: Vec): number =>
  norm360(Math.atan2(b.x - a.x, -(b.y - a.y)) / RAD);

/** The point on segment a–b closest to p. */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq === 0) return { ...a };
  const t = clamp(dot(sub(p, a), ab) / lenSq, 0, 1);
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

export function pathLength(points: Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export const tanDeg = (deg: number): number => Math.tan(deg * RAD);
