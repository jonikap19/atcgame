import './style.css';
import { Renderer } from './render/renderer';
import { View } from './render/view';
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
      this.view.fit(w, h, { top: top + 4, right: side, bottom: 10, left: side });
    } else {
      // Narrow screens: panels dock along the bottom.
      const dock = Math.max(130, Math.min(190, h * 0.24));
      document.documentElement.style.setProperty('--dock-h', `${Math.round(dock)}px`);
      this.view.fit(w, h, { top: top + 4, right: 6, bottom: dock + 14, left: 6 });
    }
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
      ['GO-AROUNDS', s.goArounds],
      ['SEPARATION LOST', s.separationLosses],
      ['DIVERTED / LOST', s.diverted + s.lost],
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
