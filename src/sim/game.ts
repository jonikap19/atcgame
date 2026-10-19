import {
  type Aircraft,
  type FlightContext,
  NO_PATH_END,
  clearForApproach,
  cloneForPrediction,
  isAirborne,
  stepFlight,
} from './aircraft';
import {
  type Airport,
  type GateId,
  type RunwayEnd,
  approachCoords,
  gateAt,
  glideAltitude,
  inCone,
  makeAirport,
} from './airport';
import {
  ALT_STEP,
  ARR_ALT,
  ARR_SPD,
  COLLIDE_H,
  COLLIDE_V,
  DEP_ALT,
  DEP_INITIAL_ALT,
  DEP_INITIAL_SPD,
  DEP_SPD,
  DESCENT_RATE,
  EXIT_MIN_ALT,
  GLIDE_ENTRY_ALT,
  GLIDE_TOLERANCE,
  KT_TO_UPS,
  LOW_FUEL,
  MAX_ROUTES,
  MAX_STRIPS,
  ROUTE_ENTRY_R,
  SCORE,
  SEP_H,
  SEP_V,
  SPD_STEP,
  WIND_WARNING,
  WORLD_H,
  WORLD_W,
} from './constants';
import { type Vec, angleDiff, clamp, dist, headingTo, norm360, pathLength, vec } from './geom';
import { Rng } from './rng';
import { fitTrack } from './pathfit';
import { ROUTE_COLORS, type Route, classifyRoute, simplify } from './routes';

export type Difficulty = 'calm' | 'normal' | 'busy';
export type Tone = 'info' | 'good' | 'warn' | 'bad';

export interface GameMessage {
  id: number;
  text: string;
  tone: Tone;
  t: number;
}

/** A departure waiting at the holding point for takeoff clearance. */
export interface DepStrip {
  id: number;
  callsign: string;
  type: string;
  gate: GateId;
  since: number;
}

export interface WindState {
  /** Direction the wind blows FROM, degrees. Planes land and take off into it. */
  dir: number;
  speed: number;
  baseDir: number;
  nextShiftAt: number;
  pending: { at: number; toDir: number; speed: number } | null;
}

export interface Stats {
  landed: number;
  departed: number;
  goArounds: number;
  separationLosses: number;
  diverted: number;
  lost: number;
}

export type PathPlan =
  | { kind: 'free' }
  | { kind: 'join'; route: Route }
  | { kind: 'land'; end: RunwayEnd; tooHigh: boolean }
  | { kind: 'inactive'; end: RunwayEnd };

export interface GameOptions {
  difficulty: Difficulty;
  seed?: number;
  routes?: Route[];
  /** Set false in tests to place traffic by hand. */
  autoSpawn?: boolean;
  windDir?: number;
}

const SETTINGS: Record<Difficulty, { arrEvery: number; depEvery: number; fuel: [number, number]; alt: [number, number] }> = {
  calm: { arrEvery: 36, depEvery: 44, fuel: [240, 360], alt: [5000, 8000] },
  normal: { arrEvery: 27, depEvery: 33, fuel: [180, 300], alt: [6000, 10000] },
  busy: { arrEvery: 19, depEvery: 24, fuel: [150, 260], alt: [7000, 11000] },
};

const AIRLINES = ['NVA', 'KST', 'BLU', 'ORA', 'SKY', 'PLR', 'TRN', 'ALP', 'MRD', 'VLX', 'HRW', 'CND'];
const TYPES = ['A320', 'B738', 'A321', 'E190', 'B789', 'A359', 'CRJ9', 'AT76', 'A20N', 'B38M'];

export class Game {
  readonly airport: Airport;
  readonly difficulty: Difficulty;
  readonly rng: Rng;
  time = 0;
  score = 0;
  aircraft: Aircraft[] = [];
  strips: DepStrip[] = [];
  routes: Route[];
  wind: WindState;
  stats: Stats = { landed: 0, departed: 0, goArounds: 0, separationLosses: 0, diverted: 0, lost: 0 };
  over: { reason: string; at: Vec } | null = null;
  messages: GameMessage[] = [];
  /** Bumped whenever routes change, so the UI knows to save them. */
  routesVersion = 0;

