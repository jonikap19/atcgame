# Glidepath

A browser air traffic control game. You work approach control at a fictional
airport: vector arrivals down onto the glide path, launch departures out
through their exit gates, and keep everyone separated.

It's inspired by casual radar ATC games, with the things I wanted in them:

- **Height and speed on every plane.** Each data block shows altitude (in
  hundreds of feet), speed, and where the plane is heading. Arrows show climbs,
  descents and speed changes. Planes 1000 ft apart are separated, so altitude
  is a real tool.
- **Saved routes for everything.** Draw routes in Plan mode: arrival routes
  that end in a landing cone, departure routes from a runway end (departures
  join a matching one by themselves), and general routes for anything else.
  Any plane can join a route by being dragged onto its start ring.
- **Wind shifts.** Every few minutes the wind swings round. You get a 45-second
  warning, then landings and takeoffs swap to the other end of the runways.
- **Conflict prediction.** A dashed amber ring means two planes will lose
  separation within about 20 seconds. A red ring means they already have.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Give a plane a path | Drag from the plane | |
| Clear to land | End the path inside a dashed landing cone | |
| Select a plane | Tap it or its label | Tab / Shift+Tab |
| Altitude ±1000 ft | Panel buttons, or mouse wheel over a plane | ↑ ↓ or W S |
| Speed ±10 kt | Panel buttons | → ← or D A |
| Hold (circle) | Draw a circle at the end of a path, or HOLD HERE | H |
| Join a saved route | Drag the plane onto the route's start ring | |
| Launch a departure | ▲ runway button on its strip | |
| Plan routes | PLAN ROUTES | P |
| Pause / double speed | Buttons | Space / F |

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # simulation tests
npm run build      # typecheck + single-file build in dist/index.html
npm run artifact   # build + dist/glidepath.html for publishing as a page body
```

The code is split into a pure simulation (`src/sim`, no DOM, fully testable),
the radar renderer (`src/render`), and the UI and input layer (`src/ui`).

## Roadmap

1. ~~Playable prototype~~: one airport, arrivals and departures, altitude and
   speed, routes for everything, wind shifts, collisions and scoring.
2. Emergencies and events: Mayday, runway closures, storm cells, a plane
   that stops responding, medical diversions, traffic rushes.
3. More airports, sound, polish.
