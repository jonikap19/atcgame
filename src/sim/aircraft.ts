import { type Airport, type GateId, approachCoords, glideAltitude } from './airport';
import {
  ACCEL,
  CLIMB_RATE,
  CONE_LEN,
  DESCENT_RATE,
  FINAL_DESCENT_RATE,
  FINAL_SPEED,
  GLIDE_ENTRY_ALT,
  KT_TO_UPS,
  ROLLOUT_DECEL,
  ROTATE_SPEED,
  TAKEOFF_ACCEL,
  TURN_RATE,
  WP_RADIUS,
} from './constants';
import { type Vec, add, angleDiff, clamp, dist, headingTo, headingVec, mul, norm360, sub } from './geom';
import { type Hold, turnRadius } from './pathfit';
import type { Route } from './routes';

/** How far ahead along its path a plane aims. */
const LOOKAHEAD = 40;

export type Kind = 'arr' | 'dep';
export type Phase = 'takeoff' | 'enroute' | 'final' | 'rollout';

/** What a plane does when it reaches the end of its current path. */
export type PathEnd =
  | { type: 'none' }
  | { type: 'land'; endId: string }
  | { type: 'route'; routeId: string }
  | { type: 'hold'; hold: Hold };

export const NO_PATH_END: PathEnd = { type: 'none' };

export interface Aircraft {
  id: number;
  callsign: string;
  type: string;
  kind: Kind;
  phase: Phase;
  pos: Vec;
  heading: number;
  alt: number;
  targetAlt: number;
  speed: number;
  targetSpeed: number;
  path: Vec[];
  pathEnd: PathEnd;
  /** Route the plane is currently flying, for display. */
  routeId: string | null;
  /** The circle the plane is orbiting, if it is holding. */
  hold: Hold | null;
  /** Runway end the plane is cleared to land on. */
  landingEnd: string | null;
  /** Runway end the plane is taking off from or rolling out on. */
  runwayEnd: string | null;
  gate: GateId | null;
  fuel: number;
  /** True until a newly spawned arrival is properly inside the map. */
  entering: boolean;
  trail: Vec[];
  trailTimer: number;
  conflict: boolean;
  predicted: boolean;
  lowFuelWarned: boolean;
  /** Seconds the departure waited at the holding point before takeoff. */
  waited: number;
}

export interface FlightContext {
  airport: Airport;
  routes: Route[];
}

export function isAirborne(ac: Aircraft): boolean {
  return ac.phase === 'enroute' || ac.phase === 'final' || (ac.phase === 'takeoff' && ac.alt > 0);
}

export function clearForApproach(ac: Aircraft, endId: string): void {
  ac.landingEnd = endId;
  ac.targetAlt = Math.min(ac.targetAlt, GLIDE_ENTRY_ALT);
  ac.targetSpeed = Math.min(ac.targetSpeed, 200);
}

export function applyRoute(ac: Aircraft, route: Route): void {
  ac.routeId = route.id;
  ac.path = route.points.map((p) => ({ ...p }));
  if (route.kind === 'arr' && route.endId) {
    ac.pathEnd = { type: 'land', endId: route.endId };
    clearForApproach(ac, route.endId);
  } else {
    ac.pathEnd = NO_PATH_END;
  }
}

function steer(ac: Aircraft, target: number, rate: number, dt: number): void {
  const d = angleDiff(ac.heading, target);
  const max = rate * dt;
  ac.heading = norm360(ac.heading + clamp(d, -max, max));
}

function approach(current: number, target: number, up: number, down: number, dt: number): number {
  if (current < target) return Math.min(target, current + up * dt);
  return Math.max(target, current - down * dt);
}

/**
 * Which points a plane can fly to from where it is. A point inside either of
 * the circles it flies at full turn can't be reached without first flying away
 * and coming back. Steering straight at one makes the plane circle it forever.
 * Points just behind the plane have already been passed.
 */
function reachability(ac: Aircraft): { canTarget(p: Vec): boolean } {
  const r = turnRadius(Math.max(ac.speed, 120));
  const fwd = headingVec(ac.heading);
  const right = { x: -fwd.y, y: fwd.x };
  const centres = [add(ac.pos, mul(right, r)), sub(ac.pos, mul(right, r))];
  return {
    canTarget(p: Vec): boolean {
      const d = dist(ac.pos, p);
      if (d < WP_RADIUS) return false;
      const behind = Math.abs(angleDiff(ac.heading, headingTo(ac.pos, p))) > 90;
      if (behind && d < r * 2) return false;
      return centres.every((c) => dist(p, c) >= r);
    },
  };
}

/** A hold that starts circling from where the plane is now, turning right. */
export function holdHere(ac: Aircraft): Hold {
  const radius = turnRadius(ac.speed) * 1.15;
  const v = headingVec(ac.heading);
  const right = { x: -v.y, y: v.x };
  return { center: add(ac.pos, mul(right, radius)), radius, dir: 1 };
}

