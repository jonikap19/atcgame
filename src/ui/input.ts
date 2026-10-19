import type { Renderer } from '../render/renderer';
import type { View } from '../render/view';
import type { Game } from '../sim/game';
import { type Vec, dist } from '../sim/geom';
import type { UiState } from './state';

export interface InputHost {
  game(): Game | null;
  ui: UiState;
  view: View;
  renderer: Renderer;
  onRoutesChanged(): void;
}

/** Pointer and wheel handling on the radar canvas (mouse, pen and touch). */
export function attachInput(canvas: HTMLCanvasElement, host: InputHost): void {
  let pointerId: number | null = null;

  const local = (e: PointerEvent | WheelEvent): Vec => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const game = host.game();
    const ui = host.ui;
    if (!game || game.over || pointerId !== null) return;
    if (ui.paused) {
      ui.paused = false;
      return;
    }
    const q = local(e);
    const w = host.view.toWorld(q);
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);

    if (ui.planMode) {
      ui.stroke = { kind: 'route', aircraftId: null, points: [w], start: q, moved: false };
      return;
    }
    const ac = host.renderer.hitAircraft(game, q);
    if (ac) {
      ui.selectedId = ac.id;
      ui.stroke = { kind: 'plane', aircraftId: ac.id, points: [], start: q, moved: false };
      return;
    }
    const selected = game.aircraft.find((a) => a.id === ui.selectedId);
    const routeId = host.renderer.hitRouteEntry(game, q);
    if (selected && routeId) {
      const route = game.routes.find((r) => r.id === routeId);
      if (route) game.joinRoute(selected, route);
      return;
    }
    ui.selectedId = null;
  });

  canvas.addEventListener('pointermove', (e) => {
    const stroke = host.ui.stroke;
    if (!stroke || e.pointerId !== pointerId) return;
    const q = local(e);
    if (!stroke.moved && Math.hypot(q.x - stroke.start.x, q.y - stroke.start.y) > 8) stroke.moved = true;
    if (!stroke.moved) return;
    const w = host.view.toWorld(q);
    const last = stroke.points[stroke.points.length - 1];
    if (!last || dist(last, w) >= host.renderer.worldPx(4)) stroke.points.push(w);
  });

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    const ui = host.ui;
    const stroke = ui.stroke;
    ui.stroke = null;
    const game = host.game();
    if (!stroke || !game || cancelled || !stroke.moved) return;
    if (stroke.kind === 'route') {
      if (game.addRoute(stroke.points)) host.onRoutesChanged();
      return;
    }
    const ac = game.aircraft.find((a) => a.id === stroke.aircraftId);
    if (!ac || stroke.points.length === 0) return;
    const plan = game.commandPath(ac, stroke.points);
    if (plan?.kind === 'land' && plan.tooHigh) {
      game.say(`${ac.callsign} MAY BE TOO HIGH FOR ${plan.end.id} — DESCEND NOW`, 'warn');
    } else if (plan?.kind === 'land' && plan.tooFast) {
      game.say(`${ac.callsign} MAY BE TOO FAST FOR ${plan.end.id} — SLOW DOWN NOW`, 'warn');
    }
  };
  canvas.addEventListener('pointerup', (e) => finish(e, false));
  canvas.addEventListener('pointercancel', (e) => finish(e, true));

  // Mouse wheel over a plane (or with one selected) changes its altitude.
  canvas.addEventListener(
    'wheel',
    (e) => {
      const game = host.game();
      if (!game || game.over) return;
      const ac = host.renderer.hitAircraft(game, local(e)) ?? game.aircraft.find((a) => a.id === host.ui.selectedId);
      if (!ac) return;
      e.preventDefault();
      host.ui.selectedId = ac.id;
      game.changeAltitude(ac, e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
}
