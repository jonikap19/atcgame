import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { headingVec, vec } from '../src/sim/geom';

function run(game: Game, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) game.update(dt);
}

const quiet = (windDir = 270): Game => new Game({ difficulty: 'normal', seed: 2, autoSpawn: false, windDir });

/** A path from the plane into the cone of a runway end. */
function toCone(g: Game, endId: string): { x: number; y: number }[] {
  const end = g.airport.ends[endId];
  const back = headingVec(end.heading + 180);
  return [vec(end.threshold.x + back.x * 280, end.threshold.y + back.y * 280)];
}

describe('mayday', () => {
  it('pays a bonus for landing an emergency in time', () => {
    const g = quiet();
    const ac = g.spawnArrivalAt(vec(1400, 455), 270, 3000, 500);
    g.declareEmergency(ac, 'medical');
    expect(g.notices().some((n) => n.text.includes('MAYDAY'))).toBe(true);
    g.commandPath(ac, toCone(g, '27R'));
    run(g, 60);
    expect(g.stats.emergenciesHandled).toBe(1);
    expect(g.score).toBeGreaterThanOrEqual(250);
  });

  it('costs points when the deadline passes', () => {
    const g = quiet();
    const ac = g.spawnArrivalAt(vec(300, 200), 90, 6000, 900);
    g.declareEmergency(ac, 'medical');
    g.toggleHold(ac);
    run(g, 140);
    expect(g.aircraft).not.toContain(ac);
    expect(g.score).toBeLessThanOrEqual(-150);
    expect(g.stats.emergenciesHandled).toBe(0);
  });

  it('a failed engine means no climbing and at most 200 kt', () => {
    const g = quiet();
    const ac = g.spawnArrivalAt(vec(300, 200), 90, 6000, 900);
    g.declareEmergency(ac, 'engine');
    const alt = ac.targetAlt;
    g.changeAltitude(ac, 1);
    expect(ac.targetAlt).toBe(alt);
    g.changeAltitude(ac, -1);
    expect(ac.targetAlt).toBe(alt - 1000);
    for (let i = 0; i < 10; i++) g.changeSpeed(ac, 1);
    expect(ac.targetSpeed).toBe(200);
  });

  it('a fuel emergency runs out with the deadline', () => {
    const g = quiet();
    const ac = g.spawnArrivalAt(vec(300, 200), 90, 6000, 900);
    g.declareEmergency(ac, 'fuel');
    expect(ac.fuel).toBeLessThanOrEqual(ac.emergency!.deadline - g.time + 5);
  });

  it('picks an arrival already in the air, or brings in a new one', () => {
    const g = quiet();
    const first = g.startMayday('medical');
    expect(first?.emergency?.kind).toBe('medical');
    expect(g.aircraft).toHaveLength(1);
    // Only one at a time on normal.
    expect(g.startMayday()).toBeNull();
  });
});

describe('runway closures', () => {
  it('warns, closes, cancels approaches and blocks takeoffs, then reopens', () => {
    const g = quiet();
    const ac = g.spawnArrivalAt(vec(1500, 455), 270, 3000, 900);
    g.commandPath(ac, toCone(g, '27R'));
    expect(ac.pathEnd.type).toBe('land');
    const closure = g.startClosure('N', 5)!;
    expect(g.notices().some((n) => n.text.includes('CLOSES IN'))).toBe(true);
    expect(g.canUse('27R')).toBe(true);
    run(g, 5.5);
    expect(g.isClosed('N')).toBe(true);
    expect(g.canUse('27R')).toBe(false);
    expect(g.canUse('27L')).toBe(true);
    expect(ac.pathEnd.type).toBe('none');
    expect(g.planPath(ac, toCone(g, '27R')).kind).toBe('closed');
    const strip = g.addStrip('W');
    expect(g.launch(strip.id, '27R')).toBe(false);
    expect(g.launch(strip.id, '27L')).toBe(true);
    run(g, closure.endsAt - g.time + 0.5);
    expect(g.isClosed('N')).toBe(false);
    expect(g.closures).toHaveLength(0);
  });

  it('lets a plane on short final finish landing', () => {
    const g = quiet();
    const end = g.airport.ends['27R'];
    const ac = g.spawnArrivalAt(vec(end.threshold.x + 190, end.threshold.y), 270, 1800, 900);
    ac.speed = ac.targetSpeed = 180;
    g.commandPath(ac, [vec(end.threshold.x + 150, end.threshold.y)]);
    run(g, 2.5);
    expect(ac.phase).toBe('final');
    g.startClosure('N', 0.1);
    run(g, 20);
    expect(g.stats.landed).toBe(1);
  });

  it('only one runway is ever closed at a time', () => {
    const g = quiet();
    expect(g.startClosure('N', 5)).not.toBeNull();
    expect(g.startClosure('S', 5)).toBeNull();
  });
});

describe('event schedule', () => {
  it('produces emergencies and closures, never closes both runways, never overlaps a wind shift', () => {
    let emergencies = 0;
    const closures = new Set<string>();
    for (let seed = 0; seed < 6; seed++) {
      const g = new Game({ difficulty: 'busy', seed, autoSpawn: false, events: true });
      for (let t = 0; t < 1500; t += 0.5) {
        g.update(0.5);
        for (const c of g.closures) closures.add(`${seed}:${c.startsAt}`);
        expect(g.airport.runways.filter((r) => g.isClosed(r.id)).length).toBeLessThanOrEqual(1);
        expect(g.usableEnds().length).toBeGreaterThan(0);
        if (g.closures.length) expect(g.wind.pending).toBeNull();
        // Clear the sky so the shift never ends; emergencies are counted in stats.
        g.aircraft = [];
      }
      emergencies += g.stats.emergencies;
    }
    expect(emergencies).toBeGreaterThan(5);
    expect(closures.size).toBeGreaterThan(5);
  });

  it('is quiet when events are off', () => {
    const g = quiet();
    run(g, 600, 0.5);
    expect(g.stats.emergencies).toBe(0);
    expect(g.closures).toHaveLength(0);
  });
});
