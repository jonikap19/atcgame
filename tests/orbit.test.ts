import { describe, expect, it } from 'vitest';
import type { Aircraft } from '../src/sim/aircraft';
import { Game } from '../src/sim/game';
import { angleDiff, headingVec, vec } from '../src/sim/geom';
import { Rng } from '../src/sim/rng';

/**
 * Flies a plane and reports the most it turned one way without unwinding,
 * while it was not told to hold. A plane circling a point it can't reach
 * keeps turning the same way forever, so this grows past 360°.
 */
function maxOneWayTurn(g: Game, ac: Aircraft, seconds: number): number {
  let net = 0;
  let worst = 0;
  let last = ac.heading;
  for (let t = 0; t < seconds; t += 1 / 30) {
    g.update(1 / 30);
    if (!g.aircraft.includes(ac) || ac.hold || ac.phase !== 'enroute') break;
    const d = angleDiff(last, ac.heading);
    last = ac.heading;
    // Reset when the turn direction reverses.
    net = Math.sign(d) === Math.sign(net) || net === 0 ? net + d : d;
    worst = Math.max(worst, Math.abs(net));
    if (ac.path.length === 0 && ac.pathEnd.type === 'none') break;
  }
  return worst;
}

function quiet(seed: number): Game {
  return new Game({ difficulty: 'normal', seed, autoSpawn: false, windDir: 270 });
}

describe('no orbiting', () => {
  it('never circles a single target point, wherever it is', () => {
    const rng = new Rng(11);
    const failures: string[] = [];
    for (let i = 0; i < 300; i++) {
      const g = quiet(i);
      const heading = rng.range(0, 360);
      const ac = g.spawnArrivalAt(vec(800, 500), heading, 6000, 900);
      ac.speed = ac.targetSpeed = rng.pick([160, 200, 250, 280]);
      // Targets all around, including inside the turn circles and just behind.
      const ang = rng.range(0, 360);
      const r = rng.range(15, 260);
      const target = vec(800 + headingVec(ang).x * r, 500 + headingVec(ang).y * r);
      ac.path = [target];
      const turn = maxOneWayTurn(g, ac, 60);
      if (turn >= 360) failures.push(`hdg ${heading.toFixed(0)} spd ${ac.speed} target bearing ${ang.toFixed(0)} dist ${r.toFixed(0)}: turned ${turn.toFixed(0)}°`);
    }
    expect(failures).toEqual([]);
  });

  it('never circles while following random hand-drawn lines', () => {
    const rng = new Rng(5);
    const failures: string[] = [];
    for (let i = 0; i < 200; i++) {
      const g = quiet(i);
      const ac = g.spawnArrivalAt(vec(800, 500), rng.range(0, 360), 6000, 900);
      // A wobbly line with sharp-ish kinks, starting at the plane, never looping.
      const stroke = [vec(800, 500)];
      let h = ac.heading + rng.range(-120, 120);
      for (let k = 0; k < 40; k++) {
        h += rng.range(-25, 25);
        if (k % 13 === 12) h += rng.pick([-100, 100]);
        const p = stroke[stroke.length - 1];
        stroke.push(vec(p.x + headingVec(h).x * 12, p.y + headingVec(h).y * 12));
      }
      g.update(rng.range(0, 3)); // the plane moves on while the line is drawn
      g.commandPath(ac, stroke);
      if (ac.hold || ac.pathEnd.type === 'hold') continue;
      const turn = maxOneWayTurn(g, ac, 60);
      if (turn >= 360) failures.push(`case ${i}: turned ${turn.toFixed(0)}°`);
    }
    expect(failures).toEqual([]);
  });

  it('never circles a route entry ring, wherever it is', () => {
    const rng = new Rng(3);
    const failures: string[] = [];
    for (let i = 0; i < 150; i++) {
      const g = quiet(i);
      const ang = rng.range(0, 360);
      const r = rng.range(30, 250);
      const start = vec(800 + headingVec(ang).x * r, 500 + headingVec(ang).y * r);
      const route = g.addRoute([start, vec(start.x + 60, start.y + 60), vec(start.x + 150, start.y + 80), vec(start.x + 250, start.y + 60)]);
      if (!route) continue;
      const ac = g.spawnArrivalAt(vec(800, 500), rng.range(0, 360), 6000, 900);
      g.joinRoute(ac, route);
      const turn = maxOneWayTurn(g, ac, 60);
      if (turn >= 360) failures.push(`case ${i}: turned ${turn.toFixed(0)}°`);
    }
    expect(failures).toEqual([]);
  });

  it('never circles after takeoff onto a departure route', () => {
    const failures: string[] = [];
    for (const [i, start] of [vec(690, 455), vec(650, 470), vec(720, 440), vec(600, 455)].entries()) {
      const g = quiet(i);
      const route = g.addRoute([start, vec(start.x - 150, start.y), vec(300, 700), vec(5, 730)]);
      if (route?.kind !== 'dep') continue;
      const strip = g.addStrip('W');
      g.launch(strip.id, '27R');
      const ac = g.aircraft[0];
      for (let t = 0; t < 15 && ac.phase === 'takeoff'; t += 1 / 30) g.update(1 / 30);
      const turn = maxOneWayTurn(g, ac, 60);
      if (turn >= 360) failures.push(`start ${start.x},${start.y}: turned ${turn.toFixed(0)}°`);
    }
    expect(failures).toEqual([]);
  });

  it('never circles on the way in to land, from any angle', () => {
    const rng = new Rng(21);
    const failures: string[] = [];
    for (let i = 0; i < 200; i++) {
      const g = quiet(i);
      const end = g.airport.ends[rng.pick(['27R', '27L'])];
      // Somewhere east of the airport, pointing anywhere, sent into the cone.
      const start = vec(rng.range(1000, 1500), rng.range(150, 850));
      const ac = g.spawnArrivalAt(start, rng.range(0, 360), 3000, 900);
      const cone = vec(end.threshold.x + rng.range(120, 300), end.threshold.y + rng.range(-15, 15));
      g.commandPath(ac, [start, vec((start.x + cone.x) / 2, (start.y + cone.y) / 2), cone]);
      let net = 0;
      let worst = 0;
      let last = ac.heading;
      for (let t = 0; t < 120 && g.aircraft.includes(ac); t += 1 / 30) {
        g.update(1 / 30);
        if (ac.phase === 'rollout' || ac.hold) break;
        const d = angleDiff(last, ac.heading);
        last = ac.heading;
        net = Math.sign(d) === Math.sign(net) || net === 0 ? net + d : d;
        worst = Math.max(worst, Math.abs(net));
      }
      if (worst >= 360) failures.push(`case ${i}: turned ${worst.toFixed(0)}°`);
    }
    expect(failures).toEqual([]);
  });
});
