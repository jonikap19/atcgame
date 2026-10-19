import { describe, expect, it } from 'vitest';
import { stepFlight } from '../src/sim/aircraft';
import { approachCoords, gateAt, gateNear, inCone, makeAirport } from '../src/sim/airport';
import { SEP_H, SEP_V, WORLD_H, WORLD_W } from '../src/sim/constants';
import { Game } from '../src/sim/game';
import { angleDiff, dist, headingTo, vec } from '../src/sim/geom';
import { detectEndLoop, turnRadius } from '../src/sim/pathfit';
import { Rng } from '../src/sim/rng';
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

describe('drawn paths', () => {
  it('joins the line where the plane is now, not where drawing started', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(300, 200), 90, 6000, 500);
    // The player starts drawing at the plane and keeps going east, slowly.
    const stroke = [];
    for (let x = 300; x <= 1200; x += 10) stroke.push(vec(x, 200));
    run(g, 5); // plane flies ~150 units while the line is drawn
    g.commandPath(ac, stroke);
    expect(ac.path[0].x).toBeGreaterThan(ac.pos.x - 15);
    // It should carry on east instead of turning back towards x = 300.
    for (let i = 0; i < 6; i++) {
      run(g, 0.5);
      expect(Math.abs(angleDiff(ac.heading, 90))).toBeLessThan(20);
    }
  });

  it('joins a turn ahead of the plane instead of doubling back', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(400, 600), 90, 6000, 500);
    // The player draws a left turn starting at the plane...
    const stroke = [];
    for (let i = 1; i <= 10; i++) stroke.push(vec(400 + i * 10, 600));
    for (let i = 1; i <= 40; i++) stroke.push(vec(500 + Math.sin(i / 25) * 60, 600 - i * 10));
    // ...but takes 3 seconds, so the plane has flown on past the corner.
    run(g, 3);
    g.commandPath(ac, stroke);
    let lastY = ac.pos.y;
    for (let i = 0; i < 40; i++) {
      run(g, 0.25);
      // Never turns back towards where the line started...
      expect(Math.abs(angleDiff(ac.heading, 270))).toBeGreaterThan(45);
      // ...and never flies back south once it's on its way north.
      expect(ac.pos.y).toBeLessThanOrEqual(lastY + 0.5);
      lastY = ac.pos.y;
    }
    expect(ac.pos.y).toBeLessThan(350);
    // It ends up flying along the drawn line (x ≈ 540–560 here).
    expect(Math.abs(ac.pos.x - 550)).toBeLessThan(20);
  });

  it('still flies a loop drawn later in the line', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(300, 300), 90, 6000, 500);
    const stroke = [vec(300, 300), vec(500, 300), vec(500, 450), vec(320, 450), vec(320, 310), vec(700, 310)];
    g.commandPath(ac, stroke);
    // The loop's far side (x ≈ 320, y ≈ 450) is still part of the path.
    expect(ac.path.some((p) => p.x < 360 && p.y > 420)).toBe(true);
  });
});

