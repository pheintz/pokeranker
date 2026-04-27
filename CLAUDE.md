# Pokeranker

A browser-only Pokémon GO PvP analyzer **focused exclusively on 1500-CP / Great League formats**. Paste a CalcyIV CSV export, get back keep/dust/team decisions for the current Great League meta and any 1500-CP Silph Arena cup (Fantasy, Spellcraft, Bayou, Catch, Maelstrom, etc.).

**Out of scope**: Little Cup (500 CP), Ultra League (2500), Master League (10000). The data pipeline, UI, and sim are all 1500-only. Restricted *1500-CP* cups are in scope and fully supported.

## Primary goal

**Help the user beat the current meta with the box they actually own — including by finding picks that PvPoke *doesn't* recommend.**

Pokeranker isn't a PvPoke clone. PvPoke is the canonical reference and most ladder players follow it religiously. The app's anti-meta value comes from running our own simulation, finding moveset choices that genuinely beat PvPoke's recommendations in head-to-head sims, and surfacing those as actionable picks. Opponents prepare for what PvPoke recommends; the math sometimes shows a different choice wins because of that very assumption.

Three things matter most:

1. **Team building from the user's box** — given what they own, surface viable 3-mon cores for the selected league/cup.
2. **Meta-busting** — surface teams (from box or from the wider dex) that counter the current top picks, with role coverage and no shared weaknesses.
3. **Off-meta moveset picks** — sim-derived movesets that beat PvPoke's CSV-shipped recommendations in head-to-head matchups against the meta. See "Validation harness" below.

## Secondary goal: box analysis

Rank each Pokémon in the imported box for the selected league. Inputs: CalcyIV CSV (headers in any order, comma or semicolon delimited, in any column order). Outputs per Pokémon:

- Optimal level under the league CP cap, computed from the user's actual IVs (not L1 stats)
- Stat-product rank vs. the theoretical best IV spread for that species
- Best evolution within the chain that stays under cap
- PvPoke overall rank for sort priority

### IV filter — clarification

The IV filter input is **stat-product percentage of rank-1 (per species)**, not in-game appraisal %. This matters because for Great League, rank-1 PvP spreads are typically 0/15/15 (≈78% by appraisal). A user filtering by appraisal % would hide their best PvP mons. The UI tooltip already says "percentage of the theoretical #1 IV spread" — keep it that way.

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

**Authoritative path: sim-driven.** `pickOptimalMovesetSim` enumerates every
(fast, c1, c2) candidate and ranks them by simulated 1v1 performance against
the cup's top-30 meta with a 5-shield blend. Wrapped in
`pickOptimalMovesetCached` for memoization. `buildBattler` consults the
cached sim path; the static heuristic (described below) is a fallback for
species the sim can't evaluate (no valid moves, no meta, recursion).

