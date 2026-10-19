import type { Difficulty } from '../sim/game';
import type { Route } from '../sim/routes';

// Browser storage can be missing or blocked (private windows, embeds), so every
// access is guarded and the game works fine without it.

const ROUTES_KEY = 'glidepath.routes.v1';
const BEST_KEY = 'glidepath.best.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: nothing to do.
  }
}

export const loadRoutes = (): Route[] => {
  const routes = read<Route[]>(ROUTES_KEY, []);
  return Array.isArray(routes) ? routes.filter((r) => Array.isArray(r.points) && r.points.length > 1) : [];
};
export const saveRoutes = (routes: Route[]): void => write(ROUTES_KEY, routes);

export const loadBest = (): Partial<Record<Difficulty, number>> => read(BEST_KEY, {});
export function saveBest(difficulty: Difficulty, score: number): boolean {
  const best = loadBest();
  if (score <= (best[difficulty] ?? -Infinity)) return false;
  best[difficulty] = score;
  write(BEST_KEY, best);
  return true;
}
