// ─── Battle Engine ───────────────────────────────────────────────────────────
// Self-contained PvP battle math. Loaded after data.js and meta.js so that
// POKEMON_STATS, POKEMON_TYPES, FAST_MOVES, CHARGED_MOVES, MOVE_EFFECTS,
// CPM, and LEVELS are in scope. Loaded BEFORE app.js — buildBattler depends
// on pickOptimalMoveset (currently still in app.js), and the call resolves
// at runtime via the shared global lexical scope, so script-tag ordering
// only needs to ensure all referenced symbols exist by the time anyone
// invokes a battle-engine function.
//
// Public surface (functions/constants used by app.js / team-builder.js):
//   findRank1IVs, getRank1Stats, rank1Cache
//   pvpDamage, computeBreakpoints
//   simulateBattle, buildBattler, getCachedBattler, battlerCache
//   SHIELD_SCENARIOS_STANDARD, SHIELD_SCENARIOS_LEAD, SHIELD_SCENARIOS_SAFE, SHIELD_SCENARIOS_CLOSER
//   computeBattleRatingWithScenarios, computeBattleRating, computeRoleRatings

/**
 * Find the rank-1 (best stat product) IVs for a species at a given CP cap.
 * Returns { atkIv, defIv, staIv, level, atk, def, hp } with effective stats.
 */
function findRank1IVs(speciesId, cpCap) {
    const base = POKEMON_STATS[speciesId];
    if (!base) return null;
    const [bAtk, bDef, bSta] = base;
    const maxLevelIdx = LEVELS.length - 1;

    let bestSP = 0, bestIVs = null;
    for (let a = 0; a <= 15; a++) {
        for (let d = 0; d <= 15; d++) {
            for (let s = 0; s <= 15; s++) {
                const lvlIdx = findOptimalLevelIdx(bAtk, bDef, bSta, a, d, s, cpCap, maxLevelIdx);
                const lvl = LEVELS[lvlIdx];
                const cp = calcCp(bAtk, bDef, bSta, a, d, s, lvl);
                if (cp > cpCap) continue;
                const sp = calcStatProduct(bAtk, bDef, bSta, a, d, s, lvl, false);
                if (sp > bestSP) {
                    bestSP = sp;
                    const cpm = CPM[lvl];
                    bestIVs = {
                        atkIv: a, defIv: d, staIv: s, level: lvl,
                        atk: (bAtk + a) * cpm,
                        def: (bDef + d) * cpm,
                        hp:  Math.max(10, Math.floor((bSta + s) * cpm)),
                    };
                }
            }
        }
    }
    return bestIVs;
}

// Cache for rank-1 stats to avoid recomputation
const rank1Cache = {};
function getRank1Stats(speciesId, cpCap) {
    const key = speciesId + '|' + cpCap;
    if (!rank1Cache[key]) rank1Cache[key] = findRank1IVs(speciesId, cpCap);
    return rank1Cache[key];
}

// Niantic's internal damage bonus constant (introduced 2019).
// Stored as a 32-bit float in the game binary, so the precise value is
// 1.2999999523162841796875, but 1.3 is equivalent for integer floor math.
const PVP_BONUS = 1.3;

/**
 * Compute PvP damage for one attack.
 * Formula: floor(0.5 × power × (atk/def) × STAB × typeEff × 1.3) + 1
 * @param {number} power      Move power
 * @param {number} atkStat    Attacker's effective attack
 * @param {number} defStat    Defender's effective defense
 * @param {number} stab       1.2 if STAB, else 1.0
 * @param {number} eff        Type effectiveness multiplier
 * @returns {number} Damage dealt (minimum 1)
 */
function pvpDamage(power, atkStat, defStat, stab, eff) {
    return Math.floor(0.5 * power * (atkStat / defStat) * stab * eff * PVP_BONUS) + 1;
}

/**
 * Compute breakpoint indicators for a user's Pokémon against top meta opponents.
 *
 * A "breakpoint" occurs when the user's actual ATK stat yields fewer fast-move
 * damage per hit than the rank-1 (15/15/15) ATK stat would — meaning better IVs
 * would let them KO the opponent in fewer fast moves.
 *
 * A "bulkpoint" occurs when the user's actual DEF stat causes them to die one
 * fast move sooner than the rank-1 DEF stat would survive — meaning better IVs
 * would let them survive one more hit.
 *
 * @param {object} row      Parsed CSV row: { name, atkIv, defIv, staIv, level, shadow }
 * @param {number} cpCap
 * @param {Array}  metaEntries  Top meta entries (uses first 5)
 * @returns {Array} Array of { oppId, fastMoveId, userDmg, r1Dmg, atBreakpoint, bulkpoint }
 */