  private nextId = 1;
  private nextArrAt: number;
  private nextDepAt: number;
  private readonly autoSpawn: boolean;
  private conflictPairs = new Set<string>();
  private predictTimer = 0;
  private usedCallsigns = new Set<string>();

  constructor(opts: GameOptions) {
    this.airport = makeAirport();
    this.difficulty = opts.difficulty;
    this.rng = new Rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.routes = (opts.routes ?? []).map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) }));
    this.autoSpawn = opts.autoSpawn ?? true;
    const baseDir = opts.windDir ?? norm360((this.rng.chance(0.5) ? 270 : 90) + this.rng.range(-20, 20));
    this.wind = {
      dir: baseDir,
      baseDir,
      speed: Math.round(this.rng.range(6, 16)),
      nextShiftAt: this.rng.range(150, 230),
      pending: null,
    };
    this.nextArrAt = 2;
    this.nextDepAt = 7;
  }

  get ctx(): FlightContext {
    return { airport: this.airport, routes: this.routes };
  }

  // ---------------------------------------------------------------- runways

  isActive(endId: string): boolean {
    const end = this.airport.ends[endId];
    return !!end && Math.abs(angleDiff(end.heading, this.wind.dir)) < 90;
  }

  activeEnds(): RunwayEnd[] {
    return Object.values(this.airport.ends).filter((e) => this.isActive(e.id));
  }

  /** Ends that will be active after the pending wind shift. */
  upcomingEnds(): RunwayEnd[] {
    const p = this.wind.pending;
    if (!p) return [];
    return Object.values(this.airport.ends).filter((e) => Math.abs(angleDiff(e.heading, p.toDir)) < 90);
  }

  /** Is the runway in use? `forLaunch` also counts arrivals on short final. */
  runwayBusy(runwayId: string, forLaunch: boolean): boolean {
    const ends = this.airport.ends;
    return this.aircraft.some((ac) => {
      if ((ac.phase === 'takeoff' || ac.phase === 'rollout') && ac.runwayEnd && ends[ac.runwayEnd].runwayId === runwayId) {
        return true;
      }
      if (forLaunch && ac.phase === 'final' && ac.landingEnd && ends[ac.landingEnd].runwayId === runwayId) {
        return approachCoords(ends[ac.landingEnd], ac.pos).along < 190;
      }
      return false;
    });
  }

  // --------------------------------------------------------------- commands

  /** Works out what releasing a drawn path at its last point would do. */
  planPath(ac: Aircraft, points: Vec[]): PathPlan {
    const last = points[points.length - 1];
    const route = this.routes.find((r) => dist(r.points[0], last) <= ROUTE_ENTRY_R * 1.25 && this.canJoin(ac, r));
    if (route) return { kind: 'join', route };
    if (ac.kind === 'arr') {
      const end = Object.values(this.airport.ends).find((e) => inCone(e, last));
      if (end) {
        if (!this.isActive(end.id)) return { kind: 'inactive', end };
        return { kind: 'land', end, tooHigh: !this.canDescendInTime(ac, [ac.pos, ...points], end) };
      }
    }
    return { kind: 'free' };
  }

  canJoin(ac: Aircraft, r: Route): boolean {
    if (r.kind === 'arr') return ac.kind === 'arr' && !!r.endId && this.isActive(r.endId);
    if (r.kind === 'dep') return ac.kind === 'dep';
    return true;
  }

  /** Rough check: can the plane get down onto the glide path by the end of this path? */
  private canDescendInTime(ac: Aircraft, path: Vec[], end: RunwayEnd): boolean {
    const length = pathLength(path);
    const avgSpeed = Math.max(150, Math.min(ac.speed, 230));
    const seconds = length / (avgSpeed * KT_TO_UPS);
    const along = approachCoords(end, path[path.length - 1]).along;
    const allowed = glideAltitude(along, GLIDE_ENTRY_ALT) + GLIDE_TOLERANCE * 0.8;
    return ac.alt - DESCENT_RATE * seconds <= allowed;
  }

  /** The smoothed path a plane will fly for a line drawn from it. */
  pathFromStroke(ac: Aircraft, rawPoints: Vec[]): Vec[] {
    return fitTrack(ac.pos, ac.heading, ac.speed, rawPoints);
  }

  commandPath(ac: Aircraft, rawPoints: Vec[]): PathPlan | null {
    if (ac.phase !== 'enroute' && ac.phase !== 'final') return null;
    const points = this.pathFromStroke(ac, rawPoints);
    if (points.length === 0) return null;
    const plan = this.planPath(ac, points);
    ac.phase = 'enroute';
    ac.holding = false;
    ac.routeId = null;
    ac.landingEnd = null;
    ac.path = points;
    ac.pathEnd = NO_PATH_END;
    switch (plan.kind) {
      case 'join':
        ac.pathEnd = { type: 'route', routeId: plan.route.id };
        if (plan.route.kind === 'arr' && plan.route.endId) clearForApproach(ac, plan.route.endId);
        break;
      case 'land':
        ac.pathEnd = { type: 'land', endId: plan.end.id };
        clearForApproach(ac, plan.end.id);
        break;
      case 'inactive':
        this.say(`RWY ${plan.end.id} NOT IN USE — WIND FAVOURS ${this.activeEnds().map((e) => e.id).join('/')}`, 'warn');
        break;
      case 'free':
        break;
    }
    return plan;
  }

  /** Sends a plane straight to a route's entry point. */
  joinRoute(ac: Aircraft, route: Route): boolean {
    if (ac.phase !== 'enroute' && ac.phase !== 'final') return false;
    if (!this.canJoin(ac, route)) {
      this.say(this.joinRefusal(ac, route), 'warn');
      return false;
    }
    this.commandPath(ac, [route.points[0]]);
    return true;
  }

  joinRefusal(ac: Aircraft, route: Route): string {
    if (route.kind === 'arr' && ac.kind === 'dep') return `${route.name} IS AN ARRIVAL ROUTE`;
    if (route.kind === 'arr') return `${route.name}: RWY ${route.endId} NOT IN USE`;
    if (route.kind === 'dep') return `${route.name} IS A DEPARTURE ROUTE`;
    return `CAN'T JOIN ${route.name}`;
  }

  canControl(ac: Aircraft): boolean {
    return ac.phase === 'enroute';
  }

  changeAltitude(ac: Aircraft, steps: number): void {
    if (!this.canControl(ac)) return;
    const [lo, hi] = ac.kind === 'arr' ? ARR_ALT : DEP_ALT;
    ac.targetAlt = clamp(Math.round(ac.targetAlt / ALT_STEP) * ALT_STEP + steps * ALT_STEP, lo, hi);
  }

  changeSpeed(ac: Aircraft, steps: number): void {
    if (!this.canControl(ac)) return;
    const [lo, hi] = ac.kind === 'arr' ? ARR_SPD : DEP_SPD;
    ac.targetSpeed = clamp(Math.round(ac.targetSpeed / SPD_STEP) * SPD_STEP + steps * SPD_STEP, lo, hi);
  }

  toggleHold(ac: Aircraft): void {
    if (!this.canControl(ac)) return;
    ac.holding = !ac.holding;
    if (ac.holding) {
      ac.path = [];
      ac.pathEnd = NO_PATH_END;
      ac.landingEnd = null;
      ac.routeId = null;
    }
  }

  launch(stripId: number, endId: string): boolean {
    const strip = this.strips.find((s) => s.id === stripId);
    const end = this.airport.ends[endId];
    if (!strip || !end || this.over) return false;
    if (!this.isActive(endId)) {
      this.say(`RWY ${endId} NOT IN USE`, 'warn');
      return false;
    }
    if (this.runwayBusy(end.runwayId, true)) {
      this.say(`RWY ${endId} BUSY — WAIT FOR IT TO CLEAR`, 'warn');
      return false;
    }
    this.strips = this.strips.filter((s) => s.id !== stripId);
    const ac = this.makeAircraft('dep', strip.callsign, strip.type, { ...end.threshold }, end.heading);
    ac.phase = 'takeoff';
    ac.alt = 0;
    ac.speed = 0;
    ac.targetAlt = DEP_INITIAL_ALT;
    ac.targetSpeed = DEP_INITIAL_SPD;
    ac.runwayEnd = endId;
    ac.gate = strip.gate;
    ac.waited = this.time - strip.since;
    const sid =
      this.routes.find((r) => r.kind === 'dep' && r.endId === endId && r.gate === strip.gate) ??
      this.routes.find((r) => r.kind === 'dep' && r.endId === endId && r.gate === null);
    if (sid) ac.pathEnd = { type: 'route', routeId: sid.id };
    this.aircraft.push(ac);
    return true;
  }

  // ----------------------------------------------------------------- routes

  addRoute(rawPoints: Vec[]): Route | null {
    const points = simplify(rawPoints, 12);
    if (pathLength(points) < 80) {
      this.say('ROUTE TOO SHORT', 'warn');
      return null;
    }
    if (this.routes.length >= MAX_ROUTES) {
      this.say(`MAX ${MAX_ROUTES} ROUTES — DELETE ONE FIRST`, 'warn');
      return null;
    }
    if (this.routes.some((r) => dist(r.points[0], points[0]) < ROUTE_ENTRY_R * 2)) {
      this.say('START TOO CLOSE TO ANOTHER ROUTE', 'warn');
      return null;
    }
    let n = 1;
    while (this.routes.some((r) => r.name === `R${n}`)) n++;
    const used = new Set(this.routes.map((r) => r.color));
    const color = ROUTE_COLORS.find((c) => !used.has(c)) ?? ROUTE_COLORS[n % ROUTE_COLORS.length];
    const route: Route = { id: `r${Date.now().toString(36)}${n}`, name: `R${n}`, points, color, ...classifyRoute(this.airport, points) };
    this.routes.push(route);
    this.routesVersion++;
    return route;
  }

  deleteRoute(id: string): void {
    this.routes = this.routes.filter((r) => r.id !== id);
    for (const ac of this.aircraft) {
      if (ac.pathEnd.type === 'route' && ac.pathEnd.routeId === id) ac.pathEnd = NO_PATH_END;
      if (ac.routeId === id) ac.routeId = null;
    }
    this.routesVersion++;
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    if (this.over) return;
    this.time += dt;
    this.updateWind();
    if (this.autoSpawn) this.spawn();

    const ctx = this.ctx;
    for (const ac of this.aircraft) {
      stepFlight(ac, dt, ctx);
      ac.trailTimer += dt;
      if (ac.trailTimer >= 1.2) {
        ac.trailTimer = 0;
        ac.trail.unshift({ ...ac.pos });
        if (ac.trail.length > 6) ac.trail.pop();
      }
    }

    this.processEvents(dt);
    this.checkSeparation(dt);
    this.predictTimer -= dt;
    if (this.predictTimer <= 0) {
      this.predictTimer = 0.5;
      this.predictConflicts();
    }
    this.messages = this.messages.filter((m) => this.time - m.t < 6);
  }

  private processEvents(dt: number): void {
    const remove = new Set<Aircraft>();
    for (const ac of this.aircraft) {
      if (ac.kind === 'arr' && isAirborne(ac)) {
        ac.fuel -= dt;
        if (!ac.lowFuelWarned && ac.fuel <= LOW_FUEL) {
          ac.lowFuelWarned = true;
          this.say(`${ac.callsign} LOW FUEL — LAND IT SOON`, 'warn');
        }
        if (ac.fuel <= 0 && ac.phase === 'enroute') {
          remove.add(ac);
          this.stats.diverted++;
          this.addScore(SCORE.diverted);
          this.say(`${ac.callsign} DIVERTED — OUT OF FUEL ${SCORE.diverted}`, 'bad');
          continue;
        }
      }

      if (ac.phase === 'final' && ac.landingEnd) {
        const end = this.airport.ends[ac.landingEnd];
        const { along } = approachCoords(end, ac.pos);
        const glide = glideAltitude(along, GLIDE_ENTRY_ALT);
        if (ac.alt > glide + GLIDE_TOLERANCE || (along < 40 && ac.alt > 600)) {
          this.goAround(ac, 'TOO HIGH');
        } else if (along <= 0) {
          if (this.runwayBusy(end.runwayId, false)) {
            this.goAround(ac, 'RUNWAY OCCUPIED');
          } else {
            ac.phase = 'rollout';
            ac.runwayEnd = end.id;
            ac.heading = end.heading;
            ac.alt = 0;
            ac.landingEnd = null;
          }
        }
      }

      if (ac.phase === 'rollout' && ac.speed <= 30) {
        remove.add(ac);
        this.stats.landed++;
        const fuelBonus = ac.fuel < LOW_FUEL ? 40 : 0;
        this.addScore(SCORE.landing + fuelBonus);
        this.say(`${ac.callsign} LANDED +${SCORE.landing + fuelBonus}`, 'good');
      }

      this.checkBoundary(ac, remove);
    }
    if (remove.size) this.aircraft = this.aircraft.filter((ac) => !remove.has(ac));
  }

  private checkBoundary(ac: Aircraft, remove: Set<Aircraft>): void {
    const p = ac.pos;
    const margin = 30;
    if (ac.entering) {
      if (p.x > margin && p.x < WORLD_W - margin && p.y > margin && p.y < WORLD_H - margin) ac.entering = false;
      return;
    }
    if (p.x >= 0 && p.x <= WORLD_W && p.y >= 0 && p.y <= WORLD_H) return;
    remove.add(ac);
    if (ac.kind === 'arr') {
      this.stats.lost++;
      this.addScore(SCORE.leftAirspace);
      this.say(`${ac.callsign} LEFT YOUR AIRSPACE ${SCORE.leftAirspace}`, 'bad');
      return;
    }
    const gate = gateAt(this.airport, p);
    if (gate && gate.id === ac.gate) {
      this.stats.departed++;
      const waitPenalty = Math.min(30, Math.floor(ac.waited / 4));
      const pts = (ac.alt >= EXIT_MIN_ALT ? SCORE.exitGood : SCORE.exitLow) - waitPenalty;
      this.addScore(pts);
      this.say(`${ac.callsign} HANDED OFF ${gate.id} +${pts}${ac.alt < EXIT_MIN_ALT ? ' (LOW)' : ''}`, 'good');
    } else {
      this.addScore(SCORE.wrongExit);
      this.say(`${ac.callsign} WRONG EXIT — WANTED ${ac.gate} ${SCORE.wrongExit}`, 'bad');
    }
  }

  private goAround(ac: Aircraft, why: string): void {
    ac.phase = 'enroute';
    ac.landingEnd = null;
    ac.path = [];
    ac.pathEnd = NO_PATH_END;
    ac.routeId = null;
    ac.targetAlt = Math.max(4000, Math.round(ac.alt / ALT_STEP) * ALT_STEP);
    ac.targetSpeed = 210;
    this.stats.goArounds++;
    this.addScore(SCORE.goAround);
    this.say(`${ac.callsign} GOING AROUND — ${why} ${SCORE.goAround}`, 'warn');
  }

  private separated(a: Aircraft, b: Aircraft, h: number, v: number): boolean {
    return dist(a.pos, b.pos) >= h || Math.abs(a.alt - b.alt) >= v;
  }

  private checkSeparation(dt: number): void {
    const flying = this.aircraft.filter((ac) => isAirborne(ac) && ac.alt >= 300);
    for (const ac of this.aircraft) ac.conflict = false;
    const pairs = new Set<string>();
    for (let i = 0; i < flying.length; i++) {
      for (let j = i + 1; j < flying.length; j++) {
        const a = flying[i];
        const b = flying[j];
        if (!this.separated(a, b, COLLIDE_H, COLLIDE_V)) {
          this.over = {
            reason: `${a.callsign} AND ${b.callsign} COLLIDED`,
            at: vec((a.pos.x + b.pos.x) / 2, (a.pos.y + b.pos.y) / 2),
          };
          return;
        }
        if (!this.separated(a, b, SEP_H, SEP_V)) {
          a.conflict = b.conflict = true;
          const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
          pairs.add(key);
          if (!this.conflictPairs.has(key)) {
            this.stats.separationLosses++;
            this.say(`SEPARATION LOST: ${a.callsign} / ${b.callsign}`, 'bad');
          }
          this.addScore(SCORE.separationPerSec * dt);
        }
      }
    }
    this.conflictPairs = pairs;
  }

  /** Flags planes that will lose separation within ~20 s if nothing changes. */
  private predictConflicts(): void {
    const ctx = this.ctx;
    const ghosts = this.aircraft.map(cloneForPrediction);
    for (const ac of this.aircraft) ac.predicted = false;
    const steps = 20;
    for (let s = 0; s < steps; s++) {
      for (const g of ghosts) {
        stepFlight(g, 0.5, ctx);
        stepFlight(g, 0.5, ctx);
      }
      for (let i = 0; i < ghosts.length; i++) {
        for (let j = i + 1; j < ghosts.length; j++) {
          const a = ghosts[i];
          const b = ghosts[j];
          if (!isAirborne(a) || !isAirborne(b) || a.alt < 300 || b.alt < 300) continue;
          if (!this.separated(a, b, SEP_H, SEP_V)) {
            this.aircraft[i].predicted = true;
            this.aircraft[j].predicted = true;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ wind

  private updateWind(): void {
    const w = this.wind;
    w.dir = norm360(w.baseDir + Math.sin(this.time / 23) * 7);
    if (!w.pending && this.time >= w.nextShiftAt - WIND_WARNING) {
      const toDir = norm360(w.baseDir + 180 + this.rng.range(-25, 25));
      w.pending = { at: w.nextShiftAt, toDir, speed: Math.round(this.rng.range(6, 20)) };
    }
    if (w.pending && this.time >= w.pending.at) {
      w.baseDir = w.pending.toDir;
      w.speed = w.pending.speed;
      w.dir = norm360(w.baseDir + Math.sin(this.time / 23) * 7);
      w.pending = null;
      w.nextShiftAt = this.time + this.rng.range(200, 320);
      this.onRunwayChange();
    }
  }

  /** After a wind shift: cancel approaches to runway ends that are no longer in use. */
  private onRunwayChange(): void {
    let cancelled = 0;
    for (const ac of this.aircraft) {
      const target = ac.landingEnd ?? (ac.pathEnd.type === 'land' ? ac.pathEnd.endId : null);
      if (!target || this.isActive(target)) continue;
      if (ac.phase === 'final' && approachCoords(this.airport.ends[target], ac.pos).along < 150) continue;
      ac.phase = 'enroute';
      ac.landingEnd = null;
      ac.pathEnd = NO_PATH_END;
      cancelled++;
    }
    for (const ac of this.aircraft) {
      if (ac.pathEnd.type !== 'route') continue;
      const routeId = ac.pathEnd.routeId;
      const route = this.routes.find((r) => r.id === routeId);
      if (route?.kind === 'arr' && route.endId && !this.isActive(route.endId)) {
        ac.pathEnd = NO_PATH_END;
        ac.landingEnd = null;
        cancelled++;
      }
    }
    const ids = this.activeEnds().map((e) => e.id).join('/');
    this.say(`WIND SHIFT — NOW USING RWY ${ids}${cancelled ? ` · ${cancelled} APPROACH${cancelled > 1 ? 'ES' : ''} CANCELLED` : ''}`, 'warn');
  }

  // ----------------------------------------------------------------- spawn

  private spawn(): void {
    const cfg = SETTINGS[this.difficulty];
    const ramp = Math.max(0.5, 1 - this.time / 700);
    if (this.time >= this.nextArrAt) {
      if (this.spawnArrival()) this.nextArrAt = this.time + cfg.arrEvery * ramp * this.rng.range(0.75, 1.25);
      else this.nextArrAt = this.time + 3;
    }
    if (this.time >= this.nextDepAt) {
      if (this.strips.length < MAX_STRIPS) this.addStrip();
      this.nextDepAt = this.time + cfg.depEvery * ramp * this.rng.range(0.75, 1.25);
    }
  }

  private callsign(): string {
    for (;;) {
      const cs = `${this.rng.pick(AIRLINES)}${this.rng.int(10, 989)}`;
      if (!this.usedCallsigns.has(cs)) {
        this.usedCallsigns.add(cs);
        return cs;
      }
    }
  }

  addStrip(gate?: GateId): DepStrip {
    const strip: DepStrip = {
      id: this.nextId++,
      callsign: this.callsign(),
      type: this.rng.pick(TYPES),
      gate: gate ?? this.rng.pick(this.airport.gates).id,
      since: this.time,
    };
    this.strips.push(strip);
    return strip;
  }

  private spawnArrival(): boolean {
    const cfg = SETTINGS[this.difficulty];
    for (let attempt = 0; attempt < 12; attempt++) {
      const side = this.rng.int(0, 3);
      const pos =
        side === 0
          ? vec(this.rng.range(80, WORLD_W - 80), 1)
          : side === 1
            ? vec(WORLD_W - 1, this.rng.range(80, WORLD_H - 80))
            : side === 2
              ? vec(this.rng.range(80, WORLD_W - 80), WORLD_H - 1)
              : vec(1, this.rng.range(80, WORLD_H - 80));
      const nearGate = this.airport.gates.some((g) => {
        const along = g.side === 'top' || g.side === 'bottom' ? pos.x : pos.y;
        const onSide = ['top', 'right', 'bottom', 'left'][side] === g.side;
        return onSide && Math.abs(along - g.center) < g.half + 50;
      });
      if (nearGate) continue;
      if (this.aircraft.some((a) => dist(a.pos, pos) < 160)) continue;
      const heading = norm360(headingTo(pos, this.airport.center) + this.rng.range(-20, 20));
      const alt = Math.round(this.rng.range(cfg.alt[0], cfg.alt[1]) / 1000) * 1000;
      this.spawnArrivalAt(pos, heading, alt);
      return true;
    }
    return false;
  }

  spawnArrivalAt(pos: Vec, heading: number, alt: number, fuel?: number): Aircraft {
    const cfg = SETTINGS[this.difficulty];
    const ac = this.makeAircraft('arr', this.callsign(), this.rng.pick(TYPES), pos, heading);
    ac.alt = ac.targetAlt = alt;
    ac.speed = ac.targetSpeed = 250;
    ac.fuel = fuel ?? this.rng.range(cfg.fuel[0], cfg.fuel[1]);
    ac.entering = pos.x < 30 || pos.x > WORLD_W - 30 || pos.y < 30 || pos.y > WORLD_H - 30;
    this.aircraft.push(ac);
    return ac;
  }

  private makeAircraft(kind: 'arr' | 'dep', callsign: string, type: string, pos: Vec, heading: number): Aircraft {
    return {
      id: this.nextId++,
      callsign,
      type,
      kind,
      phase: 'enroute',
      pos,
      heading,
      alt: 0,
      targetAlt: 0,
      speed: 0,
      targetSpeed: 0,
      path: [],
      pathEnd: NO_PATH_END,
      routeId: null,
      holding: false,
      landingEnd: null,
      runwayEnd: null,
      gate: null,
      fuel: Infinity,
      entering: false,
      trail: [],
      trailTimer: 0,
      conflict: false,
      predicted: false,
      lowFuelWarned: false,
      waited: 0,
    };
  }

  // ----------------------------------------------------------------- misc

  private addScore(points: number): void {
    this.score += points;
  }

  private msgId = 0;
  say(text: string, tone: Tone = 'info'): void {
    this.messages.push({ id: ++this.msgId, text, tone, t: this.time });
    if (this.messages.length > 5) this.messages.shift();
  }
}
