import { describe, expect, it } from 'vitest';
import { approachCoords, gateAt, inCone, makeAirport } from '../src/sim/airport';
import { WORLD_H, WORLD_W } from '../src/sim/constants';
import { Game } from '../src/sim/game';
import { angleDiff, headingTo, vec } from '../src/sim/geom';
import { classifyRoute } from '../src/sim/routes';

function run(game: Game, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) game.update(dt);
}

function quietGame(windDir = 270): Game {
  return new Game({ difficulty: 'normal', seed: 1, autoSpawn: false, windDir });
}

describe('geometry', () => {
  it('uses compass headings', () => {
    expect(headingTo(vec(0, 0), vec(0, -10))).toBeCloseTo(0);
    expect(headingTo(vec(0, 0), vec(10, 0))).toBeCloseTo(90);
    expect(headingTo(vec(0, 0), vec(-10, 0))).toBeCloseTo(270);
    expect(angleDiff(350, 10)).toBeCloseTo(20);
    expect(angleDiff(10, 350)).toBeCloseTo(-20);
  });

  it('puts the landing cone on the approach side of the threshold', () => {
    const ap = makeAirport();
    const e27r = ap.ends['27R']; // threshold at east end, planes approach from the east
    expect(inCone(e27r, vec(e27r.threshold.x + 200, e27r.threshold.y))).toBe(true);
    expect(inCone(e27r, vec(e27r.threshold.x - 200, e27r.threshold.y))).toBe(false);
    expect(approachCoords(e27r, vec(e27r.threshold.x + 100, e27r.threshold.y)).along).toBeCloseTo(100);
  });

  it('finds the gate a departure leaves through', () => {
    const ap = makeAirport();
    expect(gateAt(ap, vec(520, -3))?.id).toBe('N');
    expect(gateAt(ap, vec(WORLD_W + 2, 270))?.id).toBe('E');
    expect(gateAt(ap, vec(1080, WORLD_H + 2))?.id).toBe('S');
    expect(gateAt(ap, vec(200, -3))).toBeNull();
  });
});

describe('wind and runways', () => {
  it('lands into the wind', () => {
    expect(quietGame(270).activeEnds().map((e) => e.id).sort()).toEqual(['27L', '27R']);
    expect(quietGame(90).activeEnds().map((e) => e.id).sort()).toEqual(['09L', '09R']);
  });

  it('warns before a wind shift, then flips the runways', () => {
    const g = quietGame(270);
    g.wind.nextShiftAt = 60;
    run(g, 16);
    expect(g.wind.pending).not.toBeNull();
    expect(g.upcomingEnds().map((e) => e.id).sort()).toEqual(['09L', '09R']);
    expect(g.activeEnds().map((e) => e.id).sort()).toEqual(['27L', '27R']);
    run(g, 46);
    expect(g.wind.pending).toBeNull();
    expect(g.activeEnds().map((e) => e.id).sort()).toEqual(['09L', '09R']);
  });

  it('cancels far-out approaches when the runway direction changes', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(1450, 455), 270, 3000, 500);
    g.commandPath(ac, [vec(1300, 455), vec(end.threshold.x + 250, end.threshold.y)]);
    expect(ac.landingEnd).toBe('27R');
    g.wind.nextShiftAt = g.time + 0.05;
    g.wind.pending = { at: g.time + 0.05, toDir: 90, speed: 10 };
    run(g, 0.2);
    expect(ac.landingEnd).toBeNull();
    expect(ac.pathEnd.type).toBe('none');
  });
});

describe('arrivals', () => {
  it('lands a plane whose path ends in the active cone', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(1400, 455), 270, 4000, 500);
    const plan = g.commandPath(ac, [vec(1300, 455), vec(end.threshold.x + 280, end.threshold.y)]);
    expect(plan?.kind).toBe('land');
    run(g, 60);
    expect(g.stats.landed).toBe(1);
    expect(g.stats.goArounds).toBe(0);
    expect(g.score).toBeGreaterThan(0);
    expect(g.aircraft).toHaveLength(0);
  });

  it('refuses to land on a runway end the wind does not favour', () => {
    const g = quietGame(270);
    const end09 = g.airport.ends['09L'];
    const ac = g.spawnArrivalAt(vec(300, 455), 90, 3000, 500);
    const plan = g.commandPath(ac, [vec(end09.threshold.x - 250, end09.threshold.y)]);
    expect(plan?.kind).toBe('inactive');
    expect(ac.landingEnd).toBeNull();
  });

  it('flags a path that is too short to descend from high up', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(end.threshold.x + 450, end.threshold.y), 270, 11000, 500);
    const plan = g.planPath(ac, [vec(end.threshold.x + 300, end.threshold.y)]);
    expect(plan.kind).toBe('land');
    expect(plan.kind === 'land' && plan.tooHigh).toBe(true);
  });

  it('goes around when too high on final', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(end.threshold.x + 450, end.threshold.y), 270, 11000, 500);
    g.commandPath(ac, [vec(end.threshold.x + 300, end.threshold.y)]);
    run(g, 20);
    expect(g.stats.goArounds).toBe(1);
    expect(g.stats.landed).toBe(0);
  });
});