function computeBreakpoints(row, cpCap, metaEntries) {
    const baseId = normalizeId(row.name);
    const base = POKEMON_STATS[baseId];
    if (!base || !row.level || !CPM[row.level]) return [];
    const [bAtk, bDef, bSta] = base;

    // Use the GL-optimal level for the user's IVs (the highest level under the CP cap),
    // not the scan level — the scan level may be above cap, producing misleadingly large
    // stats that aren't achievable in the actual league.
    const maxLvlIdx     = LEVELS.length - 1;
    const userOptLvlIdx = findOptimalLevelIdx(bAtk, bDef, bSta, row.atkIv, row.defIv, row.staIv || 0, cpCap, maxLvlIdx);
    const userOptLevel  = LEVELS[userOptLvlIdx];
    const cpm           = CPM[userOptLevel];

    const userAtk   = (bAtk + row.atkIv) * cpm * (row.shadow ? 1.2 : 1);
    const userDef   = (bDef + row.defIv) * cpm * (row.shadow ? 5/6 : 1);
    const userHp    = Math.max(10, Math.floor((bSta + (row.staIv || 0)) * cpm));

    // Rank-1 stats at the same CP cap (using pre-computed optimal level)
    const r1 = getRank1Stats(baseId, cpCap);
    if (!r1) return [];
    const r1Atk = r1.atk * (row.shadow ? 1.2 : 1);
    const r1Def = r1.def * (row.shadow ? 5/6 : 1);

    // Determine the optimal fast move for this species vs meta
    const optimal = pickOptimalMoveset(baseId, metaEntries || []);
    const fastId = optimal ? optimal.bestFast : null;
    const fastMove = fastId ? FAST_MOVES[fastId] : null;
    if (!fastMove) return [];

    const myTypes = POKEMON_TYPES[baseId] || ['normal'];
    const stab = myTypes.includes(fastMove.type) ? 1.2 : 1.0;

    const results = [];
    for (const opp of (metaEntries || []).slice(0, 5)) {
        const oppStats = getRank1Stats(opp.id, cpCap);
        if (!oppStats) continue;

        const eff = typeEffectiveness(fastMove.type, (POKEMON_TYPES[opp.id] || ['normal'])[0],
                                      (POKEMON_TYPES[opp.id] || ['normal'])[1] || null);

        const userFastDmg = pvpDamage(fastMove.pow, userAtk, oppStats.def, stab, eff);
        const r1FastDmg   = pvpDamage(fastMove.pow, r1Atk,   oppStats.def, stab, eff);

        // Fast moves to KO (opp HP / damage per fast move)
        const userMovesToKo = Math.ceil(oppStats.hp / userFastDmg);
        const r1MovesToKo   = Math.ceil(oppStats.hp / r1FastDmg);
        const atBreakpoint  = userFastDmg < r1FastDmg;

        // Bulkpoint: how many of the opp's best fast move does user survive vs. rank-1 self?
        const oppOptimal  = pickOptimalMoveset(opp.id, metaEntries || []);
        const oppFastId   = oppOptimal ? oppOptimal.bestFast : null;
        const oppFastMove = oppFastId ? FAST_MOVES[oppFastId] : null;
        let atBulkpoint = false;
        if (oppFastMove) {
            const oppTypes  = POKEMON_TYPES[opp.id] || ['normal'];
            const oppStab   = oppTypes.includes(oppFastMove.type) ? 1.2 : 1.0;
            const oppEff    = typeEffectiveness(oppFastMove.type, myTypes[0], myTypes[1] || null);
            const oppDmgVsUser = pvpDamage(oppFastMove.pow, oppStats.atk, userDef, oppStab, oppEff);
            const oppDmgVsR1   = pvpDamage(oppFastMove.pow, oppStats.atk, r1Def,  oppStab, oppEff);
            const userSurvives = Math.floor(userHp / oppDmgVsUser);
            const r1Survives   = Math.floor(r1.hp  / oppDmgVsR1);
            atBulkpoint = userSurvives < r1Survives;
        }

        results.push({
            oppId: opp.id,
            fastMoveId: fastId,
            userDmg: userFastDmg,
            r1Dmg: r1FastDmg,
            userMovesToKo,
            r1MovesToKo,
            atBreakpoint,
            atBulkpoint,
        });
    }
    return results;
}

/**
 * Simulate a 1v1 PvP battle between two Pokemon.
 * Uses simplified but accurate Pokemon GO PvP mechanics:
 *   - Turn-based fast moves (each takes N turns)
 *   - Charged moves fire when energy is sufficient
 *   - Stochastic AI: probabilistic bait/nuke decisions (research-backed)
 *   - Shield scenario: 0, 1, or 2 shields per side
 *   - Shielded charged moves deal 1 damage
 *   - Max 500 turns to prevent infinite loops
 *
 * @param {object} a  Attacker: { speciesId, atk, def, hp, types, fast, charged1, charged2 }
 * @param {object} b  Defender: same structure
 * @param {number} shieldsA  Shields for attacker (0-2)
 * @param {number} shieldsB  Shields for defender (0-2)
 * @param {number} [seed]    Optional PRNG seed for reproducible stochastic decisions
 * @param {number} [aStartEnergy]  Carryover energy for A (0-100)
 * @param {number} [bStartEnergy]  Carryover energy for B (0-100)
 * @param {number} [aStartHpPct]   Starting HP fraction for A (0-1, default 1.0)
 * @param {number} [bStartHpPct]   Starting HP fraction for B (0-1, default 1.0)
 * @returns {{ winner: 'a'|'b'|'tie', aHpLeft: number, bHpLeft: number, aHpPct: number, bHpPct: number }}
 */
