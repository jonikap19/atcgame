import type { Vec } from '../sim/geom';

/** A stroke the player is drawing: a path for a plane, or a new route in plan mode. */
export interface Stroke {
  kind: 'plane' | 'route';
  aircraftId: number | null;
  points: Vec[];
  start: Vec;
  moved: boolean;
}

export interface UiState {
  selectedId: number | null;
  stroke: Stroke | null;
  planMode: boolean;
  paused: boolean;
  fast: boolean;
}

export const newUiState = (): UiState => ({
  selectedId: null,
  stroke: null,
  planMode: false,
  paused: false,
  fast: false,
});
