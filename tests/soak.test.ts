import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { headingVec } from '../src/sim/geom';

// A crude autopilot plays a long busy shift to shake out crashes and stuck states.
describe('soak', () => {
  it('survives a long busy shift with a simple autopilot', () => {
    const g = new Game({ difficulty: 'busy', seed: 7 });
    let level = 0;
    for (let step = 0; step < 30 * 600 && !g.over; step++) {
      g.update(1 / 30);
      if (step % 15 !== 0) continue;
      for (const ac of g.aircraft) {
        if (ac.kind !== 'arr' || ac.phase !== 'enroute' || ac.entering) continue;
        if (ac.path.length === 0 && ac.pathEnd.type === 'none') {
          // Stack idle arrivals at different levels and send them to the nearest active cone.
          ac.targetAlt = 3000 + (level++ % 4) * 1000;
          const end = g.activeEnds()[ac.id % 2];
          const back = headingVec(end.heading + 180);
          g.commandPath(ac, [{ x: end.threshold.x + back.x * 300, y: end.threshold.y + back.y * 300 }]);
        }
      }
      const strip = g.strips[0];
      const end = g.activeEnds().find((e) => !g.runwayBusy(e.runwayId, true));
      if (strip && end) g.launch(strip.id, end.id);
    }
    expect(g.time).toBeGreaterThan(30);
    expect(g.stats.landed + g.stats.departed + g.stats.goArounds).toBeGreaterThan(0);
  });
});