function simulateBattle(a, b, shieldsA, shieldsB, seed, aStartEnergy, bStartEnergy, aStartHpPct, bStartHpPct) {
    // ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────
    let _seed = seed != null ? seed : ((a.hp * 7919 + b.hp * 6271 + shieldsA * 31 + shieldsB) >>> 0);
    function rand() {
        _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
        let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function calcStab(moveType, userTypes) { return userTypes.includes(moveType) ? 1.2 : 1.0; }
    function calcEff(moveType, targetTypes) { return typeEffectiveness(moveType, targetTypes[0], targetTypes[1] || null); }

    // ── Stat stages ──────────────────────────────────────────────────────────
    // Tracks attack/defense stage changes from charged move effects.
    // Pokemon GO PvP formula: stage ≥ 0 → (3+stage)/3 ; stage < 0 → 3/(3-stage)
    // Capped at ±4. Effects apply even when the move is shielded (per GO PvP rules).
    let aAtkStage = 0, aDefStage = 0;
    let bAtkStage = 0, bDefStage = 0;
    function clampStage(s) { return Math.max(-4, Math.min(4, s)); }
    function stageMult(s)  { return s >= 0 ? (3 + s) / 3 : 3 / (3 - s); }

    // shielded=true → self-buffs/debuffs still apply, opponent debuffs do NOT
    // (matches GO PvP: shielding blocks debuff secondary effects)
    function applyMoveEffects(moveId, userIsA, shielded) {
        const fx = typeof MOVE_EFFECTS !== 'undefined' ? MOVE_EFFECTS[moveId] : null;
        if (!fx) return;
        if (fx.chance < 1.0 && rand() >= fx.chance) return;
        if (fx.selfBuff) {
            if (userIsA) { aAtkStage = clampStage(aAtkStage + fx.selfBuff[0]); aDefStage = clampStage(aDefStage + fx.selfBuff[1]); }
            else         { bAtkStage = clampStage(bAtkStage + fx.selfBuff[0]); bDefStage = clampStage(bDefStage + fx.selfBuff[1]); }
        }
        if (fx.selfDebuff) {
            if (userIsA) { aAtkStage = clampStage(aAtkStage + fx.selfDebuff[0]); aDefStage = clampStage(aDefStage + fx.selfDebuff[1]); }
            else         { bAtkStage = clampStage(bAtkStage + fx.selfDebuff[0]); bDefStage = clampStage(bDefStage + fx.selfDebuff[1]); }
        }
        if (fx.oppDebuff && !shielded) {
            if (userIsA) { bAtkStage = clampStage(bAtkStage + fx.oppDebuff[0]); bDefStage = clampStage(bDefStage + fx.oppDebuff[1]); }
            else         { aAtkStage = clampStage(aAtkStage + fx.oppDebuff[0]); aDefStage = clampStage(aDefStage + fx.oppDebuff[1]); }
        }
    }

    // ── Dynamic damage (recomputed each use to reflect current stat stages) ──
    function pvpDmg(pow, atkBase, atkStage, defBase, defStage, stab, eff) {
        return Math.floor(0.5 * pow * (atkBase * stageMult(atkStage)) / (defBase * stageMult(defStage)) * stab * eff * PVP_BONUS) + 1;
    }
    function aFastDmg() { return pvpDmg(a.fast.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.fast.type, a.types), calcEff(a.fast.type, b.types)); }
    function bFastDmg() { return pvpDmg(b.fast.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.fast.type, b.types), calcEff(b.fast.type, a.types)); }
    function aC1Dmg()   { return pvpDmg(a.charged1.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.charged1.type, a.types), calcEff(a.charged1.type, b.types)); }
    function aC2Dmg()   { return a.charged2 ? pvpDmg(a.charged2.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.charged2.type, a.types), calcEff(a.charged2.type, b.types)) : 0; }
    function bC1Dmg()   { return pvpDmg(b.charged1.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.charged1.type, b.types), calcEff(b.charged1.type, a.types)); }
    function bC2Dmg()   { return b.charged2 ? pvpDmg(b.charged2.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.charged2.type, b.types), calcEff(b.charged2.type, a.types)) : 0; }

    // ── Stochastic charged move AI ───────────────────────────────────────────
    // Returns { dmg, nrg, id } — damage snapshotted at decision time with current stages.
    //
    // Bait vs nuke is defined by ENERGY COST (cheaper = bait, pricier = nuke),
    // matching PvPoke's bait theory: "bait" is the shield-pressure tool you can
    // afford early, "nuke" is the heavy commitment you save up for. Defining it
    // by DPE breaks against type-disadvantaged matchups: e.g. Talonflame's
    // brave_bird (Flying, 130 pow, 55 nrg) vs Tinkaton (Steel/Fairy) is RESISTED
    // and ends up with lower DPE than flame_charge (Fire, 65 pow, 50 nrg, SE),
    // so DPE-based labeling would call brave_bird the "bait" and bait-prefer it
    // 75% of the time — which is exactly the wrong move (more energy, less damage).
    //
    // Tiebreaker on equal energy: higher raw damage is the nuke (preserves the
    // canonical labeling for moves like Counter / Mud Shot variants).
    //
    // Override: when both moves are affordable but the "nuke" deals less damage
    // than the "bait" in this matchup (type disadvantage on the high-energy move),
    // fire the bait — it's strictly dominant (cheaper AND more damage).
    //
    // Strategy: guarantee KO when possible, 75% bait when shields up, 85% nuke when shields down.
    // When only the bait is affordable but the nuke is within 20 energy, wait for the nuke.
    function pickChargedMove(energy, c1, c1Dmg, c2, c2Dmg, oppHp, oppShields) {
        const have1 = energy >= c1.nrg;
        const have2 = c2 && energy >= c2.nrg;
        if (!have1 && !have2) return null;

        // Energy-based bait/nuke. Without a c2, c1 is both.
        const c1IsNuke = !c2
            || (c1.nrg > c2.nrg)
            || (c1.nrg === c2.nrg && c1Dmg >= c2Dmg);
        const nuke = c1IsNuke ? { dmg: c1Dmg, nrg: c1.nrg, id: c1.id }
                              : { dmg: c2Dmg, nrg: c2.nrg, id: c2.id };
        const bait = c1IsNuke ? (c2 ? { dmg: c2Dmg, nrg: c2.nrg, id: c2.id } : nuke)
                              : { dmg: c1Dmg, nrg: c1.nrg, id: c1.id };
        const haveNuke = c1IsNuke ? have1 : have2;
        const haveBait = c1IsNuke ? (c2 ? have2 : have1) : have1;

        // ── Sacrifice-move detection ──
        // Self-debuff moves (Brave Bird -3 def, Wild Charge -2 def, Overheat -2
        // atk, Superpower -1 atk/-1 def) are tactical "spend the mon" finishers,
        // not pressure tools. After firing, the user takes outsized damage from
        // every subsequent fast move and effectively can't survive a follow-up.
        // Rule: only fire a self-debuff move when (a) it KOs, or (b) we have no
        // other option. This matches PvPoke's published wisdom — Talonflame's
        // Brave Bird is reserved as the closing nuke, never used for bait.
        const isSacrifice = (mv) => {
            const fx = typeof MOVE_EFFECTS !== 'undefined' ? MOVE_EFFECTS[mv.id] : null;
            if (!fx || !fx.selfDebuff) return false;
            const [a, d] = fx.selfDebuff;
            return (a < 0 || d < 0);
        };
        const nukeSacrifice = isSacrifice(nuke);
        const baitSacrifice = bait !== nuke && isSacrifice(bait);

        // Only bait affordable: fire bait to waste opponent's shield when shields are up.
        // When opponent has no shields, wait for nuke if it's close (≤20 energy away).
        // If the bait is a sacrifice move, only fire it when it would KO — otherwise
        // hold (the cost of the self-debuff is too high to spend on chip).
        if (haveBait && !haveNuke) {
            const nukeNrg = c1IsNuke ? c1.nrg : c2.nrg;
            if (oppShields === 0 && nukeNrg - energy <= 20) return null; // wait for nuke
            if (baitSacrifice && !(oppShields === 0 && bait.dmg >= oppHp)) return null; // hold sacrifice
            return bait;
        }
        // Only nuke affordable (or single-move): fire it.
        // Sacrifice nuke gets the same hold-unless-KO treatment when shields are
        // up (no point trading defense for a hit the opp will just shield).
        if (haveNuke && !haveBait) {
            if (nukeSacrifice && oppShields > 0 && nuke.dmg < oppHp) return null;
            return nuke;
        }

        // Both ready: guarantee KO when possible, then stochastic bait/nuke.
        if (oppShields === 0 && nuke.dmg >= oppHp) return nuke;
        if (oppShields === 0 && bait.dmg >= oppHp) return bait;
        // Type-disadvantage override: if "bait" out-damages "nuke" in this
        // specific matchup (the pricey move is being resisted), the bait is
        // strictly dominant — never fire the nuke.
        if (bait.dmg > nuke.dmg) return bait;
        // Sacrifice-aware selection: prefer the non-sacrifice option whenever
        // both can fire and we're not closing for KO. The sacrifice is reserved
        // for the moment its damage actually finishes the opponent.
        if (nukeSacrifice && !baitSacrifice) return bait;
        if (baitSacrifice && !nukeSacrifice) return nuke;
        return oppShields > 0 ? (rand() < 0.75 ? bait : nuke)
                              : (rand() < 0.85 ? nuke : bait);
    }

    // HP carryover: start fraction ≤ 1.0 allows the chain sim to represent
    // a Pokemon entering after a prior KO'd teammate while the opponent
    // retains residual HP (rather than magically healing back to full).
    const aHpPctStart = (aStartHpPct == null || aStartHpPct > 1) ? 1 : Math.max(0, aStartHpPct);
    const bHpPctStart = (bStartHpPct == null || bStartHpPct > 1) ? 1 : Math.max(0, bStartHpPct);
    const aMaxHp = Math.max(1, a.hp);
    const bMaxHp = Math.max(1, b.hp);
    let aHp = Math.max(1, Math.round(aMaxHp * aHpPctStart));
    let bHp = Math.max(1, Math.round(bMaxHp * bHpPctStart));
    let aEnergy = Math.min(100, Math.max(0, aStartEnergy || 0));
    let bEnergy = Math.min(100, Math.max(0, bStartEnergy || 0));
    let aShields = shieldsA, bShields = shieldsB;
    let aTurnCd = 0, bTurnCd = 0;
    // Shared charged-move lockout: after any charged move fires, both sides
    // lose one turn of charged-move action (animation lock). Fast moves
    // already in progress still complete. Matches PvPoke's chargedMoveLockOut.
    let chargedLockout = 0;

    // PvPoke-style shield AI: defender shields if the incoming charged move
    //   (a) would KO them, OR
    //   (b) deals ≥35% of defender's max HP, OR
    //   (c) the attacker's OTHER charged move hits this defender HARDER
    //       (i.e. the current hit is likely a bait to burn shields for the nuke).
    // Returns true → shield the move; false → eat it.
    function shouldShield(incomingDmg, defHp, defMaxHp, otherChargedDmg) {
        if (incomingDmg <= 0) return false;
        if (incomingDmg >= defHp) return true;                 // lethal
        if (incomingDmg >= 0.35 * defMaxHp) return true;       // significant
        if (otherChargedDmg != null && otherChargedDmg > incomingDmg) return true; // bait-aware
        return false;
    }

    for (let turn = 0; turn < 500; turn++) {
        if (aHp <= 0 || bHp <= 0) break;

        // Charged-move lockout: during the lockout turn, neither side picks
        // a charged move, but fast-move countdowns/completions still tick.
        const locked = chargedLockout > 0;
        if (chargedLockout > 0) chargedLockout--;

        // ── Charged move phase ───────────────────────────────────────────────
        // Both sides decide independently; if both fire on the same turn,
        // CMP (Charge Move Priority) resolves by ATK stat — higher goes first.
        const aPick = (!locked && aTurnCd === 0)
            ? pickChargedMove(aEnergy, a.charged1, aC1Dmg(), a.charged2, aC2Dmg(), bHp, bShields)
            : null;
        const bPick = (!locked && bTurnCd === 0)
            ? pickChargedMove(bEnergy, b.charged1, bC1Dmg(), b.charged2, bC2Dmg(), aHp, aShields)
            : null;

        // CMP: when both fire simultaneously, higher-ATK Pokémon resolves first.
        // Ties broken deterministically (a wins, matching PvPoke default).
        const aFirst = !bPick || (aPick && a.atk >= b.atk);

        // Damage is recomputed at fire time (not reused from the pre-turn
        // snapshot in aPick/bPick) so that when two charged moves resolve
        // in the same turn, the second fire reflects any stat-stage changes
        // applied by the first (e.g. Acid Spray debuffing DEF → next same-
        // turn charged move hits harder; Power-Up Punch buffing ATK does
        // NOT benefit the triggering move, matching PoGo PvP semantics
        // because stage updates are applied inside fire* after the damage
        // value is already captured).
        const fireA = () => {
            if (!aPick) return;
            aEnergy -= aPick.nrg;
            const dmg = (aPick.id === a.charged1.id) ? aC1Dmg() : aC2Dmg();
            // Smart defender: shield only if the incoming hit meets the
            // PvPoke-style threshold. Compute B's "other charged move" damage
            // dealt TO B (i.e. damage A would deal with the other move) so
            // the defender can anticipate a bigger nuke and save shields.
            let shielded = false;
            if (bShields > 0) {
                const otherDmg = (aPick.id === a.charged1.id)
                    ? (a.charged2 ? aC2Dmg() : null)
                    : aC1Dmg();
                shielded = shouldShield(dmg, bHp, bMaxHp, otherDmg);
            }
            applyMoveEffects(aPick.id, true, shielded);
            if (shielded) { bShields--; bHp -= 1; }
            else          { bHp -= dmg; }
        };
        const fireB = () => {
            if (!bPick) return;
            bEnergy -= bPick.nrg;
            const dmg = (bPick.id === b.charged1.id) ? bC1Dmg() : bC2Dmg();
            let shielded = false;
            if (aShields > 0) {
                const otherDmg = (bPick.id === b.charged1.id)
                    ? (b.charged2 ? bC2Dmg() : null)
                    : bC1Dmg();
                shielded = shouldShield(dmg, aHp, aMaxHp, otherDmg);
            }
            applyMoveEffects(bPick.id, false, shielded);
            if (shielded) { aShields--; aHp -= 1; }
            else          { aHp -= dmg; }
        };

        if (aFirst) { fireA(); if (aHp > 0 && bHp > 0) fireB(); }
        else        { fireB(); if (aHp > 0 && bHp > 0) fireA(); }

        // If either side fired a charged move, lock out charged moves for
        // the next turn on both sides (animation freeze).
        if (aPick || bPick) chargedLockout = 1;

        // If neither fired a charged move, use a fast move instead
        if (!aPick && aTurnCd === 0) aTurnCd = a.fast.turns;
        if (!bPick && bTurnCd === 0) bTurnCd = b.fast.turns;

        // ── Fast move completions ────────────────────────────────────────────
        // A Pokemon KO'd by a charged move earlier this turn does not get to
        // complete an in-progress fast move — gate on hp > 0 so leftover fast
        // damage doesn't skew aHpPct/bHpPct (and therefore battleMargin).
        if (aTurnCd > 0 && aHp > 0) {
            aTurnCd--;
            if (aTurnCd === 0) {
                bHp -= aFastDmg();
                aEnergy = Math.min(100, aEnergy + a.fast.nrg);
            }
        }
        if (bTurnCd > 0 && bHp > 0) {
            bTurnCd--;
            if (bTurnCd === 0) {
                aHp -= bFastDmg();
                bEnergy = Math.min(100, bEnergy + b.fast.nrg);
            }
        }
    }

    aHp = Math.max(0, aHp);
    bHp = Math.max(0, bHp);
    const winner = aHp > bHp ? 'a' : bHp > aHp ? 'b' : 'tie';
    // Return final energy so the chain sim can propagate opp residual energy
    // (Tier-6): when the lead loses, opp0 doesn't reset to 0 energy on the
    // next matchup — they've been accumulating fast-move energy all fight.
    return {
        winner,
        aHpLeft: aHp, bHpLeft: bHp,
        aHpPct: aHp / Math.max(1, a.hp), bHpPct: bHp / Math.max(1, b.hp),
        aEnergy, bEnergy
    };
}