describe('holding', () => {
  // A circle of radius r around c, starting at its west point, drawn clockwise (or not).
  function circle(c: { x: number; y: number }, r: number, clockwise: boolean, turns = 1.1): { x: number; y: number }[] {
    const pts = [];
    for (let a = 0; a <= 360 * turns; a += 10) {
      const h = 270 + (clockwise ? a : -a);
      pts.push(vec(c.x + Math.sin((h * Math.PI) / 180) * r, c.y - Math.cos((h * Math.PI) / 180) * r));
    }
    return pts;
  }

  it('recognises a circle at the end of a line', () => {
    const line = [vec(200, 300), vec(300, 300), vec(400, 300)];
    expect(detectEndLoop(line)).toBeNull();
    const loop = detectEndLoop([...line, ...circle(vec(520, 300), 120, true)]);
    expect(loop?.hold.dir).toBe(1);
    expect(dist(loop!.hold.center, vec(520, 300))).toBeLessThan(25);
    expect(loop!.hold.radius).toBeGreaterThan(90);
    expect(loop!.hold.radius).toBeLessThan(140);
    expect(detectEndLoop([...line, ...circle(vec(520, 300), 120, false)])?.hold.dir).toBe(-1);
  });

  it('does not mistake a gentle curve for a circle', () => {
    const arc = circle(vec(500, 500), 200, true, 0.5);
    expect(detectEndLoop(arc)).toBeNull();
  });

  it('flies the line, then holds on the circle drawn at its end', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(200, 300), 90, 6000, 500);
    const plan = g.commandPath(ac, [vec(200, 300), vec(300, 300), vec(400, 300), ...circle(vec(520, 300), 120, true)]);
    expect(plan?.kind).toBe('hold');
    run(g, 20);
    expect(ac.hold).not.toBeNull();
    // It keeps circling the drawn centre for a long time.
    for (let i = 0; i < 12; i++) {
      run(g, 5);
      const d = dist(ac.pos, vec(520, 300));
      expect(d).toBeGreaterThan(60);
      expect(d).toBeLessThan(180);
    }
  });

  it('circles the way the loop was drawn', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(200, 300), 90, 6000, 500);
    g.commandPath(ac, [vec(200, 300), vec(400, 300), ...circle(vec(520, 300), 120, false)]);
    run(g, 25);
    const before = ac.heading;
    run(g, 2);
    expect(angleDiff(before, ac.heading)).toBeLessThan(0);
  });

  it('widens a circle smaller than the plane can turn', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(200, 300), 90, 6000, 500);
    const plan = g.commandPath(ac, [vec(200, 300), vec(300, 300), ...circle(vec(330, 300), 30, true, 1.2)]);
    expect(plan?.kind).toBe('hold');
    expect(plan?.kind === 'hold' && plan.hold.radius).toBeGreaterThanOrEqual(turnRadius(250));
  });

  it('a new path takes the plane out of the hold', () => {
    const g = quietGame(270);
    const ac = g.spawnArrivalAt(vec(400, 300), 90, 6000, 500);
    g.toggleHold(ac);
    run(g, 10);
    expect(ac.hold).not.toBeNull();
    g.commandPath(ac, [ac.pos, vec(ac.pos.x + 200, ac.pos.y + 200), vec(900, 700)]);
    expect(ac.hold).toBeNull();
  });
});

describe('approach limits', () => {
  it('goes around when too fast on final', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(end.threshold.x + 380, end.threshold.y), 270, 3000, 500);
    ac.speed = ac.targetSpeed = 280;
    const plan = g.commandPath(ac, [vec(end.threshold.x + 320, end.threshold.y)]);
    expect(plan?.kind === 'land' && plan.tooFast).toBe(true);
    run(g, 10);
    expect(g.stats.goArounds).toBe(1);
  });

  it('does not flag a long path as too fast', () => {
    const g = quietGame(270);
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(1500, 150), 180, 3000, 500);
    ac.speed = ac.targetSpeed = 280;
    const plan = g.planPath(ac, [vec(1500, 455), vec(end.threshold.x + 300, end.threshold.y)]);
    expect(plan.kind === 'land' && plan.tooFast).toBe(false);
  });
});

describe('arrival spawns', () => {
  it('never appear near an exit gate', () => {
    for (let seed = 0; seed < 300; seed++) {
      const g = new Game({ difficulty: 'busy', seed, autoSpawn: false });
      const spot = g.findArrivalSpawn();
      expect(spot).not.toBeNull();
      expect(gateNear(g.airport, spot!.pos, 199)).toBeNull();
    }
  });

  it('never appear on a collision course with traffic already there', () => {
    const g = new Game({ difficulty: 'busy', seed: 4, autoSpawn: false, windDir: 270 });
    // Crowd the sky with planes heading for the edges at every level.
    const rng = new Rng(9);
    for (let i = 0; i < 14; i++) {
      g.spawnArrivalAt(vec(rng.range(150, 1450), rng.range(150, 850)), rng.range(0, 360), rng.pick([7000, 8000, 9000, 10000, 11000]), 900);
    }
    for (let i = 0; i < 100; i++) {
      const spot = g.findArrivalSpawn();
      if (!spot) continue;
      const fresh = g.spawnArrivalAt(spot.pos, spot.heading, spot.alt, 900);
      const others = g.aircraft.filter((a) => a !== fresh);
      const ghosts = others.map((a) => ({ ...a, pos: { ...a.pos }, path: [] }));
      const me = { ...fresh, pos: { ...fresh.pos } };
      for (let t = 0; t < 15; t++) {
        for (const o of [...ghosts, me]) stepFlight(o, 1, g.ctx);
        for (const o of ghosts) {
          expect(dist(o.pos, me.pos) >= SEP_H || Math.abs(o.alt - me.alt) >= SEP_V).toBe(true);
        }
      }
      g.aircraft = others;
    }
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