/** Steers round a hold circle: along the tangent, corrected back towards the circle. */
function flyHold(ac: Aircraft, hold: Hold, dt: number): void {
  const d = dist(ac.pos, hold.center);
  const outward = headingTo(hold.center, ac.pos);
  const tangent = outward + 90 * hold.dir;
  const error = (d - hold.radius) / hold.radius;
  const correction = clamp(error * 70, -70, 70) * hold.dir;
  steer(ac, norm360(tangent + correction), TURN_RATE, dt);
}

/** The plane has flown its whole path: do whatever was planned for the end of it. */
function finishPath(ac: Aircraft, ctx: FlightContext): void {
  const end = ac.pathEnd;
  if (end.type === 'route') {
    const route = ctx.routes.find((r) => r.id === end.routeId);
    if (route) applyRoute(ac, route);
    else ac.pathEnd = NO_PATH_END;
  } else if (end.type === 'hold') {
    ac.hold = end.hold;
    ac.pathEnd = NO_PATH_END;
  } else if (end.type === 'land') {
    ac.phase = 'final';
    ac.landingEnd = end.endId;
    ac.pathEnd = NO_PATH_END;
    ac.routeId = null;
  }
}

function flyEnroute(ac: Aircraft, dt: number, ctx: FlightContext): void {
  if (ac.hold && ac.path.length === 0) {
    flyHold(ac, ac.hold, dt);
  } else {
    // Progress along the path: skip to the nearest of the next few points...
    let nearest = 0;
    let nearestD = Infinity;
    for (let i = 0; i < Math.min(ac.path.length, 10); i++) {
      const d = dist(ac.pos, ac.path[i]);
      if (d < nearestD) {
        nearest = i;
        nearestD = d;
      }
    }
    if (nearest > 0) ac.path.splice(0, nearest);
    // ...then drop points the plane has reached or can no longer reach without circling.
    const reach = reachability(ac);
    while (ac.path.length && !reach.canTarget(ac.path[0])) ac.path.shift();
    if (ac.path.length) {
      // Aim a little way down the path so turns are smooth instead of overshooting,
      // but only ever at a point the plane can actually fly to.
      const aim =
        ac.path.find((p) => dist(ac.pos, p) >= LOOKAHEAD && reach.canTarget(p)) ??
        [...ac.path].reverse().find((p) => reach.canTarget(p));
      if (aim) steer(ac, headingTo(ac.pos, aim), TURN_RATE, dt);
      else ac.path = [];
    }
    if (ac.path.length === 0) finishPath(ac, ctx);
  }
  ac.alt = approach(ac.alt, ac.targetAlt, CLIMB_RATE, DESCENT_RATE, dt);
  ac.speed = approach(ac.speed, ac.targetSpeed, ACCEL, ACCEL, dt);
}

function flyFinal(ac: Aircraft, dt: number, ctx: FlightContext): void {
  const end = ctx.airport.ends[ac.landingEnd ?? ''];
  if (!end) {
    ac.phase = 'enroute';
    return;
  }
  const { along } = approachCoords(end, ac.pos);
  // Aim at a point further down the centerline so the plane eases onto it.
  const aimAlong = Math.max(along - 90, -60);
  const aim = sub(end.threshold, mul(headingVec(end.heading), aimAlong));
  steer(ac, headingTo(ac.pos, aim), TURN_RATE, dt);

  const glide = glideAltitude(along, GLIDE_ENTRY_ALT);
  ac.targetAlt = Math.round(glide);
  if (ac.alt > glide) ac.alt = Math.max(glide, ac.alt - FINAL_DESCENT_RATE * dt);
  ac.targetSpeed = FINAL_SPEED;
  ac.speed = approach(ac.speed, FINAL_SPEED, ACCEL, ACCEL * 1.5, dt);
  if (along > CONE_LEN + 40) ac.phase = 'enroute';
}

/** Advances one plane's movement. Pure flight model: no scoring or game events. */
export function stepFlight(ac: Aircraft, dt: number, ctx: FlightContext): void {
  switch (ac.phase) {
    case 'takeoff':
      ac.speed = Math.min(ac.speed + TAKEOFF_ACCEL * dt, 175);
      if (ac.speed >= ROTATE_SPEED) ac.alt += CLIMB_RATE * dt;
      if (ac.alt >= 400) {
        ac.phase = 'enroute';
        ac.runwayEnd = null;
      }
      break;
    case 'rollout':
      ac.alt = 0;
      ac.speed = Math.max(25, ac.speed - ROLLOUT_DECEL * dt);
      break;
    case 'final':
      flyFinal(ac, dt, ctx);
      break;
    case 'enroute':
      flyEnroute(ac, dt, ctx);
      break;
  }
  const v = headingVec(ac.heading);
  const d = ac.speed * KT_TO_UPS * dt;
  ac.pos = { x: ac.pos.x + v.x * d, y: ac.pos.y + v.y * d };
}

/** A lightweight copy for look-ahead simulation. */
export function cloneForPrediction(ac: Aircraft): Aircraft {
  return {
    ...ac,
    pos: { ...ac.pos },
    path: ac.path.slice(),
    trail: [],
  };
}