/**
 * Build a battle-ready Pokemon object for the simulator from a speciesId.
 * Uses rank-1 IVs at the given CP cap and optimal moveset vs meta.
 *
 * Shadow Pokémon receive the GO PvP shadow multipliers:
 *   ATK × 1.2   (6/5)
 *   DEF × 0.833 (5/6)
 * HP (stamina) is unaffected by shadow status.
 *
 * Pass speciesId with "_shadow" suffix OR set isShadow = true.
 *
 * @param {string}  speciesId  Internal ID (may carry _shadow suffix)
 * @param {number}  cpCap
 * @param {Array}   metaEntries
 * @param {boolean} [isShadow] Override / supplement ID-detected shadow flag
 * @returns {object|null} { speciesId, atk, def, hp, types, fast, charged1, charged2, isShadow }
 */
function buildBattler(speciesId, cpCap, metaEntries, isShadow) {
    const { baseId, isShadow: detectedShadow } = parseShadowId(speciesId);
    const shadow = !!(isShadow || detectedShadow);

    const stats = getRank1Stats(baseId, cpCap);
    if (!stats) return null;

    const types = POKEMON_TYPES[baseId] || ['normal'];
    // Prefer the sim-driven cached selection (pickOptimalMovesetCached), which
    // enumerates every (fast, c1, c2) candidate, sims each against the cup's
    // top-30 meta with a 5-shield blend, and picks the moveset that maximizes
    // weighted matchup margin + incremental coverage. Falls through to the
    // heuristic pickOptimalMoveset (which is what the cached wrapper does
    // internally) if sim returns null.
    //
    // Cross-file: pickOptimalMovesetCached lives in app.js. By the time any
    // buildBattler call fires from the UI, all scripts have loaded and the
    // global is resolvable. If somebody calls buildBattler before app.js
    // (impossible in normal flow), fall back to the heuristic.
    const pickFn = (typeof pickOptimalMovesetCached === 'function')
        ? pickOptimalMovesetCached
        : (sid, _cap, meta) => pickOptimalMoveset(sid, meta);
    const optimal = pickFn(baseId, cpCap, metaEntries || null);

    // Need at least a fast move and one charged move
    let fast, charged1, charged2;
    if (optimal) {
        fast = FAST_MOVES[optimal.bestFast];
        charged1 = CHARGED_MOVES[optimal.charged1];
        charged2 = optimal.charged2 ? CHARGED_MOVES[optimal.charged2] : null;
        if (fast) fast = { ...fast, id: optimal.bestFast };
        if (charged1) charged1 = { ...charged1, id: optimal.charged1 };
        if (charged2) charged2 = { ...charged2, id: optimal.charged2 };
    }

    // Fallback: use first available moves from moveset
    if (!fast || !charged1) {
        const moveset = typeof POKEMON_MOVESETS !== 'undefined' ? POKEMON_MOVESETS[speciesId] : null;
        if (!moveset) return null;
        if (!fast && moveset.fast && moveset.fast[0]) {
            const fid = moveset.fast[0];
            fast = FAST_MOVES[fid] ? { ...FAST_MOVES[fid], id: fid } : null;
        }
        if (!charged1 && moveset.charged && moveset.charged[0]) {
            const cid = moveset.charged[0];
            charged1 = CHARGED_MOVES[cid] ? { ...CHARGED_MOVES[cid], id: cid } : null;
        }
    }

    if (!fast || !charged1) return null;

    // Apply shadow multipliers AFTER rank-1 stats are resolved.
    // Shadow: ATK × 1.2 (6/5), DEF × 5/6.  HP (stamina) is unaffected.
    const atkStat = shadow ? stats.atk * (6 / 5) : stats.atk;
    const defStat = shadow ? stats.def * (5 / 6) : stats.def;

    return {
        speciesId: baseId, types,
        atk: atkStat, def: defStat, hp: stats.hp,
        fast, charged1, charged2,
        isShadow: shadow,
    };
}

