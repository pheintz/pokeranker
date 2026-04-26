# Pokeranker

A browser-only Pokémon GO PvP analyzer. Paste a CalcyIV CSV export, get back keep/dust/team decisions for the current GO Battle League and Silph Arena meta.

## Primary goal

**Help the user beat the current meta with the box they actually own.**

Box analysis (the original feature) is now in service of that goal — a stepping stone, not the destination. Two things matter most:

1. **Team building from the user's box** — given what they own, surface viable 3-mon cores for the selected league/cup.
2. **Meta-busting** — surface teams (from box or from the wider dex) that counter the current top picks, with role coverage and no shared weaknesses.

## Secondary goal: box analysis

Rank each Pokémon in the imported box for the selected league. Inputs: CalcyIV CSV (headers in any order, comma or semicolon delimited, in any column order). Outputs per Pokémon:

- Optimal level under the league CP cap, computed from the user's actual IVs (not L1 stats)
- Stat-product rank vs. the theoretical best IV spread for that species
- Best evolution within the chain that stays under cap
- PvPoke overall rank for sort priority

### IV filter — clarification

The IV filter input is **stat-product percentage of rank-1 (per species)**, not in-game appraisal %. This matters because for Great/Ultra League, rank-1 PvP spreads are typically 0/15/15 (≈78% by appraisal). A user filtering by appraisal % would hide their best PvP mons. The UI tooltip already says "percentage of the theoretical #1 IV spread" — keep it that way.

For Master League only, appraisal % and stat-product % converge, so the existing input behaves correctly there.

## Input format

CalcyIV CSV export — headers searched by name, any order:

```
Ancestor?,Scan date,Nr,Name,Temp Evo,Gender,Nickname,Level,possibleLevels,CP,HP,Dust cost,min IV%,ØIV%,max IV%,ØATT IV,ØDEF IV,ØHP IV,Unique?,Fast move,Fast move (ID),Special move,Special move (ID),Special move 2,Special move 2 (ID),DPS,GL Evo,GL Rank (min),GL Rank (max),Box,Custom1,Custom2,Saved,Egg,Lucky?,Favorite,BuddyBoosted,Form,ShadowForm,MultiForm?,Dynamax,Height (cm),Weight (g),Height Tag,Catch Date,Catch Level
0,3/31/26 20:57:15,162,Furret,-,♀,44☪❁87D,37.5,37.5,1497,159,9000,44.4,44.4,44.4,0.0,12.0,8.0,1,Sucker Punch,98,Trailblaze,301, - , - ,15.8,Furret,134,134,Favorite,,,0,0,0,1,0,2042,1,0, - ,194,43310,0,2018-08-09,?
```

## Architecture (current state)

The app is split across several non-module `<script>` tags loaded in dependency order by `wwwroot/index.html`:

- `data.js` — CPM table, level constants, empty `POKEMON_STATS` / `POKEMON_TYPES` / `EVOLUTIONS` objects (populated at runtime from `data/pokemon.json`).
- `meta.js` — `FAST_MOVES`, `CHARGED_MOVES`, type chart, `typeEffectiveness`, fallback movesets.
- `battle-engine.js` — `findRank1IVs`, `getRank1Stats`, `pvpDamage`, `computeBreakpoints`, `simulateBattle`, `buildBattler`, `getCachedBattler`, `SHIELD_SCENARIOS_*`, `computeBattleRating`, `computeRoleRatings`. Self-contained PvP battle math.
- `team-builder.js` — `battleMargin`, `phiMargin`, `computeEnergyMomentum`, `classifyTeamArchetype`, `ARCHETYPE_COLORS`, `deriveDefensiveCores`, `computeAttackPrevalence`, `buildTeamsGreedy`, `scoreTeamFull`, anti-meta scoring. The shared team-quality engine used by both Meta Breaker and Box Builder.
- `app.js` — CSV parsing, league/format wiring, ranking + threat-list + role-score caches (`rankingsCache`, `roleScoresCache`, `threatListsCache`), `getBestRole`, `getThreats`, box analyzer renderer, `buildMetaBreakerTeams`, `buildBoxTeams`, UI handlers.
- `ui-enhance.js` — drop-zone, keyboard shortcuts, tab focus management.

