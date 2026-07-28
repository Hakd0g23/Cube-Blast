# Fracture (working title) — gray-box prototype

Throwaway empirical test harness for one question: does the shard mechanic
(Sections 2-3 of `docs/design-doc-skeleton.md`) read as tension or as
punishment? No art, no build step, no engine dependency.

## Run it (Docker)

Docker is the default dev environment — no local Node/npm/Playwright install
needed.

```
docker compose up app
```

Then open `http://localhost:8000/` in a browser. Source files (`index.html`,
`src/`, `assets/`) are bind-mounted into the container, so edits take effect
on the next browser refresh — there's no build step to rerun (this is a
static site, not a bundled app, so there's nothing for a hot-reload watcher
to recompile).

Run the test/tooling profiles with `docker compose run --rm <service>`:

- `test` — headless unit tests (`tests/core.test.mjs`)
- `drag-resize-test` — Playwright browser regression test for issue #1
- `bake-sprites` — regenerates `assets/sprites/shard-atlas.png`

`docker compose build` rebuilds the image after a `package.json` change.
Installed dependencies live in a named `node_modules` Docker volume, not on
the host.

### Run it without Docker

Browser ES modules require an HTTP origin (not `file://`). From this
directory:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in a browser. Any static file server works
equally well (`npx serve`, etc.) — nothing here is Python-specific. Running
`tests/drag-resize.playwright.mjs` or `tools/sprite-bake/bake.mjs` this way
requires `npm install` and a local Playwright browser install
(`npx playwright install chromium`).

Works with mouse (desktop) or touch (mobile browser) — both go through the
Pointer Events API, single code path for both.

## How to play

- Drag a tray piece (bottom row) onto the 8x8 grid.
- Filling a row or column clears it and scores.
- Clearing scatters 1-3 colored shards into the shard queue (top row of up to
  4 slots) — shard color matches the piece that triggered the clear.
- If the queue is full when a new shard is generated, that shard
  force-inserts directly into your active tray instead of waiting
  ("overflow escalation" — this is the mechanic's real teeth).
- No timer. Game over when nothing in the tray fits anywhere on the board.
- The log panel under the board narrates every clear/shard/overflow/refill
  event as it happens — useful for judging in the moment whether a given
  overflow felt earned or arbitrary.

## Code layout

- `src/pieces.js` — shape/color definitions (engine-agnostic data only).
- `src/core.js` — the entire ruleset: placement, line-clear detection, shard
  generation, the safety rule, queue/overflow insertion, tray refill,
  game-over check. No DOM/canvas dependency, so it runs headlessly.
- `src/main.js` — canvas rendering + Pointer Events input. Thin shell; no
  gameplay rules live here.
- `tests/core.test.mjs` — headless unit tests for `core.js`, run with
  `node tests/core.test.mjs`. Focused on the fixed resolution order, shard
  count scaling, the safety rule, and queue/overflow behavior — the parts of
  the spec most likely to silently drift under implementation convenience.

## Known implementation decisions not dictated by the design doc

See the header comment in `src/core.js` for the full list (queue cap = 4, no
player-facing rotation, shard-color source, scoring stub values, multi-shard
overflow slot preference). Flagged there rather than silently decided.