// Cache for battler objects (keyed by speciesId|cpCap[|shadow])
const battlerCache = {};
function getCachedBattler(speciesId, cpCap, metaEntries, isShadow) {
    const { baseId, isShadow: detectedShadow } = parseShadowId(speciesId);
    const shadow = !!(isShadow || detectedShadow);
    const key = baseId + '|' + cpCap + (shadow ? '|shadow' : '');
    if (!battlerCache[key]) battlerCache[key] = buildBattler(baseId, cpCap, metaEntries, shadow);
    return battlerCache[key];
}

/**
 * Build a battler with explicit moves (bypassing pickOptimalMoveset).
 * Used by `pickOptimalMovesetSim` to enumerate every (fast, c1, c2) combo
 * and pick the winner via simulation. Stats use rank-1 IVs at the cap.
 *
 * c2Id may be null for single-charged-move evaluation (the precondition for
 * "incremental coverage of c2 = wins(c1+c2) − wins(c1 alone)" measurement).
 *
 * @param {string}  speciesId  May carry _shadow suffix
 * @param {number}  cpCap
 * @param {string}  fastId     Fast-move ID (already lowercase / snake_case)
 * @param {string}  c1Id       Primary charged-move ID
 * @param {string|null} c2Id   Secondary charged-move ID, or null
 * @param {boolean} [isShadow] Override / supplement ID-detected shadow flag
 * @returns {object|null} Battler shape used by simulateBattle, or null if any
 *                        move ID is unknown / stats missing.
 */