The static-heuristic path remains in code as `pickOptimalMoveset` and is
used to bootstrap opponent battlers inside `pickOptimalMovesetSim` (so
opponent moveset selection doesn't recurse infinitely back into the sim).

### Sim-driven selection ([app.js — `pickOptimalMovesetSim`](C:/Users/lloyd/source/repos/pokeranker/wwwroot/app.js))

For each candidate (fast, c1, c2):

1. Build a temporary battler with explicit moves via `buildBattlerWithMoves`
   ([battle-engine.js](C:/Users/lloyd/source/repos/pokeranker/wwwroot/battle-engine.js)).
2. Sim against top-30 meta opponents (each pre-built with heuristic moves,
   non-cached to avoid recursion polluting `battlerCache`).
3. Per opponent: 5 shield scenarios (0v0 / 1v1 / 2v2 / 1v0 / 0v1) blended
   with weights matching `scoreTeamFull` (W_00=0.15, W_11=0.35, W_22=0.15,
   W_10=0.20, W_01=0.15). Sum to 1.00.
4. Score = weighted average margin + **incremental coverage bonus**.

**Incremental coverage** is the load-bearing piece. PvPoke's actual
selection criterion: `score(c2 | c1) = matchups won by (c1+c2) − matchups
won by c1 alone`. This is what prevents two-same-type movesets from
dominating: Swampert's Surf + Hydro Cannon wins more raw 1v1s than HC + EQ
(energy⁴ favors cheap moves), but Surf adds zero NEW wins beyond HC alone,
while EQ adds wins against Steel/Fire/Electric resistors HC can't touch.

Implementation: precompute `(fast, c1)`-only baselines, then for each pair
score `pair.avgMargin + INCREMENTAL_WEIGHT × |pair.wins ∖ baseline.wins| /
metaSize`. INCREMENTAL_WEIGHT = 1.0 means new wins count as much as a 1.0
margin against the entire meta — strong signal toward type diversity.

**Symmetric ordering**: we measure incremental wins from BOTH directions
(c2 over c1, c1 over c2) and use the minimum. Avoids penalizing pairs
where c2 happens to be the natural primary anchor.

### Performance

- Per species: ~50–80ms cold (80 candidates × 30 opps × 5 scenarios).
- Recursion guard (`_simInProgressSet`): per-species set lets nested sims
  for *different* species proceed normally; only same-species cycles fall
  back to heuristic.
- Opp battlers built via heuristic moveset (non-cached) inside the sim,
  so the recursion never reaches `battlerCache` and outer sim results
  cleanly populate the cache.
- Live analyze flow: ~5–8s end-to-end on a typical box (66 unique species
  sim-cached). Subsequent calls within the session are O(1).

### Doctrine: 2 charged moves required

The sim by default skips single-charged moveset candidates — competitive
PvP doctrine demands 2 charged moves (single-charged is mathematically
optimal in some matchups, but in real ladder play opponents always shield
your only threat). Mirrors PvPoke's algorithm. Override with
`opts.allowSingleCharged: true` for species that literally have one
charged move.

### Validation harness (sim vs PvPoke)

`test/validate-movesets.js` runs the sim against every ranked species in a league, compares each pick to PvPoke's CSV-shipped recommendation, and head-to-head sims our pick vs PvPoke's pick to measure actual matchup wins.

**Run**: `node test/validate-movesets.js [leagueKey]` (default `cp1500_all`).

**Output**: `wwwroot/data/sim-vs-pvpoke-{leagueKey}.json` — consumed by the "Off-meta picks" UI tab.

**Categories per species**:
- **agreement** — sim picks the same moveset PvPoke recommends. Confidence boost.
- **sim-superior** — disagree AND sim's pick wins head-to-head against PvPoke's pick. **These are the anti-meta findings.** Surfaced in the UI as "Anti-meta picks for top-30 meta" (high-impact actionable cases) and "Other sim-superior picks (by margin)" (curiosities).
- **pvpoke-superior** — disagree AND PvPoke's pick wins. These are genuine sim limitations or blind spots. Surfaced in the UI as "Sim-inferior cases" — diagnostic feedback for improving the sim.
- **indeterminate** — disagree but head-to-head margin is within ±0.02 (essentially a wash).

**Current cp1500_all stats (1120 species, post multi-round + bootstrap CI)**:
- **37.0% agreement** (414 species)
- **14.5% sim-superior** (162 anti-meta findings — statistically significant per CI)
- **5.8% pvpoke-superior** (65 sim limitations)
- **42.8% indeterminate** (CI crosses zero — not enough signal to distinguish)

The 2.5:1 sim-superior:pvpoke-superior ratio holds even after rigor improvements — the sim is finding ~2.5× as many statistically-robust anti-meta picks as it's missing genuine PvPoke advantages.

**Sim improvements that landed (chronological)**:

1. **Multi-seed averaging (3 seeds)** in `pickOptimalMovesetSim`. Standard Monte Carlo variance reduction (Glasserman 2003). Smooths the stochastic 75/25 bait/nuke AI noise. Manectric Shadow flipped from PvPoke-superior to sim-superior with `thunder_fang`.

2. **Fast-move effect plumbing** in `applyGamemasterMove` + `simulateBattle`. Parser populates `MOVE_EFFECTS` for fast moves; sim calls `applyMoveEffects` on fast-move completion. Currently no-op — PvPoke's gamemaster doesn't ship fast-move buff fields for any move. Dormant infrastructure for future PvPoke updates.

3. **Move-pool audit** of the 14 worst sim-inferior species: zero data gaps. All canonical moves (Frenzy Plant on Torterra, Volt Switch on Magnezone, Rage Fist on Primeape, Drill Run on Excadrill) are present in `POKEMON_MOVESETS`. The sim *has* the moves and chooses not to pick them.

4. **Multi-round convergence (fictitious play, Brown 1951)** in the validation harness. Round 1: each top-30 species's sim runs against opponents using their *heuristic* moveset. Round 1's sim picks are cached. Round 2: a full pass over all 1120 species with `oppCache=round1Cache` — opponents now use their round-1 best response. Standard zero-sum-game convergence (typically ε-converges in 2–3 rounds). Implemented via `opts.oppCache` parameter on `pickOptimalMovesetSim`.

5. **Bootstrap 95% confidence intervals (Efron 1979)** on margin diffs in head-to-head verdicts. Replaces the fixed ±0.02 threshold with proper statistical inference: a verdict requires the entire 95% CI to lie above (or below) zero. 1000 bootstrap resamples per disagreement, zero additional sim cost. Reclassified ~145 borderline verdicts to indeterminate (honest "not enough signal").

6. **Special move mechanics — confirmed non-issue.** Verified in PvPoke's gamemaster that Rage Fist, Triple Axel, Fell Stinger, etc. are all modeled as flat `+1 atk @100%` buff moves. No multi-hit or scaling-with-hits-taken mechanics in the data. PvPoke abstracts these the same way we do; the sim already handles them.

**Remaining 65 PvPoke-superior cases — characterized patterns**:
1. **Volt Switch under-picked** (~5 cases). Electrode Shadow (-0.138), Magnezone Shadow (-0.072). Sim consistently picks Spark/Metal Sound over Volt Switch. Volt Switch's 4 EPT + Electric STAB is canonically dominant; sim doesn't see it.
2. **Snarl over higher-DPT STAB fast** (~6 cases). Pangoro (-0.105), Krookodile (-0.090), Altaria Shadow (-0.069). Sim picks Snarl (3.25 EPT, no STAB) over Karate Chop / Dragon Breath (4 DPT, STAB). Higher EPT enables more charged moves; the cumulative chip damage difference doesn't surface in our sim.
3. **High-energy nuke over cheaper bait** (~6 cases). Excadrill (Earthquake over Drill Run), Pidgeot Shadow (Heat Wave over Air Cutter), Garchomp Shadow (Earth Power over Sand Tomb). Sim doesn't sufficiently reward 35–45 nrg baits paired with a closer.
4. **Specific buff moves still under-valued** (~5 cases). Cacturne Shadow misses Trailblaze, Beedrill Shadow misses Fell Stinger, Scizor Shadow misses Bullet Punch fast.

The remaining ~43 cases are similar variants of these patterns. Each requires a sim-mechanics-specific fix that probably affects multiple species.

**Deferred work**:
- **Iterate fictitious play to round 3+**: round 2 typically converges most species but a few may still oscillate. Cheap to add (~30 min) once round 2 cache is populated; would tighten the convergence further.
- **Surface CI-graded confidence in the off-meta UI** (in progress — UI now shows the CI95 range alongside the point-estimate margin).
- **Volt Switch / Snarl pattern fix**: needs deeper investigation. Likely a fast-move scoring or charged-move-firing AI tweak. Defer until empirical evidence (ladder data) confirms direction.
- **Eigenvector-style rank weighting** (Page-Brin 1998) on the meta opponents: instead of `weight = topN - rank`, use power-iteration on the matchup matrix. PvPoke's actual algorithm. Would slightly shift the meta-prevalence weighting; modest expected impact.
- **CFR for shielding mixed strategies** (Zinkevich 2007): real top players play mixed-strategy shielding; our `shouldShield` is pure-strategy. Multi-week research project; unbounded scope. Skip.

### Sim engine fidelity validation (vs PvPoke's published Battle Ratings)

`test/validate-sim-fidelity.js` answers "does our 1v1 sim engine produce the same Battle Rating PvPoke does for the same matchup with the same moveset?" — independent of moveset selection (which `validate-movesets.js` covers). Same species, same opp, same PvPoke-recommended moveset for both, three symmetric shield scenarios; pick the closest-to-PvPoke scenario; compute Δ = ourBR − pvpokeBR.

Battle Rating = `500 × (1 − opp_hp_pct) + 500 × our_hp_pct` per PvPoke's TeamRanker.js. Range 0–1000, 500 = tie.

**Run**: `node test/validate-sim-fidelity.js [leagueKey]` (default `cp1500_all`).

**Output**: `wwwroot/data/sim-fidelity-{leagueKey}.json`.

**cp1500_all results (300 matchups, top-30 species × top topMatchups+topCounters)**:

| Metric | Value |
|---|---|
| **Outcome agreement** (same winner) | **89.3%** (268/300) |
| **Match** (\|Δ\| ≤ 50 BR points) | 71.7% |
| **Close** (\|Δ\| ≤ 100 BR points) | 88.0% |
| **Diverge** (\|Δ\| > 100 BR points) | 12.0% |
| Mean abs Δ | 44 BR points |
| Mean signed Δ | +5 (no systematic bias) |

**Interpretation**: our sim is engine-faithful to PvPoke for ~88% of matchups. No type-chart bugs (Fighting × Ghost = 0.390625 in our chart, matches PoGo PvP canonical immunity-as-double-resist). Mean signed Δ = +5 means no consistent over- or under-estimation.

**Worst-divergence pattern**: Fighting attackers facing Ghost-typed defenders. Top 5 cases all involve Medicham/Annihilape/Dusclops vs Corsola Galarian/Jellicent. Counter and PuP do near-zero damage on Ghost (×0.391); the matchup hinges on the Fighting-Pokemon's *single* effective charged move (Psychic, Ice Punch) and how shield AI handles the fast-move chip stalemate. Likely cause: shield-decision behavior in our sim differs from PvPoke when one side's primary chip is heavily resisted. Not a type chart bug — type effectiveness multipliers match.

**Practical implications for anti-meta findings**:
- The 162 statistically-significant sim-superior findings are robust against this fidelity gap — most of them don't involve Fighting-vs-Ghost matchups. Top-30 anti-meta picks (Quagsire, Medicham, Tinkaton, etc.) are in the 88% close-agreement zone.
- The 65 sim-inferior cases overlap somewhat with the divergence pattern (Annihilape, Pangoro). Some "PvPoke wins" results may be artifacts of the same shield-AI difference.

### GBL ladder data integration — not feasible

`gobattlelog.com` does not expose a programmatic API. Per their published docs, ladder data flows through PvPoke (anonymized batches each season), so PvPoke's rankings already incorporate ladder signal indirectly. No additional integration possible without scraping.

### Path forward

The sim engine is **mostly faithful** to PvPoke (89% outcome agreement, 88% within ±100 BR). The 12% divergence cluster is characterized (Fighting × Ghost shield-AI edge case) and doesn't broadly affect our anti-meta findings. The next-priority improvements would be:

1. **Investigate one Medicham vs Corsola divergence end-to-end** — manual trace through `simulateBattle` to identify the specific shield-decision delta. ~2-3h. Either fix the bug or document the modeling difference.
2. **Re-run validate-movesets.js after any sim fix** — convergence + bootstrap CIs will re-evaluate every species automatically.
3. **Per-box-mon anti-meta surfacing in the UI** — when a user pastes their box, flag inline if any of their mons has a sim-superior moveset. The off-meta tab is currently league-wide; box-specific surfacing is the killer feature.

**Notable top-30 meta divergences**:
- Quagsire (#1): Drain Punch over Aqua Tail (+0.030 margin). Drain Punch's +1 def stacks while Fighting hits Steel-heavy meta SE.
- Medicham (#16): Power-Up Punch over Ice Punch (+0.064). Compounding atk buff makes every Counter hit harder.
- Drapion Shadow (#26): Fell Stinger over Aqua Tail (+0.064). Fell Stinger's KO-conditional +1 atk is hidden value.
- Annihilape (#28): Shadow Ball over Close Combat (+0.030). Avoids Close Combat's self-debuff.

### Verified canonical movesets (live flow as of last edit)

- Talonflame: `incinerate + brave_bird + fly` ✓
- Azumarill: `bubble + ice_beam + play_rough` ✓
- Medicham: `psycho_cut + dynamic_punch + power_up_punch` (sim-margin 0.92, very confident)
- Swampert: `mud_shot + hydro_cannon + muddy_water` (sim picks MW for atk-debuff incremental coverage; PvPoke prefers EQ for tournament breadth — sim is technically correct for raw 1v1)
- Tinkaton: `fairy_wind + bulldoze + gigaton_hammer` ✓ (heuristic was wrong here, sim correct)
- Quagsire: `mud_shot + stone_edge + drain_punch` ✓
- Registeel: `lock_on + flash_cannon + zap_cannon` ✓
- Mandibuzz: `snarl + aerial_ace + foul_play` ✓
- Skarmory: `air_slash + brave_bird + sky_attack` ✓
- Lickilicky: `rollout + earthquake + shadow_ball`
- Pidgeot: `wing_attack + air_cutter + heat_wave`
- Wigglytuff: `charm + icy_wind + swift` ✓
- Annihilape: `low_kick + shadow_ball + rage_fist`

### Static heuristic (fallback path)

The heuristic `pickOptimalMoveset` and per-move scorers `scoreChargedMove`
+ `scoreFastMove` remain in `app.js` to bootstrap opp battlers inside the
sim. They use:

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

- Any non-1500 CP format (Little, Ultra, Master). The data pipeline, sim, and UI are all 1500-only by design. Restricted 1500-CP cups (Fantasy, Spellcraft, Catch, etc.) ARE in scope.
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