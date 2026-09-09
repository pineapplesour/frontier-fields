# 20×20 world — current user-approved direction

Owning project: this conversation's human-versus-conversational-agent FIELDLINE game. Latest instructions supersede public unexplored terrain, three civilizations, right/bottom end-turn positioning and single-occupant tiles. They do not relax match-time fair play or the no-imagegen requirement.

## Visible surface

- Fit the complete 20×20 map in the initial viewport. North/south world exterior is sea; east/west edges connect as a cylindrical world. Zoom/pan remains available for detail.
- Unexplored terrain, fertility, deposits, units, cities and facilities are not revealed. Draw uniform parchment with code-native antique cartographic ornaments unrelated to actual hidden terrain. Previously explored geography remains known, while current hidden enemies remain last-seen ghosts only.
- Preserve the current sage/teal voxel land, white restrained chrome and fixed bottom information dock. Add pale blue exterior sea and warm parchment solely for the requested geography distinction. No generated raster assets; the app-builder image-concept/asset steps are explicitly waived by the user's no-imagegen instruction. Existing screenshot `/tmp/fieldline-final-desktop.png` is a pre-change visual baseline, not an approved mockup of the new world.
- Strong national perimeter lines, lighter per-city territorial boundaries. Every inspected known tile shows nation and owning city (or unclaimed/unknown). Do not leak unseen ownership changes.
- Selecting an own unit immediately shows the current-turn reachable area from remaining MP, not only after pressing Move. Retain right-click/held-route instructions and numbered future route.
- Move End Turn into the top-right bar alongside the timer. Responsive header may use two compact rows; remove the former bottom-right action to free map space.
- Small readable health bars on visible units and cities; no fabricated current HP for ghosts. Combat reports both own and opposing unit damage. Preserve deliberately slow shot, impact, shake and casualty collapse.
- Builders visibly hammer during construction. Builder and military units may share a tile; model/label offsets and controls distinguish the two occupants.

## Rules and information boundaries

- Exactly four civilizations: human p1, assistant p2, sophisticated rule-based game NPCs p3/p4. City-state(s) and destructible, hostile auto-spawning barbarian settlements are additional factions.
- Human controls p1; conversational assistant controls p2 directly through scoped API/CLI/MCP, not a coded strategy bot. Actual competitive play has not started. No outside notes, solver, hidden server access or delegated play during a match. Built-in exploration/contact data is identical in UI and API.
- NPCs may use rule-based farming, resource development, production/counters, exploration, formation/support, recovery/supply, expansion, attacks and diplomacy, but decisions must be based on their own observation, not unseen map/unit state. Preserve meaningful neutrality/declaration rules.
- East/west wrapping applies consistently to movement, neighbors, distance, combat, vision, farm adjacency, supply, territory, routes and rendering at the seam; no north/south wrapping.
- One own builder and one own military unit may coexist. Same-class or foreign occupancy still blocks unless legal combat/capture rules apply. Production spawns on its city's compatible slot, not neighboring tiles.
- Retain immediate own-turn actions, alternating timed human/assistant phases, per-owner end-turn economy, persistent routes, charge/MP/attack limits, experience, up-to-three formations, rivers, ZOC and progressive supply penalties.

## Implementation / validation sequence

1. Preserve current 42-test baseline (`memory/checkpoints/2026-09-05-persistent-verified/`). Update shared wrapped coordinates and compatible-slot rules; test seams before changing the world.
2. Rebuild 20×20 starts and scoped exploration memory. Add fourth civilization and destructible barbarian settlements. Keep observations free of actual unknown terrain and hidden dynamic state.
3. Implement observation-only rule-based NPC turns through legal engine actions. Verify multiple rounds without exceptions, real economy/production/raiding and no hidden-state oracle.
4. Code-native ocean/parchment, national/city boundaries, full-frame camera, selectable reachable overlay, stacked occupant layout, HP/dual-damage/build motion, top-right turn control.
5. Run rules/API/MCP/render regressions and new tests for topology, exploration, shared slots, NPCs/camps. Browser desktop/mobile and actual interactions through user-mandated agent-browser MCP. Inspect screenshots against the baseline and explicit requested deviations: map fit, parchment/sea, boundaries, header action, bars/dock typography. No imagegen.

## Additive requirements incorporated during this iteration

Latest additive user requirements: unit attack strength + hover combat forecast using the actual terrain/counter/supply formula; distinct musket shots / cavalry charges / spear lunges / artillery arcs; stronger faction colors on units as well as land; population-powered wall construction and upgrades (3 levels chosen as a bounded design default), city ranged shots with visible range; entity faction allegiance; enemy-city and top-bar faction buttons open the same civilization diplomacy panel; direct top-bar diplomacy/market; all faction icons and current turn; relations include war, alliance, good, neutral, bad, denounced; declare/denounce/alliance/negotiated trade actions with consent for humans; global pause/resume restricted to human host p1. No paid model API calls or external coordination authorized.

Subsequent corrections: aggregate movement/attack into smooth external contours (white/red), with no tile-by-tile paint and no chunky neon outline. Keep readable on-map health bars for every visible unit/city. Remove coplanar unknown terrain tops causing zoom flicker. Persist camera preferences, including explicit zoom-button updates. Trade becomes bilateral card selection with money/resources/cities/units, mutual alliance and either side's third-party war participation. Globally broadcast declaration text and sound. Modal-safe top-layer notification remains closable. Mobile pause banner must not cover the range legend.

Audio QA was initially inconclusive because external prototype instrumentation counted zero. Fixed first-gesture playback to await suspended-context resume. The actual loaded sound module subsequently reported a running context and generated notes, and the suspended-context regression test passes. Settings now includes a user-facing effects test. Actual physical speaker output has not been heard or verified by the agent.

Verification evidence: 58 automated tests; actual UI trade gave two iron and received 10G; desktop hover reported the cavalry/spearman counter modifier with both damage intervals; declaration appeared above an open diplomacy dialog and its close button worked without closing the dialog; 160% zoom survived reload. Desktop 1440×1000 and mobile 390×844 had no page overflow. Temporary screenshots are listed in the project daily log. These are development checks, not a competitive match or an approved final visual reference.