function buildBattlerWithMoves(speciesId, cpCap, fastId, c1Id, c2Id, isShadow) {
    const { baseId, isShadow: detectedShadow } = parseShadowId(speciesId);
    const shadow = !!(isShadow || detectedShadow);
    const stats = getRank1Stats(baseId, cpCap);
    if (!stats) return null;

    const fastBase = FAST_MOVES[fastId];
    const c1Base   = CHARGED_MOVES[c1Id];
    const c2Base   = c2Id ? CHARGED_MOVES[c2Id] : null;
    if (!fastBase || !c1Base) return null;
    if (c2Id && !c2Base) return null;

    const types = POKEMON_TYPES[baseId] || ['normal'];
    const fast    = { ...fastBase, id: fastId };
    const charged1 = { ...c1Base, id: c1Id };
    const charged2 = c2Base ? { ...c2Base, id: c2Id } : null;

    const atk = shadow ? stats.atk * (6/5) : stats.atk;
    const def = shadow ? stats.def * (5/6) : stats.def;

    return {
        speciesId: baseId, types,
        atk, def, hp: stats.hp,
        fast, charged1, charged2,
        isShadow: shadow,
    };
}

// ─── Shield scenario presets ──────────────────────────────────────────────────
// All weights in a set must sum to 1.0.
//
// STANDARD: reflects realistic distribution of all in-game states (including
// asymmetric shield counts), derived from GO Battle League shield usage data.
const SHIELD_SCENARIOS_STANDARD = [
    { sA: 0, sB: 0, weight: 0.12 },   // both shields burned (end-game)
    { sA: 1, sB: 1, weight: 0.32 },   // classic mid-game (most common)
    { sA: 2, sB: 2, weight: 0.08 },   // full shields opening
    { sA: 1, sB: 0, weight: 0.22 },   // attacker shield-up (winning position)
    { sA: 0, sB: 1, weight: 0.13 },   // attacker shield-down (comeback)
    { sA: 2, sB: 1, weight: 0.08 },   // attacker dominant 2v1
    { sA: 1, sB: 2, weight: 0.05 },   // attacker on back foot 1v2
];  // Σ = 1.00

