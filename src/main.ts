import './style.css';
import { Renderer } from './render/renderer';
import { View } from './render/view';
import { gateSegment } from './sim/airport';
import { type Difficulty, Game } from './sim/game';
import { Hud, fmtTime } from './ui/hud';
import { attachInput } from './ui/input';
import { newUiState } from './ui/state';
import { loadBest, loadRoutes, saveBest, saveRoutes } from './ui/storage';

const STEP = 1 / 30;
const WIDE = 1100;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

class App {
  /** The shift being played, or null while the menu shows. */
  game: Game | null = null;
  /** Background traffic that flies behind the menu. */
  private demo = new Game({ difficulty: 'busy' });
  ui = newUiState();
  view = new View();
  renderer: Renderer;
  hud: Hud;
  private difficulty: Difficulty = 'normal';
  private acc = 0;
  private last = performance.now();
  private overShown = false;
  private savedRoutesVersion = 0;
  private canvas = $('scope') as HTMLCanvasElement;

  constructor() {
    this.renderer = new Renderer(this.canvas, this.view);
    this.hud = new Hud({
      launch: (strip, end) => this.game?.launch(strip, end),
      altitude: (n) => this.withSelected((g, ac) => g.changeAltitude(ac, n)),
      speed: (n) => this.withSelected((g, ac) => g.changeSpeed(ac, n)),
      hold: () => this.withSelected((g, ac) => g.toggleHold(ac)),
      deleteRoute: (id) => {
        this.game?.deleteRoute(id);
        this.persistRoutes();
      },
      togglePlan: () => {
        this.ui.planMode = !this.ui.planMode;
        this.ui.stroke = null;
      },
      togglePause: () => {
        this.ui.paused = !this.ui.paused;
      },
      toggleFast: () => {
        this.ui.fast = !this.ui.fast;
      },
    });
    attachInput(this.canvas, {
      game: () => this.game,
      ui: this.ui,
      view: this.view,
      renderer: this.renderer,
      onRoutesChanged: () => this.persistRoutes(),
    });
    this.bindMenu();
    this.bindKeys();
    window.addEventListener('resize', () => this.layout());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.game && !this.game.over) this.ui.paused = true;
    });
    this.layout();
    this.showMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  private withSelected(fn: (g: Game, ac: NonNullable<Game['aircraft'][number]>) => void): void {
    const g = this.game;
    const ac = g?.aircraft.find((a) => a.id === this.ui.selectedId);
    if (g && ac) fn(g, ac);
  }

  private persistRoutes(): void {
    if (!this.game) return;
    this.savedRoutesVersion = this.game.routesVersion;
    saveRoutes(this.game.routes);
  }

  // -------------------------------------------------------------- layout

  private layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.resize(w, h);
    const top = this.hud.topInset();
    document.documentElement.style.setProperty('--hud-top', `${Math.round(top)}px`);
    const playing = !!this.game;
    if (!playing) {
      this.view.fit(w, h, { top: 0, right: 0, bottom: 0, left: 0 });
    } else if (w >= WIDE) {
      // Wide screens: the map fills the height; panels float over its lower corners.
      const side = Math.max(10, Math.min(120, (w - 1.6 * (h - top)) / 2));
      this.view.fit(w, h, { top: top + 18, right: side, bottom: 18, left: side });
    } else {
      // Narrow screens: panels dock along the bottom.
      const dock = Math.max(130, Math.min(190, h * 0.24));
      document.documentElement.style.setProperty('--dock-h', `${Math.round(dock)}px`);
      // Leave a gap above the dock so exits on the map's bottom edge stay clear of it.
      this.view.fit(w, h, { top: top + 18, right: 6, bottom: dock + 40, left: 6 });
    }
    if (playing) this.keepExitsClear(w, h, top);
  }

  /**
   * Places the panels, wind banner and messages so they never cover an exit
   * gate. Each panel sits as low as it can in its column, but stops above any
   * gate there (and scrolls inside if that makes it shorter than its content).
   */
  private keepExitsClear(w: number, h: number, top: number): void {
    const game = this.game;
    if (!game) return;
    const pad = 30;
    const gates = game.airport.gates.map((g) => {
      const [a, b] = gateSegment(g).map((p) => this.view.toScreen(p));
      return {
        x0: Math.min(a.x, b.x) - pad,
        x1: Math.max(a.x, b.x) + pad,
        y0: Math.min(a.y, b.y) - pad,
        y1: Math.max(a.y, b.y) + pad,
      };
    });

    // On phones the panels sit in a dock below the map (see layout), so only
    // the floating corner panels of larger screens need moving.
    const narrow = w < 760;
    const columns: [string, number, number, number][] = narrow
      ? []
      : [
          ['deps', 12, 232, 150],
          ['sel', w - 260, w - 12, 240],
          ['plan', w - 260, w - 12, 220],
        ];
    if (narrow) {
      for (const id of ['deps', 'sel', 'plan']) {
        $(id).style.bottom = '';
        $(id).style.maxHeight = '';
      }
    }
    const margin = 12;
    for (const [id, x0, x1, minH] of columns) {
      // Gates in this column, lowest first.
      const blocks = gates.filter((r) => r.x1 > x0 && r.x0 < x1).sort((a, b) => b.y1 - a.y1);
      let bottom = h - margin;
      for (const r of blocks) {
        if (r.y0 >= bottom) continue; // entirely below the panel
        if (r.y1 <= bottom - minH) break; // enough room below this gate
        bottom = r.y0 - 6; // move up above this gate
      }
      let ceiling = top + 8;
      for (const r of blocks) if (r.y1 <= bottom && r.y1 + 6 > ceiling) ceiling = r.y1 + 6;
      const el = $(id);
      el.style.bottom = `${Math.round(h - bottom)}px`;
      el.style.maxHeight = `${Math.round(Math.max(80, bottom - ceiling))}px`;
    }

    // Wind banner and messages: kept narrower than the map (CSS) so they never
    // reach the exits on its left and right edges, and placed at the highest
    // spot below the top bar where they don't overlap an exit at the top or bottom.
    const half = Math.min(280, (w - 96) / 2);
    const inSpan = gates.filter((r) => r.x1 > w / 2 - half && r.x0 < w / 2 + half);
    const band = 3 * 22 + 18 + 3 * 27; // up to three banner lines and three messages
    const base = top + 6;
    const candidates = [base, ...inSpan.map((r) => r.y1 + 6)].filter((y) => y >= base).sort((p, q) => p - q);
    const overlayTop = candidates.find((y) => inSpan.every((r) => r.y1 <= y || r.y0 >= y + band)) ?? base;
    document.documentElement.style.setProperty('--overlay-top', `${Math.round(overlayTop)}px`);
  }

  // ---------------------------------------------------------------- menu

  private bindMenu(): void {
    const segs = [...document.querySelectorAll<HTMLButtonElement>('.seg-btn')];
    const pick = (d: Difficulty): void => {
      this.difficulty = d;
      for (const b of segs) b.setAttribute('aria-checked', String(b.dataset.diff === d));
      this.showBest();
    };
    for (const b of segs) b.addEventListener('click', () => pick(b.dataset.diff as Difficulty));
    pick('normal');
    $('btn-start').addEventListener('click', () => this.start());
    $('btn-again').addEventListener('click', () => this.start());
    $('btn-menu').addEventListener('click', () => this.showMenu());
  }

  private showBest(): void {
    const best = loadBest()[this.difficulty];
    $('best').textContent = best !== undefined ? `Best on ${this.difficulty.toUpperCase()}: ${best} points` : '';
  }

  private showMenu(): void {
    this.game = null;
    this.ui.selectedId = null;
    this.ui.planMode = false;
    this.ui.paused = false;
    $('menu').hidden = false;
    $('over').hidden = true;
    $('topbar').hidden = true;
    $('deps').hidden = true;
    this.showBest();
    this.layout();
  }

  private start(): void {
    this.game = new Game({ difficulty: this.difficulty, routes: loadRoutes() });
    this.savedRoutesVersion = this.game.routesVersion;
    Object.assign(this.ui, newUiState());
    this.overShown = false;
    this.acc = 0;
    $('menu').hidden = true;
    $('over').hidden = true;
    $('topbar').hidden = false;
    $('deps').hidden = false;
    this.layout();
  }

  private showOver(game: Game): void {
    this.overShown = true;
    const score = Math.round(game.score);
    const isBest = score > 0 && saveBest(game.difficulty, score);
    $('over-reason').textContent = game.over?.reason ?? 'SHIFT OVER';
    $('over-score').textContent = String(score);
    $('over-best').textContent = isBest ? `New best on ${game.difficulty.toUpperCase()}` : '';
    const s = game.stats;
    const rows: [string, string | number][] = [
      ['TIME', fmtTime(game.time)],
      ['LANDED', s.landed],
      ['DEPARTED', s.departed],
      ['MAYDAYS LANDED', `${s.emergenciesHandled} / ${s.emergencies}`],
      ['GO-AROUNDS', s.goArounds],
      ['SEPARATION LOST', s.separationLosses],
    ];
    $('over-stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    // Give the player a moment to see the collision before the card covers it.
    setTimeout(() => {
      if (this.game === game) $('over').hidden = false;
    }, 1400);
  }

  // ------------------------------------------------------------- keyboard

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const g = this.game;
      if (!g || e.target instanceof HTMLInputElement) return;
      const key = e.key;
      if (key === ' ') {
        e.preventDefault();
        this.ui.paused = !this.ui.paused;
        return;
      }
      if (key === 'p' || key === 'P') this.ui.planMode = !this.ui.planMode;
      if (key === 'f' || key === 'F') this.ui.fast = !this.ui.fast;
      if (key === 'Escape') {
        if (this.ui.planMode) this.ui.planMode = false;
        else this.ui.selectedId = null;
      }
      if (key === 'Tab') {
        // Cycle through planes.
        e.preventDefault();
        const list = g.aircraft;
        if (!list.length) return;
        const i = list.findIndex((a) => a.id === this.ui.selectedId);
        this.ui.selectedId = list[(i + (e.shiftKey ? list.length - 1 : 1)) % list.length].id;
      }
      const map: Record<string, () => void> = {
        ArrowUp: () => this.withSelected((gg, ac) => gg.changeAltitude(ac, 1)),
        ArrowDown: () => this.withSelected((gg, ac) => gg.changeAltitude(ac, -1)),
        ArrowRight: () => this.withSelected((gg, ac) => gg.changeSpeed(ac, 1)),
        ArrowLeft: () => this.withSelected((gg, ac) => gg.changeSpeed(ac, -1)),
        w: () => this.withSelected((gg, ac) => gg.changeAltitude(ac, 1)),
        s: () => this.withSelected((gg, ac) => gg.changeAltitude(ac, -1)),
        d: () => this.withSelected((gg, ac) => gg.changeSpeed(ac, 1)),
        a: () => this.withSelected((gg, ac) => gg.changeSpeed(ac, -1)),
        h: () => this.withSelected((gg, ac) => gg.toggleHold(ac)),
      };
      const action = map[key] ?? map[key.toLowerCase()];
      if (action && this.ui.selectedId !== null) {
        e.preventDefault();
        action();
      }
    });
  }

  // ----------------------------------------------------------------- loop

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const game = this.game;
    if (game) {
      if (!this.ui.paused && !game.over) {
        this.acc += dt * (this.ui.fast ? 2 : 1);
        while (this.acc >= STEP) {
          game.update(STEP);
          this.acc -= STEP;
        }
      }
      if (game.over && !this.overShown) this.showOver(game);
      if (game.routesVersion !== this.savedRoutesVersion) this.persistRoutes();
      if (this.ui.selectedId !== null && !game.aircraft.some((a) => a.id === this.ui.selectedId)) {
        this.ui.selectedId = null;
      }
      this.renderer.draw(game, this.ui, now / 1000);
      this.hud.update(game, this.ui, this.view.rotation);
    } else {
      this.demo.update(dt);
      if (this.demo.over || this.demo.time > 400) this.demo = new Game({ difficulty: 'busy' });
      this.renderer.draw(this.demo, newUiState(), now / 1000);
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}

// Wait for the radar font so canvas labels don't measure with a fallback face.
const fontsReady = document.fonts?.ready ?? Promise.resolve();
Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => {
  // Exposed for debugging and automated playtests.
  (window as unknown as { glidepath: App }).glidepath = new App();
});