Top-level `const`/`function` declarations are visible across scripts via the shared global lexical scope. Reference-by-name resolves at call time, so within-file ordering matters but cross-file ordering matters only for declarations that are accessed during script load.

Test harness (`test/regression.js`) loads the same scripts in order via `vm.runInContext`, then bootstraps `POKEMON_STATS`/`POKEMON_TYPES`/`POKEMON_MOVESETS`/`FAST_MOVES`/`CHARGED_MOVES` from on-disk `data/pokemon.json` + `data/moves.json` to mirror what `loadPokemon` / `loadMoves` do in the browser.

## Theory of moveset selection

Implemented in `pickOptimalMoveset` + `scoreChargedMove` + `scoreFastMove`
(`app.js`) and the charged-move AI in `simulateBattle` (`battle-engine.js`).
The math mirrors PvPoke's published formulas
([Pokemon.js](https://github.com/pvpoke/pvpoke/blob/master/src/js/pokemon/Pokemon.js))
with corrections where the algorithm needs to compensate for not running
full sims.

### Per-move scoring

**Charged moves**: `score = (damage² / energy⁴) × statChangeFactor² × 1000 + nukeBonus`

- `damage = power × stab` (1.2 if STAB, else 1.0)
- `statChangeFactor` = 1 + buff weights × chance:
  - Self atk buff: 0.5 per stage. Self def buff: 0.3 per stage.
  - Opp atk debuff: 0.7 per stage. Opp def debuff: 0.5 per stage.
  - Self-debuff sets `hasSelfDebuff` flag but does NOT compress the score
    (handled separately by primary-slot exclusion below).
  - Squared term means a guaranteed +1 atk (PuP at 100%) outranks a 30%
    +2 atk by a wide margin.
- `nukeBonus = (effDamage − 100) × 0.02` when `nrg ≥ 55 && effDamage ≥ 100`.
  This compensates for the `energy⁴` term over-favoring cheap moves —
  PvPoke's algorithm runs sim-based incremental coverage to recover the
  value of expensive nukes; without sims we approximate with a flat bonus
  scaled by raw damage. Restores Earthquake / Hyper Beam / Brave Bird as
  viable closers.

**Fast moves**: `score = (effDpt × ept⁴)^(1/5) × tempo × dpeMult`

- EPT weighted 4× harder than DPT (matches PvPoke). Penalizes a bad fast
  move only mildly when paired with a high-DPE charged move.
- `dpeMult = clamp(bestChargedDPE, 1.0, 1.5)` — the fast-move score
  scales with the paired charged move's quality, matching PvPoke's
  `Math.pow(highestDPE − 1, 1)` exponential.
- Tempo factor adjusts for turn-count quirks (1-turn moves slightly
  preferred, 4–5 turn moves slightly penalized unless dual-elite).

### Pair-selection rules

`pickOptimalMoveset` enumerates every (fast, c1, c2) combination and adds
heuristic adjustments to the per-move composite. The total composite is:

```
total = moveQuality + metaScore + tacticsScore
      − redundancyPenalty − selfDebuffPenalty − sameTypeRolePenalty
```

Where:

- **moveQuality** sums each move's individual score (was avg, which under-
  rewarded pairs vs single-charged movesets).
- **metaScore** weights fast-move RMS-effectiveness against the cup's top
  meta plus charged-move averages.
- **tacticsScore** = structureBonus + coverageBonus + pressureScore +
  incrementalCoverage.
  - **Structure bonus**: 0.3 for bait+nuke (cheapest ≤50 nrg AND costliest
    ≥55 nrg). Matches PvPoke "two moves used in 90% of matchups > two used
    in 60%."
  - **Coverage bonus**: −0.10 for mono-type movesets (everything resists
    one typing). 2-type and 3-type tied at 0 — the metaOff term already
    rewards typed effectiveness, so an explicit 3-type bonus double-counts.
  - **Incremental coverage**: cheap proxy for PvPoke's `score(move2 |
    move1) = matchups won by pair − matchups won by move1 alone`. Counts
    meta opponents where one charged move is SE and the other isn't (each
    side covers something unique). Up to ~0.10 in practice.

- **redundancyPenalty** (alternative-aware): a charged move whose type
  matches the fast move only gets penalized if a comparable-quality
  alternative of a different type exists at similar energy cost. Tolerance
  = 0.10 effDPE within ±10 energy. Talonflame's Fly is the canonical
  example — same Flying typing as Brave Bird, but no off-typed alternative
  is competitive at 45 nrg, so no penalty. Conversely Flame Charge (Fire =
  fast Fire) gets penalized because Fly is a strictly better 45 nrg
  coverage option. Bait-tier penalty 0.20, nuke-tier 0.05.

- **selfDebuffPenalty**: PvPoke excludes self-debuff moves from primary
  scoring entirely (Brave Bird, Wild Charge, Overheat, Superpower, Close
  Combat). We mirror by:
  - 0.50 if both charged moves carry self-debuff (sacrifice with no fallback)
  - 0.30 if the bait/cheaper move is a self-debuff (sacrifice in the wrong
    slot — should be the closer, not the pressure tool)
  - 0.20 for a single charged with self-debuff (no other option)
  - 0 for the canonical "non-debuff bait + self-debuff nuke" pattern
    (Talonflame Fly + Brave Bird, Pidgeot Air Cutter + Brave Bird,
    Skarmory Sky Attack + Brave Bird).

- **sameTypeRolePenalty**: two cheap (≤50 nrg) same-type moves are
  redundant baits (0.30); two expensive same-type moves are redundant
  nukes (0.20). Catches Swampert's Surf + Hydro Cannon (both Water 35–40
  nrg) which the energy⁴ formula would otherwise prefer over the
  canonical Hydro Cannon + Earthquake. Different-energy same-type pairs
  (Brave Bird + Fly) escape because they fill different roles.

### Charged-move firing AI

`pickChargedMove` in `battle-engine.js` decides what to fire per turn:

- **Bait/nuke by ENERGY** (cheaper = bait, pricier = nuke). Damage breaks
  ties only when energies match. Defining by DPE breaks against
  type-disadvantaged matchups (a high-power nuke that's resisted ends up
  with lower DPE than a cheap STAB-SE move).
- **Self-debuff moves only fire to KO** or as the absolute last option.
  When both moves are affordable and KO isn't on the table, strictly
  prefer the non-sacrifice option. Brave Bird's −3 def crash makes mid-
  fight firing a value loss.
- **Type-disadvantage override**: if "bait" out-damages "nuke" in this
  specific matchup (the pricey move is being resisted), bait is strictly
  dominant.

### Verified canonical movesets

Algorithm reproduces PvPoke's canonical GL movesets for: Talonflame
(Incinerate + Brave Bird + Fly), Swampert (Mud Shot + Hydro Cannon +
Earthquake), Lickilicky (Rollout + Hyper Beam + Body Slam), Quagsire (Mud
Shot + Earthquake + Aqua Tail), Clodsire (Mud Shot + Sludge Bomb +
Earthquake), Pidgeot (Wing Attack + Air Cutter + Brave Bird), Skarmory
(Air Slash + Brave Bird + Sky Attack), Obstagoon (Counter + Night Slash +
Hyper Beam), Wigglytuff (Charm + Hyper Beam + Swift), Registeel (Lock-On
+ Zap Cannon + Focus Blast/Flash Cannon).

## Theory of team scoring

Implemented in `team-builder.js`:

- **Asymmetric ϕ on coverage** (`phiMargin`): wins above 0.5 margin compress with `^0.75` (max bonus ~0.21 at m=1); losses are linear (max penalty 0.5 at m=0). This makes consistent 0.55-across-the-board teams beat spike `[0.7, 0.7, 0.3]` teams with the same linear average — matches PvPoke's loss-averse `TeamRanker.js` aggregation.
- **Quadratic shared-weakness penalty**: per meta opponent, count team members with blended margin < 0.45; if ≥2, add `(losers - 1)² × rankWeight × pvpokeAmp` to the threat penalty. PvPoke amplification: when the opponent's published `matchups` list (from `topMatchups` CSV column) confirms ≥2 of our team mons lose to it, multiply the penalty by 1.5 — externally verified shared weaknesses cost more than locally inferred ones.
- **5-shield blend on coverage**: each (team mon, opponent) pair simulates 0v0 / 1v1 / 2v2 / 1v0 / 0v1 and aggregates with a fixed weight set summing to 1.00.
- **Role-chain sim**: lead → safe-swap → closer with HP and energy carryover (the lead's residual HP/energy at KO becomes the safe-swap matchup's starting state).
- **Slot-fit weighting**: `buildTeamsGreedy` adds a per-slot bonus from PvPoke's published per-role scores (`leadScore` / `switchScore` / `closerScore` / `attackerScore` columns). Falls back to internal `computeRoleRatings` when CSV is older.

## Roadmap (prioritized)

Driven by the gap between "raw rank list" (what the app used to emphasize) and "what serious PvP players actually decide on" (role fit, investment cost, team coverage).

### Tier 1 — close the loop on the new primary goal ✅ done

1. ~~**Role-fit ranking per box mon.**~~ ✅ `download-csv.js` extracts `leadScore`/`switchScore`/`closerScore`/`attackerScore` from PvPoke's per-role rankings; `loadRankings` parses into `roleScoresCache`; box analyzer header shows a colored role badge with per-role tooltip; `buildTeamsGreedy` uses the scores in slot weighting.
2. ~~**Threat-coverage heatmap on team output.**~~ ✅ Two layers: (a) compact `team killers: X (2/3) · Y (2/3) · Z (3/3)` line with red "PvPoke" badge for externally-confirmed shared weaknesses, and (b) collapsible `▸ Threat matrix` per team card — colored 3-column grid (one column per team mon, rows for top 12 meta) showing the blended margin per matchup. Renderer reads `stats.matrix` from `scoreTeamFull` (computed inline with the existing 5-shield blend, no extra sims).
3. ~~**"Build teams from my box" auto-runs after Analyze.**~~ ✅ The Analyze button now runs box analysis, switches to the "Teams from my box" tab, and auto-chains `runBoxBuilder()`. The standalone "Build teams from my box" button is kept for re-running after filter changes. The "Box analysis" tab stays populated for reference.

### Tier 2 — investment guidance (the dust/candy questions)

4. **Move-unlock priority.** For each box mon, compute its rank *with* its 2nd charged move unlocked vs *without*. Surface mons where unlocking changes role or unlocks a meta-relevant team slot. Sort by stardust ROI.
5. **XL candy ROI.** Flag mons that need L41+ to hit cap. Show "marginal stat product gain per XL candy" so users can decide between "good enough at 40" and "must-XL."
6. **Shadow vs. normal per role.** Where both forms exist in the box (or are obtainable), compare them in their best role. Shadow is a closer-shaped buff, not a universal upgrade.

### Tier 3 — code health

7. ~~**Split `app.js`.**~~ ✅ Done. Extracted `battle-engine.js` (650 lines) and `team-builder.js` (657 lines); `app.js` dropped from 3848 → 2578 lines. Further splits (e.g. UI rendering, CSV parsing) deferred until needed.
8. **Regression tests for parsing + team-builder.** Current suite (39 tests) covers battle math, role/threat helpers, `phiMargin` asymmetry, and `scoreTeamFull` integration. Still missing: CSV parsing, evolution chain dedup, full team-builder pipeline (greedy + scoring + RRF). Schema drift in PvPoke CSVs would still slip through silently.
9. **PvPoke schema validation in `process/download-csv.js`.** Fail loudly on unknown columns rather than silent heuristic fallback.

### Tier 4 — nice to have

10. **Cup-aware box value.** Same box, different cup, different keepers. Show "your top 5 for each currently-running cup" on a single screen.
11. **Rank-1 SP proximity surfaced prominently** (e.g., "rank 47 / 96.4% of #1 SP") — this is the number competitive players grade keepers by.
12. **GO Battle Log usage data.** PvPoke rank ≠ ladder usage. If a usage feed is available, weight team-builder against actual ladder prevalence, not just sim score.
13. **Full 3v3 vs top-15 matrix on team cards.** Color-coded grid (green/yellow/red) per (team mon × meta threat) so users can see *why* a team is rated high or low at a glance.

## Non-goals

- Master League depth. The infrastructure is league-agnostic, but Master is a small and different problem (raid investment > IV optimization).
- Server-side anything. The app runs entirely in-browser; CSV stays on-device. Don't propose backends.
- Replacing PvPoke. Pokeranker's value-add is **"applied to your box"**, not generic ranking — link out to PvPoke for raw matchup detail rather than re-implementing it.


# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.