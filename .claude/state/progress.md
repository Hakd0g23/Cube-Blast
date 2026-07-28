# Project State — Cube Blast

Forked from ~/Documents/VS Code/Fracture (fresh repo, no shared git history — Fracture's GitHub repo is private, standalone project per user request). GDD: `docs/CubeWorld-GDD.md`. Source assets staged at `assets/cubeworld-source/` (Atlas.png, Blocks_PixelArt.png, assets.json).

| Workstream | Status | Stage | Artifacts | Class |
|---|---|---|---|---|
| repo-scaffold | done | delivered | ~/Documents/VS Code/Cube Blast (fresh git init, main branch), package.json renamed to cube-blast | must |
| asset-prep | not-started | scoped | GDD sec 4, 8; source: assets/cubeworld-source/{Atlas.png,Blocks_PixelArt.png,assets.json} | must |
| render-swap | not-started | scoped | GDD sec 2-4, 8-9 (textured cell rendering, fallback to flat color) | must |
| juice-pass | not-started | scoped | GDD sec 12 (squash/settle, shard arc, milestones, death sequence) | must |
| ux-loading-pass | not-started | scoped | GDD sec 13 ("Loading blocks…" state, persistent control hint) | should |
| qa-verification | not-started | scoped | GDD sec 15 success-criteria checklist | must |
| release-packaging | not-started | scoped | out of this round — deferred until qa-verification passes | out-of-scope (this round) |

## Sequencing
1. asset-prep (game-asset-director) — must land first; render-swap depends on its texture map/atlas coordinates output.
2. render-swap (game-debugger) — depends on (1).
3. juice-pass (game-debugger) — depends on (2) landing (juice effects build on the render path).
4. ux-loading-pass (game-experience-designer) — can run parallel to (3), touches loading-state copy/UI only, not the same files.
5. qa-verification (game-debugger, headless + windowed run) — after (2)(3)(4) land, checked against GDD section 15.

release-packaging intentionally deferred: not requested this round, and release-manager only activates once qa-verification is green.
