import type { Aircraft } from '../sim/aircraft';
import type { Game } from '../sim/game';
import { LOW_FUEL } from '../sim/constants';
import { describeRoute } from '../sim/routes';
import type { UiState } from './state';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const alt3 = (ft: number): string => String(Math.max(0, Math.round(ft / 100))).padStart(3, '0');

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface HudActions {
  launch(stripId: number, endId: string): void;
  altitude(steps: number): void;
  speed(steps: number): void;
  hold(): void;
  deleteRoute(id: string): void;
  togglePlan(): void;
  togglePause(): void;
  toggleFast(): void;
}

/** The DOM overlay: top bar, departures, selected plane and route planning panels. */
export class Hud {
  private el = {
    score: $('st-score'),
    time: $('st-time'),
    landed: $('st-landed'),
    departed: $('st-departed'),
    wind: $('wind'),
    windArrow: $('wind-arrow'),
    windVal: $('wind-val'),
    windRwy: $('wind-rwy'),
    banner: $('banner'),
    toasts: $('toasts'),
    strips: $('strips'),
    stripsEmpty: $('strips-empty'),
    depsCount: $('deps-count'),
    sel: $('sel'),
    plan: $('plan'),
    routeList: $('route-list'),
    paused: $('paused'),
    btnPlan: $<HTMLButtonElement>('btn-plan'),
    btnFast: $<HTMLButtonElement>('btn-fast'),
    btnPause: $<HTMLButtonElement>('btn-pause'),
    topbar: $('topbar'),
    deps: $('deps'),
  };
  private cache = new Map<string, string>();
  private stripRows = new Map<
    number,
    { li: HTMLLIElement; meta: HTMLElement; launch: HTMLElement; sig: string; metaText: string }
  >();
  private selEls: {
    cs: HTMLElement;
    kind: HTMLElement;
    status: HTMLElement;
    alt: HTMLElement;
    spd: HTMLElement;
    hold: HTMLButtonElement;
    fuel: HTMLElement;
    fuelBar: HTMLElement;
    fuelText: HTMLElement;
    buttons: HTMLButtonElement[];
  };

