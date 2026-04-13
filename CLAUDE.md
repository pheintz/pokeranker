This folder contains a pokemon go great league web application.

The application is supposed to do the following.

Take in a CSV with the following format through text input:

Ancestor?,Scan date,Nr,Name,Temp Evo,Gender,Nickname,Level,possibleLevels,CP,HP,Dust cost,min IV%,ØIV%,max IV%,ØATT IV,ØDEF IV,ØHP IV,Unique?,Fast move,Fast move (ID),Special move,Special move (ID),Special move 2,Special move 2 (ID),DPS,GL Evo,GL Rank (min),GL Rank (max),Box,Custom1,Custom2,Saved,Egg,Lucky?,Favorite,BuddyBoosted,Form,ShadowForm,MultiForm?,Dynamax,Height (cm),Weight (g),Height Tag,Catch Date,Catch Level
0,3/31/26 20:57:15,162,Furret,-,♀,44☪❁87D,37.5,37.5,1497,159,9000,44.4,44.4,44.4,0.0,12.0,8.0,1,Sucker Punch,98,Trailblaze,301, - , - ,15.8,Furret,134,134,Favorite,,,0,0,0,1,0,2042,1,0, - ,194,43310,0,2018-08-09,?
0,3/31/26 20:57:24,211,Qwilfish,-,♂,Qwi♂73,26.5,26.5,1493,115,4000,73.3,73.3,73.3,13.0,15.0,5.0,1, - , - , - , - , - , - ,0.0,Qwilfish,2003,2003,Favorite,,,0,0,0,1,0,1974,7,0,?,?,?,0,?,?

assume the csv headers can be taken in any order. functionality needs to search for the headers.

after the input. the great league calculator finds the max pvp power levels based on the IV inputs and the pokemon's base stats.

the application considers further evolutions of pokemon as well if it would stay under the cap.

the application considers the stats of the imported pokemon, not the level 1 stats of the pokemon imported.

the pokemon are sorted by meta sheet csv, the top meta pokemon being the most important

there needs to be a filter so that 98% or greater pokemon can only be shown


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