describe('separation', () => {
  it('treats 1000 ft of vertical spacing as separated', () => {
    const g = quietGame(270);
    g.spawnArrivalAt(vec(400, 300), 90, 5000, 500);
    g.spawnArrivalAt(vec(400, 300), 90, 6000, 500);
    run(g, 1);
    expect(g.over).toBeNull();
    expect(g.stats.separationLosses).toBe(0);
  });

  it('loses separation, then collides, at the same altitude', () => {
    const g = quietGame(270);
    g.spawnArrivalAt(vec(400, 300), 90, 5000, 500);
    g.spawnArrivalAt(vec(560, 300), 270, 5000, 500);
    run(g, 2);
    expect(g.stats.separationLosses).toBe(1);
    run(g, 5);
    expect(g.over).not.toBeNull();
  });

  it('predicts a conflict before it happens', () => {
    const g = quietGame(270);
    const a = g.spawnArrivalAt(vec(300, 300), 90, 5000, 500);
    const b = g.spawnArrivalAt(vec(900, 300), 270, 5000, 500);
    run(g, 0.1);
    expect(a.predicted && b.predicted).toBe(true);
    expect(a.conflict).toBe(false);
  });
});

describe('departures and routes', () => {
  it('takes off and scores when leaving through the right gate', () => {
    const g = quietGame(270);
    const strip = g.addStrip('W');
    expect(g.launch(strip.id, '27R')).toBe(true);
    const ac = g.aircraft[0];
    run(g, 12);
    expect(ac.phase).toBe('enroute');
    g.commandPath(ac, [vec(200, 730), vec(-20, 730)]);
    run(g, 60);
    expect(g.stats.departed).toBe(1);
    expect(g.score).toBeGreaterThan(0);
  });

  it('blocks a launch while the runway is busy', () => {
    const g = quietGame(270);
    const s1 = g.addStrip('N');
    const s2 = g.addStrip('S');
    expect(g.launch(s1.id, '27R')).toBe(true);
    expect(g.launch(s2.id, '27R')).toBe(false);
    expect(g.launch(s2.id, '27L')).toBe(true);
  });

  it('classifies routes by where they start and end', () => {
    const ap = makeAirport();
    const e27r = ap.ends['27R'];
    expect(classifyRoute(ap, [vec(1300, 200), vec(e27r.threshold.x + 200, e27r.threshold.y)])).toMatchObject({
      kind: 'arr',
      endId: '27R',
    });
    // Takeoff on 27R lifts off at the west end (09L threshold) heading west.
    expect(classifyRoute(ap, [vec(690, 455), vec(500, 455), vec(300, 700), vec(5, 730)])).toMatchObject({
      kind: 'dep',
      endId: '27R',
      gate: 'W',
    });
    expect(classifyRoute(ap, [vec(300, 200), vec(600, 200)]).kind).toBe('gen');
  });

  it('sends departures along a matching departure route automatically', () => {
    const g = quietGame(270);
    const route = g.addRoute([vec(690, 455), vec(500, 455), vec(300, 700), vec(5, 730)]);
    expect(route?.kind).toBe('dep');
    const strip = g.addStrip('W');
    g.launch(strip.id, '27R');
    run(g, 70);
    expect(g.stats.departed).toBe(1);
  });

  it('lands an arrival that joins an arrival route', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27L'];
    const route = g.addRoute([vec(1300, 800), vec(1250, 600), vec(end.threshold.x + 260, end.threshold.y)]);
    expect(route?.kind).toBe('arr');
    const ac = g.spawnArrivalAt(vec(1400, 900), 300, 4000, 500);
    expect(g.joinRoute(ac, route!)).toBe(true);
    run(g, 90);
    expect(g.stats.landed).toBe(1);
  });

  it('holds in a circle', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(400, 300), 90, 5000, 500);
    g.toggleHold(ac);
    run(g, 60);
    expect(Math.hypot(ac.pos.x - 400, ac.pos.y - 300)).toBeLessThan(200);
  });
});
