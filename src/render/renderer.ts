import type { Aircraft } from '../sim/aircraft';
import { type RunwayEnd, conePolygon, gateOutHeading, gatePoint, gateSegment } from '../sim/airport';
import {
  APPROACH_MAX_ALT,
  APPROACH_MAX_SPEED,
  CONE_LEN,
  KT_TO_UPS,
  LOW_FUEL,
  ROUTE_ENTRY_R,
  SEP_H,
  WORLD_H,
  WORLD_W,
} from '../sim/constants';
import type { Game, PathPlan } from '../sim/game';
import type { Hold } from '../sim/pathfit';
import { type Vec, headingVec, vec } from '../sim/geom';
import { classifyRoute, simplify } from '../sim/routes';
import type { UiState } from '../ui/state';
import { C, MONO } from './theme';
import type { View } from './view';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LABEL_OFFSETS: Vec[] = [
  { x: 14, y: -40 },
  { x: 14, y: 10 },
  { x: -14, y: -40 },
  { x: -14, y: 10 },
];

const alt3 = (ft: number): string => String(Math.max(0, Math.round(ft / 100))).padStart(3, '0');

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  /** Screen rectangles of data blocks, used for hit testing. */
  labelRects = new Map<number, Rect>();
  private labelSlot = new Map<number, number>();
  /** Seconds, for animations. */
  private now = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: View,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private S(p: Vec): Vec {
    return this.view.toScreen(p);
  }

  private line(points: Vec[], color: string, width = 1, dash: number[] = []): void {
    if (points.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    const p0 = this.S(points[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = this.S(points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private text(s: string, p: Vec, color: string, size = 11, align: CanvasTextAlign = 'left', weight = 400): void {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${MONO}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(s, p.x, p.y);
  }

  draw(game: Game, ui: UiState, realTime: number): void {
    this.now = realTime;
    const ctx = this.ctx;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawScope(game);
    this.drawRunways(game, realTime);
    this.drawRoutes(game, ui);
    for (const ac of game.aircraft) this.drawPathAndVector(game, ac, ui);
    for (const ac of game.aircraft) this.drawBlip(ac, ui);
    this.drawLabels(game, ui);
    this.drawStroke(game, ui);
    if (game.over) this.drawCrash(game.over.at, realTime);
  }

  // ------------------------------------------------------------- background

  private drawScope(game: Game): void {
    const ctx = this.ctx;
    const corners = [vec(0, 0), vec(WORLD_W, 0), vec(WORLD_W, WORLD_H), vec(0, WORLD_H), vec(0, 0)];
    ctx.save();
    // Clip to the map so range rings don't spill under the HUD.
    ctx.beginPath();
    corners.forEach((c, i) => {
      const p = this.S(c);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.clip();
    for (let x = 100; x < WORLD_W; x += 100) this.line([vec(x, 0), vec(x, WORLD_H)], C.grid);
    for (let y = 100; y < WORLD_H; y += 100) this.line([vec(0, y), vec(WORLD_W, y)], C.grid);
    const c = this.S(game.airport.center);
    for (let r = 150; r <= 900; r += 150) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * this.view.scale, 0, Math.PI * 2);
      ctx.strokeStyle = C.ring;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (r <= 450) {
        const lp = this.S(vec(game.airport.center.x + r * 0.707 + 4, game.airport.center.y - r * 0.707 - 4));
        this.text(`${r / 30}`, lp, C.dim, 9);
      }
    }
    ctx.restore();
    this.line(corners, C.edge, 1);

    for (const g of game.airport.gates) {
      const [a, b] = gateSegment(g);
      this.line([a, b], g.color, 4);
      const inward = headingVec(gateOutHeading(g) + 180);
      const mid = gatePoint(g);
      const lp = this.S(vec(mid.x + inward.x * 22, mid.y + inward.y * 22));
      this.text(g.id, lp, g.color, 13, 'center', 600);
      const tip = vec(mid.x - inward.x * 2, mid.y - inward.y * 2);
      const tail = vec(mid.x + inward.x * 10, mid.y + inward.y * 10);
      this.line([tail, tip], g.color, 1.5);
    }
  }

  private drawCone(end: RunwayEnd, stroke: string, fill: string, dash: number[]): void {
    const ctx = this.ctx;
    const poly = conePolygon(end).map((p) => this.S(p));
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    const back = headingVec(end.heading + 180);
    const far = vec(end.threshold.x + back.x * CONE_LEN, end.threshold.y + back.y * CONE_LEN);
    this.line([end.threshold, far], stroke, 1, [2, 8]);
  }

  /** "MAX 045 · 220KT" beyond the mouth of a landing cone. */
  private drawApproachLimits(end: RunwayEnd): void {
    const back = headingVec(end.heading + 180);
    const at = vec(end.threshold.x + back.x * (CONE_LEN + 26), end.threshold.y + back.y * (CONE_LEN + 26));
    const p = this.S(at);
    const label = `MAX ${alt3(APPROACH_MAX_ALT)} · ${APPROACH_MAX_SPEED}KT`;
    const ctx = this.ctx;
    ctx.font = `600 10px ${MONO}`;
    const w = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(10, 20, 27, 0.8)';
    ctx.fillRect(p.x - w / 2, p.y - 7, w, 14);
    this.text(label, p, C.cone, 10, 'center', 600);
  }

  /** Red crosses over a closed runway (blinking amber while the closure is pending). */
  private drawClosure(from: Vec, to: Vec, closed: boolean, secondsLeft: number, realTime: number): void {
    const ctx = this.ctx;
    const a = this.S(from);
    const b = this.S(to);
    const color = closed ? C.alert : C.warn;
    if (!closed && Math.sin(realTime * 6) < 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const size = Math.max(5, 9 * this.view.scale);
    for (const t of [0.2, 0.5, 0.8]) {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.beginPath();
      ctx.moveTo(x - size, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.moveTo(x + size, y - size);
      ctx.lineTo(x - size, y + size);
      ctx.stroke();
    }
    const s = Math.max(0, Math.ceil(secondsLeft));
    const label = `${closed ? 'CLOSED' : 'CLOSING'} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 14 };
    ctx.font = `600 10px ${MONO}`;
    const w = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(10, 20, 27, 0.85)';
    ctx.fillRect(mid.x - w / 2, mid.y - 7, w, 14);
    this.text(label, mid, color, 10, 'center', 600);
  }

  private drawRunways(game: Game, realTime: number): void {
    const ctx = this.ctx;
    const upcoming = new Set(game.upcomingEnds().map((e) => e.id));
    for (const end of game.usableEnds()) {
      if (upcoming.size && !upcoming.has(end.id)) {
        // Fading out: this direction is about to stop being used.
        this.drawCone(end, 'rgba(160,225,205,0.35)', C.coneFill, [5, 5]);
      } else {
        this.drawCone(end, C.cone, C.coneFill, [5, 4]);
        this.drawApproachLimits(end);
      }
    }
    if (upcoming.size) {
      const pulse = 0.25 + 0.25 * Math.sin(realTime * 5);
      for (const id of upcoming) {
        if (game.isActive(id)) continue;
        this.drawCone(game.airport.ends[id], `rgba(255,170,51,${pulse + 0.2})`, 'rgba(255,170,51,0.05)', [3, 6]);
      }
    }

    for (const rw of game.airport.runways) {
      const a = this.S(rw.a);
      const b = this.S(rw.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = C.runway;
      ctx.lineWidth = Math.max(3, 8 * this.view.scale);
      ctx.lineCap = 'butt';
      ctx.stroke();
      const busy = game.runwayBusy(rw.id, false);
      if (busy) {
        ctx.strokeStyle = C.warn;
        ctx.lineWidth = Math.max(1, 2 * this.view.scale);
        ctx.stroke();
      }
      const closure = game.closures.find((c) => c.runwayId === rw.id);
      if (closure) this.drawClosure(rw.a, rw.b, closure.started, closure.started ? closure.endsAt - game.time : closure.startsAt - game.time, realTime);
    }
    for (const end of Object.values(game.airport.ends)) {
      const active = game.canUse(end.id);
      const back = headingVec(end.heading + 180);
      const p = this.S(vec(end.threshold.x + back.x * 20, end.threshold.y + back.y * 20));
      this.text(end.id, p, active ? C.runway : C.runwayIdle, 10, 'center', active ? 600 : 400);
    }
  }

  // ----------------------------------------------------------------- routes

  private drawRoutes(game: Game, ui: UiState): void {
    const ctx = this.ctx;
    const selected = game.aircraft.find((a) => a.id === ui.selectedId);
    for (const r of game.routes) {
      const usable = r.kind !== 'arr' || (r.endId !== null && game.isActive(r.endId));
      const alpha = !usable ? 0.18 : ui.planMode ? 0.95 : 0.55;
      ctx.globalAlpha = alpha;
      this.line(r.points, r.color, ui.planMode ? 2 : 1.5, [7, 5]);
      const last = r.points[r.points.length - 1];
      const prev = r.points[Math.max(0, r.points.length - 4)];
      this.arrowHead(prev, last, r.color);
      const s = this.S(r.points[0]);
      const joinable = selected ? game.canJoin(selected, r) : true;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(9, ROUTE_ENTRY_R * this.view.scale), 0, Math.PI * 2);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = selected && joinable && usable ? 2 : 1;
      ctx.stroke();
      this.text(r.name, s, r.color, 11, 'center', 600);
      ctx.globalAlpha = 1;
    }
  }

  private arrowHead(from: Vec, to: Vec, color: string): void {
    const a = this.S(from);
    const b = this.S(to);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 9 * Math.cos(ang - 0.45), b.y - 9 * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - 9 * Math.cos(ang + 0.45), b.y - 9 * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // --------------------------------------------------------------- aircraft

  private colorOf(ac: Aircraft, ui: UiState): string {
    if (ac.conflict) return C.alert;
    if (ac.emergency) return C.mayday;
    if (ac.kind === 'arr' && ac.fuel < LOW_FUEL) return C.warn;
    if (ac.id === ui.selectedId) return C.sel;
    return ac.kind === 'arr' ? C.arr : C.dep;
  }

  private drawPathAndVector(game: Game, ac: Aircraft, ui: UiState): void {
    const selected = ac.id === ui.selectedId;
    const base = ac.kind === 'arr' ? C.arr : C.dep;
    for (let i = 0; i < ac.trail.length; i++) {
      const p = this.S(ac.trail[i]);
      this.ctx.globalAlpha = 0.5 - i * 0.07;
      this.ctx.fillStyle = base;
      this.ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    this.ctx.globalAlpha = 1;

    const hold = ac.hold ?? (ac.pathEnd.type === 'hold' ? ac.pathEnd.hold : null);
    if (hold) this.drawHold(hold, selected ? C.sel : base, selected ? 0.8 : 0.4);
    if (ac.path.length) {
      const pts = [ac.pos, ...ac.path];
      this.line(pts, selected ? C.sel : base, selected ? 1.5 : 1, selected ? [] : [3, 5]);
      const target = ac.landingEnd ?? (ac.pathEnd.type === 'land' ? ac.pathEnd.endId : null);
      if (target) this.line([pts[pts.length - 1], game.airport.ends[target].threshold], C.good, 1, [2, 4]);
    } else if (ac.phase === 'enroute' && !ac.hold) {
      // Where the plane will be in 20 seconds on its current heading.
      const d = ac.speed * KT_TO_UPS * 20;
      const v = headingVec(ac.heading);
      this.line([ac.pos, vec(ac.pos.x + v.x * d, ac.pos.y + v.y * d)], base, 1, [1, 4]);
    }
  }

  private drawBlip(ac: Aircraft, ui: UiState): void {
    const ctx = this.ctx;
    const p = this.S(ac.pos);
    const color = this.colorOf(ac, ui);
    const v = headingVec(ac.heading);
    const tip = this.S(vec(ac.pos.x + v.x, ac.pos.y + v.y));
    const ang = Math.atan2(tip.y - p.y, tip.x - p.x);
    const size = ac.phase === 'rollout' || (ac.phase === 'takeoff' && ac.alt <= 0) ? 5 : 7;

    if (ac.emergency) {
      const pulse = 0.5 + 0.5 * Math.sin(this.now * 5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15 + pulse * 6, 0, Math.PI * 2);
      ctx.strokeStyle = C.mayday;
      ctx.globalAlpha = 0.4 + 0.5 * (1 - pulse);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (ac.conflict || ac.predicted) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(12, (SEP_H / 2) * this.view.scale), 0, Math.PI * 2);
      ctx.setLineDash(ac.conflict ? [] : [3, 4]);
      ctx.strokeStyle = ac.conflict ? C.alert : C.warn;
      ctx.lineWidth = ac.conflict ? 1.5 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ac.id === ui.selectedId) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = C.sel;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(size + 2, 0);
    ctx.lineTo(-size, -size * 0.75);
    ctx.lineTo(-size * 0.45, 0);
    ctx.lineTo(-size, size * 0.75);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

  }

  /** A dashed hold circle with arrowheads showing which way round it goes. */
  private drawHold(hold: Hold, color: string, alpha: number): void {
    const ctx = this.ctx;
    const c = this.S(hold.center);
    const r = hold.radius * this.view.scale;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const bearing of [45, 225]) {
      const at = vec(hold.center.x + headingVec(bearing).x * hold.radius, hold.center.y + headingVec(bearing).y * hold.radius);
      const dir = headingVec(bearing + 90 * hold.dir);
      this.arrowHead(vec(at.x - dir.x * 10, at.y - dir.y * 10), at, color);
    }
    ctx.globalAlpha = 1;
  }

  private labelLines(game: Game, ac: Aircraft): string[] {
    const altPart =
      Math.abs(ac.targetAlt - ac.alt) > 60
        ? `${alt3(ac.alt)}${ac.targetAlt > ac.alt ? '↑' : '↓'}${alt3(ac.targetAlt)}`
        : alt3(ac.alt);
    const spd = Math.round(ac.speed);
    const spdPart =
      Math.abs(ac.targetSpeed - ac.speed) > 4 ? `${spd}${ac.targetSpeed > ac.speed ? '↑' : '↓'}${ac.targetSpeed}` : `${spd}`;
    const tags: string[] = [];
    if (ac.kind === 'dep') tags.push(`→${ac.gate}`);
    const landing = ac.landingEnd ?? (ac.pathEnd.type === 'land' ? ac.pathEnd.endId : null);
    if (landing) tags.push(`LDG ${landing}`);
    const routeId = ac.routeId ?? (ac.pathEnd.type === 'route' ? ac.pathEnd.routeId : null);
    const route = routeId ? game.routes.find((r) => r.id === routeId) : null;
    if (route) tags.push(route.name);
    if (ac.hold || ac.pathEnd.type === 'hold') tags.push('HOLD');
    if (ac.emergency) tags.unshift(`MAYDAY ${fmtTime(ac.emergency.deadline - game.time)}`);
    else if (ac.kind === 'arr' && ac.fuel < LOW_FUEL) tags.push(`FUEL ${fmtTime(ac.fuel)}`);
    return [ac.callsign, `${altPart} ${spdPart}`, tags.join(' ')].filter(Boolean);
  }

  private drawLabels(game: Game, ui: UiState): void {
    const ctx = this.ctx;
    ctx.font = `400 11px ${MONO}`;
    const placed: Rect[] = game.aircraft.map((ac) => {
      const p = this.S(ac.pos);
      return { x: p.x - 9, y: p.y - 9, w: 18, h: 18 };
    });
    const live = new Set<number>();
    // Selected plane last so it is drawn on top.
    const order = [...game.aircraft].sort((a, b) => Number(a.id === ui.selectedId) - Number(b.id === ui.selectedId));
    for (const ac of order) {
      live.add(ac.id);
      const lines = this.labelLines(game, ac);
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 6;
      const h = lines.length * 13 + 2;
      const p = this.S(ac.pos);
      const rectFor = (slot: number): Rect => {
        const o = LABEL_OFFSETS[slot];
        const x = o.x >= 0 ? p.x + o.x : p.x + o.x - w;
        const y = o.y < 0 ? p.y + o.y + (40 - h) : p.y + o.y;
        return { x, y, w, h };
      };
      const overlaps = (r: Rect): boolean =>
        placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
      let slot = this.labelSlot.get(ac.id) ?? 0;
      if (overlaps(rectFor(slot))) {
        const free = [0, 1, 2, 3].find((s) => !overlaps(rectFor(s)));
        if (free !== undefined) slot = free;
      }
      this.labelSlot.set(ac.id, slot);
      const r = rectFor(slot);
      placed.push(r);
      this.labelRects.set(ac.id, r);

      const color = this.colorOf(ac, ui);
      const anchor = { x: r.x + (r.x > p.x ? 0 : r.w), y: r.y + (r.y > p.y ? 0 : r.h) };
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(anchor.x, anchor.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (ac.id === ui.selectedId) {
        ctx.fillStyle = 'rgba(10, 20, 27, 0.85)';
        ctx.fillRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2);
      }
      lines.forEach((l, i) => {
        const tagColor = i === 2 && ac.kind === 'dep' && ac.gate ? this.gateColor(game, ac) : color;
        this.text(l, { x: r.x + 3, y: r.y + 8 + i * 13 }, i === 0 ? color : tagColor, 11, 'left', i === 0 ? 600 : 400);
      });
    }
    for (const id of this.labelRects.keys()) if (!live.has(id)) this.labelRects.delete(id);
    for (const id of this.labelSlot.keys()) if (!live.has(id)) this.labelSlot.delete(id);
  }

  private gateColor(game: Game, ac: Aircraft): string {
    return game.airport.gates.find((g) => g.id === ac.gate)?.color ?? C.dep;
  }

  // ------------------------------------------------------------ interaction

  private drawStroke(game: Game, ui: UiState): void {
    const s = ui.stroke;
    if (!s || !s.moved || s.points.length < 2) return;
    const last = s.points[s.points.length - 1];
    const lp = this.S(last);
    if (s.kind === 'route') {
      const pts = simplify(s.points, 12);
      const cls = classifyRoute(game.airport, pts);
      const label =
        cls.kind === 'arr' ? `ARRIVAL RWY ${cls.endId}` : cls.kind === 'dep' ? `DEPARTURE RWY ${cls.endId}${cls.gate ? ` → ${cls.gate}` : ''}` : cls.gate ? `EXIT → ${cls.gate}` : 'GENERAL ROUTE';
      this.line(pts, C.sel, 2, [7, 5]);
      this.hint(label, lp, C.sel);
      return;
    }
    const ac = game.aircraft.find((a) => a.id === s.aircraftId);
    if (!ac) return;
    const result = game.strokePlan(ac, s.points);
    if (!result) return;
    const { path } = result;
    const plan: PathPlan = result.plan;
    const [color, label] =
      plan.kind === 'hold'
        ? [C.sel, `HOLD ${plan.hold.dir > 0 ? 'CLOCKWISE' : 'ANTICLOCKWISE'}`]
        : plan.kind === 'land'
        ? plan.tooHigh && plan.tooFast
          ? [C.warn, `TOO HIGH AND FAST FOR ${plan.end.id} — EXTEND THE PATH`]
          : plan.tooHigh
            ? [C.warn, `TOO HIGH FOR ${plan.end.id} — DESCEND OR EXTEND`]
            : plan.tooFast
              ? [C.warn, `TOO FAST FOR ${plan.end.id} — SLOW TO ${APPROACH_MAX_SPEED} OR EXTEND`]
              : [C.good, `CLEARED TO LAND ${plan.end.id}`]
        : plan.kind === 'join'
          ? [plan.route.color, `JOIN ${plan.route.name}`]
          : plan.kind === 'inactive'
            ? [C.alert, `RWY ${plan.end.id} NOT IN USE`]
            : plan.kind === 'closed'
              ? [C.alert, `RWY ${plan.end.id} IS CLOSED`]
              : [C.sel, ''];
    // Show the whole stroke faintly, and the part the plane will fly brightly.
    this.ctx.globalAlpha = 0.3;
    this.line(s.points, color, 1.5);
    this.ctx.globalAlpha = 1;
    this.line([ac.pos, ...path], color, 2);
    if (plan.kind === 'hold') this.drawHold(plan.hold, color, 0.9);
    if (label) this.hint(label, lp, color);
  }

  private hint(label: string, at: Vec, color: string): void {
    const ctx = this.ctx;
    ctx.font = `600 11px ${MONO}`;
    const w = ctx.measureText(label).width + 10;
    let x = at.x + 12;
    if (x + w > this.width - 8) x = at.x - 12 - w;
    const y = at.y - 26;
    ctx.fillStyle = 'rgba(10, 20, 27, 0.9)';
    ctx.fillRect(x, y - 9, w, 18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y - 8.5, w - 1, 17);
    this.text(label, { x: x + 5, y }, color, 11, 'left', 600);
  }

  private drawCrash(at: Vec, realTime: number): void {
    const ctx = this.ctx;
    const p = this.S(at);
    const r = 18 + 6 * Math.sin(realTime * 6);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = C.alert;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 8, p.y - 8);
    ctx.lineTo(p.x + 8, p.y + 8);
    ctx.moveTo(p.x + 8, p.y - 8);
    ctx.lineTo(p.x - 8, p.y + 8);
    ctx.stroke();
  }

  /** The plane under a screen point: its blip or its data block. */
  hitAircraft(game: Game, q: Vec): Aircraft | null {
    let best: Aircraft | null = null;
    let bestD = 26;
    for (const ac of game.aircraft) {
      const p = this.S(ac.pos);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) {
        best = ac;
        bestD = d;
      }
    }
    if (best) return best;
    for (const ac of game.aircraft) {
      const r = this.labelRects.get(ac.id);
      if (r && q.x >= r.x - 3 && q.x <= r.x + r.w + 3 && q.y >= r.y - 3 && q.y <= r.y + r.h + 3) return ac;
    }
    return null;
  }

  /** The route whose entry ring is under a screen point. */
  hitRouteEntry(game: Game, q: Vec): string | null {
    for (const r of game.routes) {
      const s = this.S(r.points[0]);
      if (Math.hypot(s.x - q.x, s.y - q.y) <= Math.max(14, ROUTE_ENTRY_R * this.view.scale + 4)) return r.id;
    }
    return null;
  }

  /** Distance in world units that `px` screen pixels covers. */
  worldPx(px: number): number {
    return px / this.view.scale;
  }

}