// LEAD: full shields opening; good leads can also operate under pressure.
const SHIELD_SCENARIOS_LEAD = [
    { sA: 2, sB: 2, weight: 0.55 },   // primary lead state: both full shields
    { sA: 2, sB: 1, weight: 0.25 },   // lead pressured opponent into burning a shield
    { sA: 1, sB: 2, weight: 0.20 },   // lead walked into a bad matchup, down a shield
];  // Σ = 1.00

// SAFE_SWAP: enters mid-game; rarely has 2 shields; needs 1v1 performance.
const SHIELD_SCENARIOS_SAFE = [
    { sA: 1, sB: 1, weight: 0.50 },   // balanced mid-game
    { sA: 1, sB: 0, weight: 0.25 },   // safe-swap comes in with shield advantage
    { sA: 0, sB: 1, weight: 0.15 },   // entered after shields traded
    { sA: 0, sB: 0, weight: 0.10 },   // both burned
];  // Σ = 1.00

// CLOSER: enters last; shields almost always gone; pure damage matters.
const SHIELD_SCENARIOS_CLOSER = [
    { sA: 0, sB: 0, weight: 0.65 },   // classic closer: pure damage, no shields
    { sA: 1, sB: 0, weight: 0.25 },   // closer has a saved shield, opp doesn't
    { sA: 0, sB: 1, weight: 0.10 },   // opponent saved a shield for the closer
];  // Σ = 1.00

/**
 * Core battle-rating engine. Simulates 1v1s vs. top N meta opponents using
 * the given shield-scenario set.  Handles shadow variants transparently via
 * parseShadowId(): pass "galvantula_shadow" or set isShadow = true.
 *
 * @param {string}  speciesId   Internal species ID (may carry _shadow suffix)
 * @param {number}  cpCap
 * @param {Array}   metaEntries  Array of { id, types, weight }
 * @param {Array}   scenarios    Array of { sA, sB, weight } — weights must sum to 1
 * @param {number}  [topN=50]    How many meta opponents to battle
 * @param {boolean} [isShadow]   Override shadow flag (merged with ID-detected shadow)
 * @returns {{ battleRating, wins, losses, ties, total }|null}
 */
