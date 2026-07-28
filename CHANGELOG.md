# Changelog

All notable changes to Fracture will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses a simple `0.MINOR.PATCH` pre-production scheme: it's incremented
for internal/portfolio milestones, not tied to any public store release, until an
actual public launch is decided.

## [0.1.0] - 2026-07-26

First internal build cut — pre-production, not a public release.

### Added
- Gray-box prototype of the core block-placement mechanic.
- Onboarding / shard-teaching sequence introducing the game's mechanics to new players.
- Full art-direction pass across three iterations (Style B, then A, then C): colorblind-safe
  palette, glass/crystal shard visual identity, and a rendered mineral-chip sprite atlas.
- Capacitor-based Android and iOS native app shells wrapping the existing web core (no
  engine port).

### Decided
- Platform direction: ship as a Capacitor-wrapped web app on Android/iOS, with RevenueCat
  for in-app purchases if monetization is ever pursued. No ads. No engine port planned.
  Monetization itself remains a placeholder, not active in this build.

### Verified
- Android: confident QA pass on a hardware-accelerated emulator, covering touch-drag piece
  placement and orientation-change mid-drag (no crash, no stuck/duplicated piece, board
  state preserved).
- iOS: GitHub Actions CI ("iOS build" workflow) green — the iOS shell compiles and packages.
  Real-device iOS QA has not been performed yet (see known issues).

### Known issues
- iOS has not been verified on real hardware or in Simulator, only via CI compile/package
  and an earlier WebKit-engine proxy pass. Deferred, not blocking this internal cut.
- Android has not been verified on real hardware, only on a hardware-accelerated emulator.