  constructor(private actions: HudActions) {
    // The selected-plane panel is built once; updates only change text, so
    // its buttons stay put while the player is pressing them.
    this.el.sel.innerHTML = `
      <div class="sel-head"><span class="sel-cs"></span><span class="sel-kind"></span></div>
      <div class="sel-status"></div>
      <div class="ctl"><span class="k">ALT</span>
        <button class="btn" type="button" data-act="alt-" title="Descend 1000 ft (↓)" aria-label="Descend 1000 ft">−</button>
        <span class="v" data-v="alt"></span>
        <button class="btn" type="button" data-act="alt+" title="Climb 1000 ft (↑)" aria-label="Climb 1000 ft">+</button></div>
      <div class="ctl"><span class="k">SPD</span>
        <button class="btn" type="button" data-act="spd-" title="Slow down 10 kt (←)" aria-label="Slow down 10 knots">−</button>
        <span class="v" data-v="spd"></span>
        <button class="btn" type="button" data-act="spd+" title="Speed up 10 kt (→)" aria-label="Speed up 10 knots">+</button></div>
      <button class="btn" type="button" data-act="hold" title="Circle where it is (H)">HOLD HERE</button>
      <div class="fuel"><span>FUEL</span><span class="fuel-bar"><i></i></span><span data-v="fuel"></span></div>`;
    const q = <T extends HTMLElement>(sel: string): T => this.el.sel.querySelector<T>(sel)!;
    this.selEls = {
      cs: q('.sel-cs'),
      kind: q('.sel-kind'),
      status: q('.sel-status'),
      alt: q('[data-v="alt"]'),
      spd: q('[data-v="spd"]'),
      hold: q<HTMLButtonElement>('[data-act="hold"]'),
      fuel: q('.fuel'),
      fuelBar: q('.fuel-bar i'),
      fuelText: q('[data-v="fuel"]'),
      buttons: [...this.el.sel.querySelectorAll<HTMLButtonElement>('button')],
    };
    this.el.strips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-launch]');
      if (b) this.actions.launch(Number(b.dataset.strip), b.dataset.launch ?? '');
    });
    this.el.sel.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'alt+') this.actions.altitude(1);
      if (act === 'alt-') this.actions.altitude(-1);
      if (act === 'spd+') this.actions.speed(1);
      if (act === 'spd-') this.actions.speed(-1);
      if (act === 'hold') this.actions.hold();
    });
    this.el.routeList.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-del]');
      if (b) this.actions.deleteRoute(b.dataset.del ?? '');
    });
    this.el.btnPlan.addEventListener('click', () => this.actions.togglePlan());
    $('btn-plan-done').addEventListener('click', () => this.actions.togglePlan());
    this.el.btnFast.addEventListener('click', () => this.actions.toggleFast());
    this.el.btnPause.addEventListener('click', () => this.actions.togglePause());
  }

  /** Only touch the DOM when a value actually changed. */
  private set(key: string, el: HTMLElement, html: string): void {
    if (this.cache.get(key) === html) return;
    this.cache.set(key, html);
    el.innerHTML = html;
  }

  /** Height of the top bar, so the map and panels can sit below it. */
  topInset(): number {
    return this.el.topbar.getBoundingClientRect().height;
  }

  update(game: Game, ui: UiState, mapRotation: number): void {
    const el = this.el;
    this.set('score', el.score, String(Math.round(game.score)));
    this.set('time', el.time, fmtTime(game.time));
    this.set('landed', el.landed, String(game.stats.landed));
    this.set('departed', el.departed, String(game.stats.departed));

    // Wind arrow points the way the wind is blowing (from `dir` towards the opposite side).
    const w = game.wind;
    el.windArrow.style.transform = `rotate(${Math.round(w.dir + 180 + mapRotation)}deg)`;
    this.set('windVal', el.windVal, `${String(Math.round(w.dir)).padStart(3, '0')}° ${w.speed}KT`);
    this.set('windRwy', el.windRwy, `RWY ${game.activeEnds().map((e) => e.id).join(' ')}`);
    el.wind.classList.toggle('shifting', !!w.pending);
    if (w.pending) {
      const left = Math.max(0, Math.ceil(w.pending.at - game.time));
      const ids = game.upcomingEnds().map((e) => e.id).join(' ');
      this.set('banner', el.banner, `WIND SHIFT IN ${fmtTime(left)} · RUNWAYS → ${ids}`);
      el.banner.hidden = false;
    } else {
      el.banner.hidden = true;
    }

    this.set(
      'toasts',
      el.toasts,
      game.messages
        .slice(-4)
        .map((m) => `<li class="${m.tone}">${esc(m.text)}</li>`)
        .join(''),
    );

    this.updateStrips(game);
    el.btnPlan.classList.toggle('on', ui.planMode);
    el.btnFast.classList.toggle('on', ui.fast);
    el.btnPause.classList.toggle('on', ui.paused);
    this.set('pauseLabel', el.btnPause, ui.paused ? 'RESUME' : 'PAUSE');
    el.paused.hidden = !ui.paused;

    el.plan.hidden = !ui.planMode;
    if (ui.planMode) this.updatePlan(game);
    const selected = ui.planMode ? undefined : game.aircraft.find((a) => a.id === ui.selectedId);
    el.sel.hidden = !selected;
    if (selected) this.updateSelected(game, selected);
  }

  private updateStrips(game: Game): void {
    const active = game.activeEnds();
    const busy = new Map(game.airport.runways.map((r) => [r.id, game.runwayBusy(r.id, true)]));
    const live = new Set<number>();
    for (const s of game.strips) {
      live.add(s.id);
      let row = this.stripRows.get(s.id);
      if (!row) {
        const gate = game.airport.gates.find((g) => g.id === s.gate);
        const li = document.createElement('li');
        li.className = 'strip';
        li.innerHTML = `<div><div class="cs">${s.callsign}</div><div class="meta"></div></div>
          <div class="gate" style="color:${gate?.color ?? 'inherit'}" title="Exit gate ${s.gate}">→${s.gate}</div>
          <div class="launch"></div>`;
        this.el.strips.appendChild(li);
        row = { li, meta: li.querySelector('.meta')!, launch: li.querySelector('.launch')!, sig: '', metaText: '' };
        this.stripRows.set(s.id, row);
      }
      const wait = game.time - s.since;
      const metaText = `${s.type} · WAIT ${fmtTime(wait)}`;
      if (metaText !== row.metaText) {
        row.metaText = metaText;
        row.meta.textContent = metaText;
      }
      row.li.classList.toggle('late', wait > 60);
      // Rebuild the launch buttons only when runway availability changes.
      const sig = active.map((e) => `${e.id}${busy.get(e.runwayId) ? '!' : ''}`).join(',');
      if (sig !== row.sig) {
        row.sig = sig;
        row.launch.innerHTML = active
          .map(
            (e) =>
              `<button class="btn" type="button" data-strip="${s.id}" data-launch="${e.id}" ${
                busy.get(e.runwayId) ? 'disabled title="Runway busy"' : `title="Take off from runway ${e.id}"`
              }>▲ ${e.id}</button>`,
          )
          .join('');
      }
    }
    for (const [id, row] of this.stripRows) {
      if (!live.has(id)) {
        row.li.remove();
        this.stripRows.delete(id);
      }
    }
    this.el.stripsEmpty.hidden = game.strips.length > 0;
    this.set('depsCount', this.el.depsCount, game.strips.length ? `· ${game.strips.length}` : '');
  }

  private updatePlan(game: Game): void {
    const html = game.routes.length
      ? game.routes
          .map((r) => {
            const usable = r.kind !== 'arr' || (r.endId !== null && game.isActive(r.endId));
            return `<li class="route-row">
              <span class="name" style="color:${r.color}">${r.name}</span>
              <span>${describeRoute(r)}${usable ? '' : ' · <span style="color:var(--ink-dim)">NOT IN USE</span>'}</span>
              <button class="btn" type="button" data-del="${r.id}" aria-label="Delete ${r.name}">DELETE</button>
            </li>`;
          })
          .join('')
      : '<li class="empty">No routes yet. Draw one on the map.</li>';
    this.set('routes', this.el.routeList, html);
  }

  private updateSelected(game: Game, ac: Aircraft): void {
    const sel = this.selEls;
    const can = game.canControl(ac);
    const landing = ac.landingEnd ?? (ac.pathEnd.type === 'land' ? ac.pathEnd.endId : null);
    const routeId = ac.routeId ?? (ac.pathEnd.type === 'route' ? ac.pathEnd.routeId : null);
    const route = routeId ? game.routes.find((r) => r.id === routeId) : null;
    let status: string;
    if (ac.phase === 'takeoff') status = `TAKING OFF RWY ${ac.runwayEnd ?? ''}`;
    else if (ac.phase === 'rollout') status = 'LANDED · ROLLING OUT';
    else if (ac.phase === 'final') status = `<span class="ok">ON FINAL RWY ${landing}</span>`;
    else if (ac.hold) status = `HOLDING ${ac.hold.dir > 0 ? 'CLOCKWISE' : 'ANTICLOCKWISE'}`;
    else if (ac.pathEnd.type === 'hold') status = 'FLYING TO HOLD';
    else if (landing) status = `<span class="ok">CLEARED TO LAND ${landing}</span>`;
    else if (route) status = `FLYING ROUTE <span style="color:${route.color}">${route.name}</span>`;
    else if (ac.path.length) status = 'FOLLOWING YOUR PATH';
    else status = ac.kind === 'arr' ? 'NEEDS A PATH TO A RUNWAY' : 'NEEDS ROUTING TO ITS EXIT';
    if (ac.kind === 'dep' && ac.gate) status += ` · EXIT <b>${ac.gate}</b>`;

    this.set('sel-cs', sel.cs, ac.callsign);
    sel.cs.style.color = ac.kind === 'arr' ? 'var(--arr)' : 'var(--dep)';
    this.set('sel-kind', sel.kind, `${ac.type} · ${ac.kind === 'arr' ? 'ARRIVAL' : 'DEPARTURE'}`);
    this.set('sel-status', sel.status, status);
    const altTarget =
      Math.abs(ac.targetAlt - ac.alt) > 60 ? ` <small>${ac.targetAlt > ac.alt ? '↑' : '↓'} ${alt3(ac.targetAlt)}</small>` : '';
    const spdTarget =
      Math.abs(ac.targetSpeed - ac.speed) > 4 ? ` <small>${ac.targetSpeed > ac.speed ? '↑' : '↓'} ${ac.targetSpeed}</small>` : '';
    this.set('sel-alt', sel.alt, `${alt3(ac.alt)}${altTarget}`);
    this.set('sel-spd', sel.spd, `${Math.round(ac.speed)}${spdTarget}`);
    for (const b of sel.buttons) b.disabled = !can;
    sel.hold.classList.toggle('on', !!ac.hold);
    this.set('sel-hold', sel.hold, ac.hold ? 'LEAVE HOLD' : 'HOLD HERE');
    const showFuel = ac.kind === 'arr' && Number.isFinite(ac.fuel);
    sel.fuel.hidden = !showFuel;
    if (showFuel) {
      sel.fuel.classList.toggle('low', ac.fuel < LOW_FUEL);
      sel.fuelBar.style.width = `${Math.max(0, Math.min(100, (ac.fuel / 300) * 100)).toFixed(0)}%`;
      this.set('sel-fuel', sel.fuelText, fmtTime(ac.fuel));
    }
  }
}