function computeBattleRatingWithScenarios(speciesId, cpCap, metaEntries, scenarios, topN, isShadow) {
    topN = topN || 80;

    const attacker = getCachedBattler(speciesId, cpCap, metaEntries, isShadow);
    if (!attacker) return null;

    const opponents = metaEntries.slice(0, topN);
    let totalScore = 0, totalWeight = 0, wins = 0, losses = 0, ties = 0, simCount = 0;

    // Rank-weighted scoring: each opponent's matchup contribution is scaled
    // by its meta weight (metaEntries are ordered by PvPoke meta rank, with
    // weight = metaIds.length - rankIndex → #1 opponent weighs most). This
    // lets us safely widen the pool (top-80 instead of top-50) to catch
    // fringe-meta coverage without fringe picks diluting the signal.
    // Fallback to uniform weighting if metaEntries lack a weight field.
    const { baseId: atkBaseId, isShadow: atkShadowFromId } = parseShadowId(speciesId);
    const atkIsShadow = !!(isShadow || atkShadowFromId);

    for (let i = 0; i < opponents.length; i++) {
        const opp = opponents[i];
        // Skip true mirrors only (same base ID AND same shadow status).
        // Shadow-vs-non-shadow of the same species IS a valid matchup.
        // Derive opp shadow status from the ID suffix — metaEntries don't
        // carry an explicit .isShadow field, so relying on opp.isShadow
        // was skipping shadow-vs-non-shadow mirrors unintentionally.
        const { baseId: oppBaseId, isShadow: oppIsShadow } = parseShadowId(opp.id);
        if (oppBaseId === atkBaseId && atkIsShadow === oppIsShadow) continue;

        const defender = getCachedBattler(opp.id, cpCap, metaEntries, false);
        if (!defender) continue;

        simCount++;
        // Weight: prefer explicit .weight from metaEntries; otherwise synthesise
        // a rank-based weight that decays gently so the top 20 dominate but the
        // bottom of the pool still contributes (prevents deep-meta noise from
        // drowning out core matchups).
        const w = (typeof opp.weight === 'number' && opp.weight > 0)
            ? opp.weight
            : 1 / Math.log2(i + 2); // i=0 → 1.0, i=19 → 0.33, i=79 → 0.158
        let matchupScore = 0;

        // Multi-seed averaging: the battle sim has stochastic bait/nuke
        // decisions and stat-effect procs (gated on rand() < chance). A
        // single seed can land on an unrepresentative extreme. Averaging
        // over a few deterministic seeds smooths that noise without adding
        // meaningful cost (3 seeds × N scenarios, still O(1) per matchup).
        const SEEDS = [17, 101, 257];
        for (const sc of scenarios) {
            let avgMargin = 0;
            for (const seed of SEEDS) {
                avgMargin += battleMargin(simulateBattle(attacker, defender, sc.sA, sc.sB, seed));
            }
            avgMargin /= SEEDS.length;
            matchupScore += avgMargin * sc.weight;
        }

        totalScore  += matchupScore * w;
        totalWeight += w;
        // Win/loss/tie tallies are unweighted counts — useful for the
        // "X wins, Y losses" display. The rating itself is the weighted mean.
        if (matchupScore >= 0.55) wins++;
        else if (matchupScore <= 0.45) losses++;
        else ties++;
    }

    if (simCount === 0 || totalWeight === 0) return null;
    return {
        battleRating: Math.round((totalScore / totalWeight) * 1000),
        wins, losses, ties, total: simCount,
    };
}

/**
 * Standard battle rating using the full asymmetric shield-scenario distribution.
 * Drop-in replacement for the old symmetric 0/1/2 shield version.
 */
function computeBattleRating(speciesId, cpCap, metaEntries, topN, isShadow) {
    return computeBattleRatingWithScenarios(
        speciesId, cpCap, metaEntries, SHIELD_SCENARIOS_STANDARD, topN || 80, isShadow
    );
}

/**
 * Compute role-specific battle ratings (Lead / Safe Swap / Closer) for a species.
 * Each role uses a shield-scenario set that mirrors that role's real game-state distribution.
 *
 * @param {string}  speciesId
 * @param {number}  cpCap
 * @param {Array}   metaEntries
 * @param {boolean} [isShadow]
 * @returns {{ lead, safeSwap, closer }}  Each value is a computeBattleRatingWithScenarios result or null
 */
function computeRoleRatings(speciesId, cpCap, metaEntries, isShadow) {
    return {
        lead:    computeBattleRatingWithScenarios(speciesId, cpCap, metaEntries, SHIELD_SCENARIOS_LEAD,   30, isShadow),
        safeSwap:computeBattleRatingWithScenarios(speciesId, cpCap, metaEntries, SHIELD_SCENARIOS_SAFE,   30, isShadow),
        closer:  computeBattleRatingWithScenarios(speciesId, cpCap, metaEntries, SHIELD_SCENARIOS_CLOSER, 30, isShadow),
    };
}
