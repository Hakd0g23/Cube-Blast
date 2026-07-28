# Fracture — Design Doc (working title, pre-production)

**Status:** RESOLVED — pressure-tested by an independent game-engineer dispatch. Locked for gray-box prototype. Any further change requires a reason surfaced in playtest, not a design-desk second-guess.
**Context:** Block Blast-style block-placement puzzle. Core differentiator: clearing a line generates "shard" debris that scatters back onto the board — converts the genre's usual externally-imposed bad luck (RNG droughts) into internally-generated, visible consequence. Precedent for the pattern: bounded negative-feedback loops in board games (Dominion curses, Clank! burden cards, Quacks of Quedlinburg cherry bombs) and Tetris Attack's garbage-block transform-on-clear — applied here to a genre (Block Blast/1010!/Woodoku) that's never had one.

## 1. Core loop (inherited from Block Blast, unchanged)
- Grid (default 8x8, TBD), drag polyomino pieces from a 3-piece tray onto the grid.
- Fill a full row/column -> it clears, scores.
- Game over when no tray piece can be placed anywhere on the board.
- No timer.

## 2. Shard generation — RESOLVED
- Trigger: any line clear (row or column).
- **Count scales sublinearly with clear size**: 1 shard for a single-line clear, 2 for a combo, capped at 3 for anything 4+ lines. (Linear scaling was rejected — it would punish exactly the flashy multi-line plays that make the genre feel good.)
- **Size capped at 1-2 cells.** Do not let this creep.
- **Color inherited from the cleared piece; shape is generic** — shards read as fragments, not copies of the original piece, while staying legibly tied to what caused them.
- **Ship-blocking safety rule (new):** a generated shard must be guaranteed placeable, or it auto-converts to score at generation time. Without this, an unplaceable shard produces an arbitrary instant game-over that reads as a bug and reintroduces the exact "screwed by RNG" complaint this mechanic exists to remove.

