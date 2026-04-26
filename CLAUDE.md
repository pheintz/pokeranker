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

## Roadmap (prioritized)

Driven by the gap between "raw rank list" (what the app currently emphasizes) and "what serious PvP players actually decide on" (role fit, investment cost, team coverage). Order is recommendation, not commitment — confirm priority with user before starting any item.

### Tier 1 — close the loop on the new primary goal

1. **Role-fit ranking per box mon.** PvPoke publishes Leads / Switches / Closers / Attackers ranks separately; surface all four in box analysis instead of overall rank only. Highlight the role each mon is *best at*, not just its average. (Source: PvPoke ranking JSONs already include these — extend `process/download-csv.js`.)
2. **Threat-coverage heatmap on team output.** For every suggested team, show a 3-column matrix: each team mon vs. the top ~15 meta picks (win/lose/coin-flip). Flag shared weaknesses as the dominant team-building failure mode.
3. **"Build teams from my box" defaults.** Make this the primary CTA after analysis, not a secondary button. The current default flow ends at a sorted list; it should end at a team.

### Tier 2 — investment guidance (the dust/candy questions)

4. **Move-unlock priority.** For each box mon, compute its rank *with* its 2nd charged move unlocked vs *without*. Surface mons where unlocking changes role or unlocks a meta-relevant team slot. Sort by stardust ROI.
5. **XL candy ROI.** Flag mons that need L41+ to hit cap. Show "marginal stat product gain per XL candy" so users can decide between "good enough at 40" and "must-XL."
6. **Shadow vs. normal per role.** Where both forms exist in the box (or are obtainable), compare them in their best role. Shadow is a closer-shaped buff, not a universal upgrade.

### Tier 3 — code health (do before Tier 1 if extending team-builder substantially)

7. **Split `app.js`.** ~178KB single file is fine to read, painful to extend. Split into roughly: `csv.js`, `pvp-math.js`, `battle-engine.js` (sim + breakpoints), `team-builder.js`, `ui.js`. Keep dependency direction one-way (no circular).
8. **Regression tests for parsing + team-builder.** Current tests cover battle math; CSV parsing, evolution chain dedup, and the greedy team-builder are untested. Schema drift in PvPoke CSVs or evolution data would silently break the app today.
9. **PvPoke schema validation in `process/download-csv.js`.** Fail loudly on unknown columns rather than silent heuristic fallback.

### Tier 4 — nice to have

10. **Cup-aware box value.** Same box, different cup, different keepers. Show "your top 5 for each currently-running cup" on a single screen.
11. **Rank-1 SP proximity surfaced prominently** (e.g., "rank 47 / 96.4% of #1 SP") — this is the number competitive players grade keepers by.
12. **GO Battle Log usage data.** PvPoke rank ≠ ladder usage. If a usage feed is available, weight team-builder against actual ladder prevalence, not just sim score.

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