// Tuning values for the simulation. World units are abstract map units;
// the map is WORLD_W x WORLD_H. Speeds are in knots, altitudes in feet.

export const WORLD_W = 1600;
export const WORLD_H = 1000;

/** World units travelled per second per knot of speed (game-time is accelerated). */
export const KT_TO_UPS = 0.12;

export const TURN_RATE = 20; // deg/s
export const CLIMB_RATE = 260; // ft/s
export const DESCENT_RATE = 260; // ft/s
export const FINAL_DESCENT_RATE = 320; // ft/s
export const ACCEL = 6; // kt/s

export const TAKEOFF_ACCEL = 22; // kt/s
export const ROTATE_SPEED = 150; // kt
export const ROLLOUT_DECEL = 22; // kt/s
export const FINAL_SPEED = 150; // kt

/** Landing cone: length out from the threshold and half-angle. */
export const CONE_LEN = 330;
export const CONE_HALF_ANGLE = 11; // deg
/** Altitude the glide path starts at, at the outer end of the cone. */
export const GLIDE_ENTRY_ALT = 3000;
/** How far above the glide path a plane may be before it must go around. */
export const GLIDE_TOLERANCE = 1500;
/** Highest a plane may be when it enters the landing cone. */
export const APPROACH_MAX_ALT = GLIDE_ENTRY_ALT + GLIDE_TOLERANCE;
/** Fastest a plane may be on final approach. */
export const APPROACH_MAX_SPEED = 220;

/** Separation minima. Closer than both = conflict (points drain). */
export const SEP_H = 70;
export const SEP_V = 1000;
/** Closer than both = collision (shift over). */
export const COLLIDE_H = 16;
export const COLLIDE_V = 400;

export const ALT_STEP = 1000;
export const SPD_STEP = 10;
export const ARR_ALT: [number, number] = [2000, 12000];
export const DEP_ALT: [number, number] = [3000, 15000];
export const ARR_SPD: [number, number] = [160, 280];
export const DEP_SPD: [number, number] = [180, 320];

export const DEP_INITIAL_ALT = 7000;
export const DEP_INITIAL_SPD = 250;
/** Departures should leave through their exit gate at or above this. */
export const EXIT_MIN_ALT = 5000;

export const LOW_FUEL = 60; // seconds

export const WP_RADIUS = 14;
/** New arrivals appear at least this far from any exit gate. */
export const SPAWN_GATE_CLEARANCE = 200;
export const ROUTE_ENTRY_R = 28;
export const MAX_ROUTES = 8;
export const MAX_STRIPS = 4;

/** Seconds of warning before the wind shifts and runways swap direction. */
export const WIND_WARNING = 45;

/** Fastest a plane with a failed engine can fly. */
export const ENGINE_OUT_MAX_SPEED = 200;

/** Warning before a runway closes, and how long closures last. */
export const CLOSURE_WARNING = 25;
export const CLOSURE_DURATION: [number, number] = [60, 110];

export const SCORE = {
  emergencyLanded: 150,
  emergencyFailed: -150,
  landing: 100,
  exitGood: 80,
  exitLow: 40,
  wrongExit: -40,
  leftAirspace: -60,
  goAround: -25,
  diverted: -80,
  separationPerSec: -15,
} as const;