## 3. Placement model — RESOLVED (highest-impact call in the doc)
**Adopted: Option C — capped side-queue with overflow escalation.**
- Shards enter a side-queue (cap ~3-4), draining passively into future tray refills — not inserted directly into the active tray on generation (Option A was rejected: it stacks punishment directly on the clear's dopamine hit — MDA whiplash).
- If the queue is already at cap when a new shard is generated, that shard force-inserts into the active tray immediately (Option B alone was rejected: a pure passive drain with no real stakes makes the mechanic decorative — this overflow rule is what prices *ignoring your own debris* as a real strategic cost).
- Mirrors Tetris Attack's actual garbage-block precedent: telegraphed, sits for a beat, never instant.

**Fixed resolution order per turn (locked here so game-debugger isn't improvising it mid-build):**
1. Line clear resolves -> shards generated per Section 2 (placeability safety rule applied at generation time).
2. Shard queue insertion: if queue has room, shard sits in queue; if queue is at cap, shard force-inserts into the current active tray (overflow escalation).
3. Tray refill (triggers once the existing 3 tray pieces are all placed): queued shards drain into the new tray first, up to tray capacity, before any fresh random polyomino pieces fill remaining slots.
4. Game-over check runs last, after whichever of steps 2 or 3 most recently modified the tray — never mid-step.

## 4. Chill-mode toggle — CUT from this pass
Removed entirely, not deferred-as-a-checkbox. A real mode split is a second tuning pass plus its own onboarding surface, not a flag — and needing an escape hatch this early is diagnostic that Sections 2-3 aren't tuned right, not a feature to ship around that. If Sections 2-3 are well-tuned, mass-casual players shouldn't need an opt-out. **Revisit only if post-prototype playtest data shows a genuine bimodal audience split** — not before.

## 5. Combo-timer (Block Blast's "clear within 3 moves") — DROPPED, not retuned
Block Blast's timer exists because clearing is strictly good there. Fracture makes clearing carry a real cost (Section 2-3), so the inherited timer criminalizes the exact interesting decision the mechanic creates — holding a near-complete line for a bigger, more shard-efficient combo. Dropped outright for the prototype. Section 3's queue cap is the game's tempo mechanic now. Prototype should isolate whether the shard mechanic alone provides enough tempo pressure before ever considering a second, repointed dial (e.g. one targeting shard-queue *age* instead of move count).

## 5b. First-session exposure scripting — RESOLVED
**Problem (game-experience-designer, grounded in playtest-findings.md item 1's skill-correlation nuance):** naive/weak players die in 17-41 turns at ~0.00 queue-full-turns/game — i.e. they can lose before the shard system, the game's own stated differentiator, ever engages. In a mass-casual/ad-monetized funnel this risks most installs never experiencing the point of the game. Verdict: don't leave exposure to organic play, script it.

**Design:**
- Persisted `firstExposureComplete` flag. While false (first 1-3 games): bias early tray draws toward easy clears (standard genre convention, not novel manipulation).
- Script one guaranteed 3-4 line combo within the first ~5-8 clears — **positioned as the round's 2nd or 3rd piece, not the 1st** (redundant guard, raises the safe queue ceiling from 2/4 to 3/4 — see below).
- Suppress the next queue-drain once, to hold the queue near cap long enough for a genuine overflow-into-tray event to fire (the actual teaching moment).
- After that first overflow fires, flip the flag permanently, hand back to true RNG.

**Guard rail — verified by game-engineer against `src/core.js` directly (see playtest-findings.md item 3, sweep script `tools/playtest-sim/sim8_onboarding_scripted.mjs`):** the naive version of this script (suppress-then-fire-big-combo) reliably triggers the tray-growth-past-base-size edge case (gap #7) — different causal structure than the "essentially unreachable in natural play" finding, because the script deliberately breaks the self-canceling relationship (queue saturation normally requires *not* clearing, which also keeps it draining) that made growth unreachable before. Formula: `shardsForcedIntoTray = max(0, shardsGenerated - (QUEUE_CAP - queueLenAtComboStart))`; tray grows iff that exceeds free tray slots at combo start.
- **Verified-safe guard: queue must be <= 2/4 at the literal moment the scripted combo fires.** Gate on the literal queue level right before firing — not a heuristic like "skip suppression if queue looks near cap," since near-cap is the state the script is trying to reach.
- Queue=2/4 + a real 4-line combo still produces one genuine overflow event — the teaching moment survives the guard.
- Secondary redundant guard: scripted combo as 2nd/3rd tray piece (not 1st) raises the safe ceiling to 3/4.

**Comprehension — two non-blocking contextual callouts (game-experience-designer, copy read against actual `src/main.js` UI, "shard" confirmed as existing player-facing vocabulary):**
- On first shard generated: **"Shard saved! It'll pop back into your tray soon."** (alts: "That shard's saved here — it'll be back in your tray later." / "Shards queue up here, then rejoin your tray later.")
- On first overflow: **"Queue's full! This shard's in your tray now."** (alts: "Queue's full — this shard jumped straight into your tray." / "Overflow! Full queue pushed a shard into your tray.")
- Sentence-case, single-beat, non-blocking pulse treatment, anchored on the existing shard-queue and overflow-highlighted tray-slot UI. No blocking tutorial screen (explicitly: convention in this genre, this audience skips them). Overflow copy deliberately carries no fix-it instruction — reads as heads-up, not scold, consistent with the tension-not-punishment verdict.

**Non-blocking flag for a later visual pass (not this implementation):** the overflow tray slot currently signals only via a yellow border color — should get a non-color cue too eventually (colorblind-safety baseline). Not a blocker here. (Implemented anyway, bundled into the first build pass — see playtest-findings.md.)

**REVISION (post-launch fix, see playtest-findings.md items 4-5):** the guard rail as originally specified above (queue<=2 range, 2nd/3rd tray slot) shipped with a bug — it only actually permitted overflow for 4-line/3-shard combos, but `planOnboardingArm` was arming mostly 3-line/2-shard combos, which are mathematically incapable of ever overflowing. Fixed: the safe queue level is now an *exact* per-combo-size match, not a range; drain suppression now repeats across refills (up to a bounded max) instead of firing once; the scripted piece is dealt to **tray slot 0, not 2nd/3rd as originally specified here** (the original guidance solved a problem this implementation doesn't have, and actively hurt reliability against careless play); and a scoped safety valve auto-converts a would-be tray-growing overflow to score during any suppressed round, closing a regrowth of gap #7 that the repeating-suppression fix reintroduced. Verified: 117/300 games now see a real overflow (was 0/300), 0 tray-growth events across 2000+ re-verification games. A second, independent path into the same tray-growth bug was found and closed during implementation-ownership review (the growth safety valve now also covers an armed-but-unsuppressed round, not just a suppressed one) — see playtest-findings.md items 6, independently re-verified at 5,000 games with 0 growth events.

## 6. Monetization — PLACEHOLDER, not committed near-term intent (confirmed by user, 2026-07-25)
Carried over from the original pitch, never re-litigated on its own merits until the Section 9 platform decision needed to know whether it was binding. It isn't: explicitly placeholder scaffolding, not a locked business model. Do not let a future pass treat this section as settled intent just because it's been sitting in the doc.
- Rewarded video: "undo last shatter," extra tray slot. **Not provisioned for** under the current platform decision — no ad-mediation SDK is set up (Capacitor's ad-mediation options were evaluated and found weak; see Section 9). Would need its own scoping pass, including a real ad-mediation SDK decision, if ever pursued.
- Possible IAP: "shard magnet" power-up. Technically unblocked if/when pursued — RevenueCat's official Capacitor SDK is the intended path (Section 9) — but still "possible," not planned.
- Revisit after prototype validates the core loop — unchanged, and now also explicitly gated on the team actually deciding to pursue monetization, not just on prototype validation.

## 9. Platform/engine — RESOLVED
**Decision (2026-07-25): Capacitor-wrap the existing tested web codebase for iOS/Android distribution. No port to a dedicated engine (e.g. Godot/Unity).**

Forced by Style C (`docs/art-direction.md`) sitting gated on this exact question. Two independent specialist reads were run to pressure-test it before locking anything in:
- **web-strategist:** confirmed WebView performance risk is near-zero for this workload (`main.js`'s `draw()` is event-driven on pointer input, not a continuous 60fps loop — plain 2D canvas, no WebGL/physics). Identified IAP as the real technical risk area and recommended RevenueCat's official Capacitor SDK. Found Cordova is being closed off for IAP regardless (Google cutting Play Billing Client v7 support after 2026-08-31) — settles Cordova-vs-Capacitor on its own, independent of anything else here. App Store Guideline 4.2 (thin-wrapper rejection) judged low risk since this is a fully custom-rendered game, not a bare WebView shell. Remaining real risk: WebView gesture-routing quirks (overscroll, edge-swipe-back, safe-area) still need testing against an actual packaged Capacitor build, not just the WebKit-proxy pass already done (`device-qa-status.md`) — carried forward as an open item, not resolved by this decision.
- **game-engineer:** argued the opposite — that the genre's ads+IAP business model (cited ~63% IAP / 24% ad-revenue split as genre-standard for Block-Blast-likes) should be treated as real, and that Capacitor's weak ad-mediation story (no first-party AdMob SDK, only a community plugin with open bugs — blank rewarded-ad overlays, silent reward-callback failures) threatens the tuned "tension not punishment" feel validated by the 4,200-game playtest. Recommended porting to a dedicated engine now, using `core.js`'s 21-test suite as a ready-made behavioral spec for the port, while it's still cheap.
- **Both specialists independently converged on the same crux without being asked to:** whether this doc's Section 6 ads+IAP plan was real near-term intent or aspirational scaffolding. Neither treated that as their call to make.

**Resolved by the user, 2026-07-25: Section 6 is placeholder, not committed.** That collapses the fork onto web-strategist's branch: Capacitor + RevenueCat for IAP-only if/when IAP is ever pursued, no ad-mediation, no engine port. Keeps the existing tested codebase (21 unit tests, playtest-validated mechanic, two shipped art passes) as the actual product rather than a throwaway prototype.

**What this unblocks:** Style C (`docs/art-direction.md`) — previously gated on "no platform/engine decided." Now unblocked, since staying on canvas removes the rework risk C was gated against. **Not the same as greenlighting C** — building it is still a separate scope/investment call, same as A was before it got approved.

**What this doesn't resolve, still open:** real device-QA verification against an actual packaged Capacitor build, not just the WebKit-proxy pass — already deferred to release-manager's export/build stage per `device-qa-status.md`; unaffected by this decision except that "release-manager's export/build stage" now concretely means the Capacitor build, not a hypothetical.

## 7. Explicitly out of scope for this doc
- Visual/art direction, theming, final name (game-asset-director/naming, later).
- Onboarding copy and tutorial flow (game-experience-designer, gated on playtest results).
- Level/meta progression, if any.
- Full monetization tuning.

## 8. Next steps
- [x] game-engineer pressure-test of Sections 2-5 — done, resolutions locked above.
- [x] game-debugger: gray-box prototype (no art), built to the Section 2-3 spec and fixed resolution order above. Verified: 11/11 unit tests, 22/22 Playwright checks, independently screenshot-confirmed. Repo now lives here (was docs-only).
- [x] Playtest prototype against the core risk: does shard generation read as tension or punishment. **RESOLVED: tension, structurally guaranteed — see `docs/playtest-findings.md`** (~4,200 simulated games, zero shard-caused game-overs).
- [x] Resolve tray-growth-cap open question (gap #7 from the debugger's build report). **RESOLVED: leave uncapped** — see `docs/playtest-findings.md`.
- [x] game-experience-designer onboarding/legibility pass — done, resolved as Section 5b above.
- [x] Real device (iOS/Android touch) QA pass — WebKit-engine-proxy pass done (see `docs/device-qa-status.md`); true hardware verification formally deferred to release-manager's export/build stage, not silently dropped.
- [x] game-debugger: implement Section 5b (exposure scripting + guard rail + two callouts) against `src/core.js`/`src/main.js`, with tests covering the guard rail and flag transitions. Done — 18/18 unit tests (`node tests/core.test.mjs`), plus a real driven Playwright pass confirming the same scenario end-to-end through the DOM/localStorage/canvas path, not just core.js in isolation. Judgment calls made along the way (never fabricating board cells the player didn't place; "2nd/3rd piece" read as dealt tray-slot position, not chronological play order) are flagged in the build report, not silently decided.
