// ─── Team Builder ────────────────────────────────────────────────────────────
// Shared team-quality engine — primitives for both Meta Breaker (search the
// full dex) and Box Builder (search the imported box). All team-building
// functions use these so every team is evaluated identically regardless
// of which builder produced it.
//
// Loaded after battle-engine.js so simulateBattle / buildBattler / etc are
// in scope. Loaded before app.js — buildMetaBreakerTeams + buildBoxTeams
// (still in app.js, UI-coupled) call into these.
//
// Public surface used by app.js:
//   battleMargin, phiMargin, computeEnergyMomentum, classifyTeamArchetype,
//   ARCHETYPE_COLORS, deriveDefensiveCores, computeAttackPrevalence,
//   buildTeamsGreedy, scoreTeamFull,
//   computeAntimetaBaseline, computeAntimetaValue.

// ─────────────────────────────────────────────────────────────────────────────
// Shared team-quality engine
// All team-building functions (Meta Breaker + Box Builder) use these primitives
// so every team is evaluated identically regardless of which builder produced it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Continuous battle margin: (ourHP% − theirHP% + 1) / 2
 * Range: 0.0 (we faint, opp at full HP) → 1.0 (opp faints, we at full HP).
 * A barely-win (5% left) and a barely-loss (opp 5% left) score ~0.525 / ~0.475 —
 * nearly equal — so teams that compete hard even in losing matchups earn credit.
 */
function battleMargin(r) { return (r.aHpPct - r.bHpPct + 1) / 2; }

/**
 * Energy-momentum score: how much does a Pokémon's weighted matchup record
 * improve when it enters with 30 banked energy vs 0?  High → ideal safe swap.
 */
function computeEnergyMomentum(candidateId, isShadow, cpCap, metaEntries) {
    const battler = getCachedBattler(candidateId, cpCap, metaEntries, isShadow);
    if (!battler) return 0;
    const topOpps = metaEntries.slice(0, 25)
        .map(e => getCachedBattler(e.id, cpCap, metaEntries, false)).filter(Boolean);
    if (!topOpps.length) return 0;
    let s0 = 0, s30 = 0;
    for (const opp of topOpps) {
        s0  += battleMargin(simulateBattle(battler, opp, 1, 1, null, 0,  0));
        s30 += battleMargin(simulateBattle(battler, opp, 1, 1, null, 30, 0));
    }
    return Math.max(0, Math.min(1, (s30 - s0) / topOpps.length));
}

/** Archetype badge colours — shared by all renderers. */
const ARCHETYPE_COLORS = {
    'ABC · Balanced':    '#4ade80',
    'ABB · Double-Back': '#60a5fa',
    'ABA · Bookend':     '#a78bfa',
    'All Safe Swap':     '#34d399',
    'Attack Heavy':      '#f87171',
    'Mixed':             '#94a3b8',
};

/**
 * Classify the structural template of a 3-member team.
 * Returns one of: ABA · Bookend / ABB · Double-Back / All Safe Swap /
 *                 ABC · Balanced / Attack Heavy / Mixed
 */
function classifyTeamArchetype(team) {
    if (team.length < 3) return null;
    const [lead, swap, closer] = team;
    function covers(a, d) {
        return (a.moveTypes || []).some(mt =>
            typeEffectiveness(mt, d.types[0], d.types[1] || null) > 1.0);
    }
    function weakCount(m) {
        return TYPES_LIST.filter(t =>
            typeEffectiveness(t, m.types[0], m.types[1] || null) > 1.0).length;
    }
    function minNrg(m) {
        const vals = [m.optimal?.charged1Info?.nrg, m.optimal?.charged2Info?.nrg].filter(v => v != null);
        return vals.length ? Math.min(...vals) : 55;
    }
    const [lt, st, ct] = [lead.types[0], swap.types[0], closer.types[0]];
    if (lt === ct && st !== lt) return 'ABA · Bookend';
    if (st === ct && lt !== st) return 'ABB · Double-Back';
    const wc = [lead, swap, closer].map(weakCount);
    const spammy = [lead, swap, closer].filter(m => minNrg(m) <= 45).length;
    if (wc.every(c => c <= 2) && spammy >= 2) return 'All Safe Swap';
    if (covers(lead, closer) && covers(closer, lead)) return 'ABC · Balanced';
    const lp = lead.pressureScore || 0;
    const bp = ((swap.pressureScore || 0) + (closer.pressureScore || 0)) / 2;
    if (lp >= 0.55 && lp > bp * 1.35) return 'Attack Heavy';
    return 'Mixed';
}

/**
 * Greedy 3v3 team builder — shared by Meta Breaker and Box Builder.
 *
 * @param {Array}         candidates  Scored pool (needs .id, .types, .moveTypes)
 * @param {number}        count       Target number of distinct teams
 * @param {Function}      scoreFn     (cand, slot) → base numeric value
 * @param {Function|null} slotFilter  (cand, slot, team) → bool — optional per-slot gate
 * @param {Object}        [ctx]       { rank1Battler, rank2Battler } — pre-built battlers
 */
// ── Defensive cores (P11) — derived per cup ──
// The Pokemon that absorb fast-move chip in whatever format is currently
// loaded. For each of the top N meta species we collect the attack types
// that hit ≥1.6x against its typing; teams get a bonus per fast-move type
// that "cracks" a core no prior teammate could.
//
// This used to be a hard-coded Open-GL list (Azumarill / Altaria / Registeel /
// Clodsire / Umbreon). Deriving from the cup's CSV makes the bonus correct
// in restricted cups (Remix, Retro, Fantasy, …) and at higher CP caps
// (Ultra 2500, Master 10000), where the walls are entirely different.
function deriveDefensiveCores(metaEntries, topN) {
    const cores = [];
    const limit = Math.min(topN || 8, metaEntries.length);
    for (let i = 0; i < limit; i++) {
        const entry = metaEntries[i];
        const t1 = entry.types[0];
        const t2 = entry.types[1] || null;
        const breaks = new Set();
        for (const atk of TYPES_LIST) {
            if (typeEffectiveness(atk, t1, t2) >= 1.6) breaks.add(atk);
        }
        if (breaks.size > 0) cores.push({ name: entry.id, breaks });
    }
    return cores;
}

// ── Meta attack-type prevalence (Tier 1 + Tier 3) ──
// For each of the 18 types, how "loud" is that type as an attacker in the
// current cup? We walk the top N meta entries, resolve each one's optimal
// moveset (so coverage moves like Altaria's Flamethrower count, not just
// STAB), and accumulate rank-weighted "move votes" per type. Fast moves
// weigh 2× charged because they fire every turn.
//
// Output is normalized so the mean across all 18 types = 1.0. Types the
// meta never uses return 0, which zeroes out penalties/bonuses tied to
// them in buildTeamsGreedy and scoreTeamFull. Types used heavily (e.g.
// Water in a water-leaning cup) return >1, scaling their terms up.
function computeAttackPrevalence(metaEntries, topN) {
    const limit = Math.min(topN || 30, metaEntries.length);
    const totals = {};
    for (let i = 0; i < limit; i++) {
        const entry = metaEntries[i];
        const optimal = pickOptimalMoveset(entry.id, metaEntries);
        if (!optimal) continue;
        // Defensive default — current callers always set weight, but guard
        // against future callers (or stale cached metaEntries) that might not.
        const w = entry.weight ?? 1;
        const ft = optimal.fastInfo && optimal.fastInfo.type;
        const c1 = optimal.charged1Info && optimal.charged1Info.type;
        const c2 = optimal.charged2Info && optimal.charged2Info.type;
        if (ft) totals[ft] = (totals[ft] || 0) + w * 2;
        if (c1) totals[c1] = (totals[c1] || 0) + w;
        if (c2 && c2 !== c1) totals[c2] = (totals[c2] || 0) + w;
    }
    const sum = TYPES_LIST.reduce((s, t) => s + (totals[t] || 0), 0);
    const mean = sum / TYPES_LIST.length;
    const prevalence = {};
    for (const t of TYPES_LIST) {
        prevalence[t] = mean > 0 ? (totals[t] || 0) / mean : 1;
    }
    return prevalence;
}

function buildTeamsGreedy(candidates, count, scoreFn, slotFilter, ctx) {
    const { rank1Battler = null, defensiveCores = [], attackPrevalence = null } = ctx || {};
    // prev(t) → defensive multiplier. 1.0 when no prevalence data, so callers
    // that don't supply attackPrevalence get the original (type-agnostic) behaviour.
    const prev = (t) => attackPrevalence ? (attackPrevalence[t] ?? 1) : 1;
    const teams = [], usedAsLead = new Set(), seenKeys = new Set();

    for (let t = 0; t < count * 4 && teams.length < count; t++) {
        const team = [], teamTypes = new Set(), teamWeak = [];
        // P11 team state: cores already broken by a prior teammate's fast move.
        const coresBroken = new Set();
        // P6 team state: count of teammates per fast-move type (for diversity penalty).
        const fastTypeCount = {};

        for (let slot = 0; slot < 3; slot++) {
            const pool = slotFilter ? candidates.filter(c => slotFilter(c, slot, team)) : candidates;
            let bestPick = null, bestVal = -Infinity;

            for (const cand of pool) {
                if (team.some(m => m.id === cand.id)) continue;
                if (slot === 0 && usedAsLead.has(cand.id)) continue;

                let val = scoreFn(cand, slot);

                // Offensive novelty: bonus per new attack type.
                // P6: the fast move type counts more than charged-move types
                // because the fast move fires every turn and drives chip pressure.
                const fastType = cand.optimal?.fastInfo?.type;
                for (const mt of cand.moveTypes) {
                    if (!teamTypes.has(mt)) {
                        val += (mt === fastType) ? 0.18 : 0.10;
                    }
                }

                // P6: diversity penalty — third+ teammate sharing a fast-move type.
                // Two of the same is sometimes correct (double Fighting cores exist);
                // three+ is almost always redundant pressure.
                if (fastType && (fastTypeCount[fastType] || 0) >= 2) val -= 0.08;

                // P11: core-break bonus — reward picks whose fast move cracks
                // a defensive core that no prior teammate cracked. Strongest
                // incentive for the first crack of each core.
                if (fastType) {
                    for (const core of defensiveCores) {
                        if (!coresBroken.has(core.name) && core.breaks.has(fastType)) {
                            val += 0.07;
                        }
                    }
                }

                // Defensive synergy: bonus for covering existing weaknesses.
                // Tier 1: scale by how prevalent that attack type is in the meta —
                // covering a hole to a common type matters more than a rare one.
                for (const wt of teamWeak) {
                    const m = typeEffectiveness(wt, cand.types[0], cand.types[1] || null);
                    if (m < 1) val += 0.15 * (1 - m) * prev(wt);
                }

                // Shared weakness penalty.
                // Tier 1: same prevalence weighting — doubling up on a weakness
                // to the cup's dominant attack type is much costlier than to a
                // rare one. Types absent from the meta contribute zero.
                for (const tp of TYPES_LIST) {
                    if (typeEffectiveness(tp, cand.types[0], cand.types[1] || null) > 1.0) {
                        const already = team.filter(tm =>
                            typeEffectiveness(tp, tm.types[0], tm.types[1] || null) > 1.0).length;
                        if (already > 0) val -= 0.12 * already * prev(tp);
                    }
                }

                // Role-specific slot-fit bonus.
                //
                // Priority order (most calibrated first):
                //   1. PvPoke per-role scores (0–100, from rankings JSON) — these
                //      are the cup's published 1v1 sims under each shield scenario,
                //      directly mapping to lead/safe-swap/closer/attacker roles.
                //   2. Internal roleRatings (sim against current meta) — fallback
                //      when the loaded CSV predates the role-scores schema.
                //   3. Heuristic move/pressure flags — last-resort fallback.
                //
                // Scaling: max bonus ≈ 0.10 across all paths so the slot-fit signal
                // is comparable to the existing offensive-novelty / defensive-synergy
                // bonuses and doesn't drown them out.
                if (cand.pvpokeRoles) {
                    const pr = cand.pvpokeRoles;
                    if (slot === 0 && typeof pr.lead     === 'number') val += pr.lead     / 1000;
                    if (slot === 1 && typeof pr.switch   === 'number') val += pr.switch   / 1000;
                    if (slot === 2 && typeof pr.closer   === 'number') val += pr.closer   / 1000;
                } else if (cand.roleRatings) {
                    const rr = cand.roleRatings;
                    if (slot === 0 && rr.lead)     val += rr.lead.battleRating     / 10000;
                    if (slot === 1 && rr.safeSwap) val += rr.safeSwap.battleRating / 10000;
                    if (slot === 2 && rr.closer)   val += rr.closer.battleRating   / 10000;
                } else {
                    if (slot === 0 && (cand.pressureScore || 0) > 0.5)  val += 0.05;
                    if (slot === 2 && (cand.optimal?.charged2Info?.pow ?? 0) >= 80) val += 0.05;
                }

                // Safe-swap energy-momentum bonus
                if (slot === 1) val += (cand.energyMomentum || 0) * 0.25;

                // Lead fragility penalty.
                // Tier 1: only count weaknesses to attack types the meta actually
                // uses (prevalence >= 0.5). A lead with 4 weaknesses to rare
                // types is fine; 3 weaknesses to common types is fatal.
                if (slot === 0) {
                    const wc = TYPES_LIST.filter(tp =>
                        typeEffectiveness(tp, cand.types[0], cand.types[1] || null) > 1.0 &&
                        prev(tp) >= 0.5).length;
                    if (wc >= 3) val -= 0.10 * (wc - 2);
                }

                // Pivot quality bonus (non-lead: ≤2 dangerous weaknesses + ≤45 energy move)
                if (slot >= 1) {
                    const wc  = TYPES_LIST.filter(tp =>
                        typeEffectiveness(tp, cand.types[0], cand.types[1] || null) > 1.0 &&
                        prev(tp) >= 0.5).length;
                    const nrg = Math.min(
                        cand.optimal?.charged1Info?.nrg ?? 55,
                        cand.optimal?.charged2Info?.nrg ?? 55);
                    if (wc <= 2 && nrg <= 45) val += 0.06;
                }

                // Top-threat coverage bonus
                if (rank1Battler && cand.beatsRank1 && !team.some(m => m.beatsRank1)) val += 0.12;

                if (val > bestVal) { bestVal = val; bestPick = cand; }
            }

            if (bestPick) {
                team.push(bestPick);
                if (slot === 0) usedAsLead.add(bestPick.id);
                for (const mt of bestPick.moveTypes) teamTypes.add(mt);
                for (const tp of TYPES_LIST)
                    if (typeEffectiveness(tp, bestPick.types[0], bestPick.types[1] || null) > 1.0)
                        teamWeak.push(tp);
                // P11 / P6 state: record the fast-move type and cores cracked
                // so subsequent slots see the updated team state.
                const pickedFastType = bestPick.optimal?.fastInfo?.type;
                if (pickedFastType) {
                    fastTypeCount[pickedFastType] = (fastTypeCount[pickedFastType] || 0) + 1;
                    for (const core of defensiveCores) {
                        if (core.breaks.has(pickedFastType)) coresBroken.add(core.name);
                    }
                }
            }
        }

        if (team.length === 3) {
            const key = team.map(m => m.id).sort().join('|');
            if (!seenKeys.has(key)) { seenKeys.add(key); teams.push(team); }
        }
    }
    return teams;
}

/**
 * Asymmetric loss-averse remap of a battle margin, inspired by PvPoke's
 * TeamRanker.js. Wins above 0.5 are compressed (diminishing returns —
 * "winning by 0.95 is barely better than 0.7 once you've won the matchup");
 * losses are linear (full magnitude). A flat 0.55 team scores higher than a
 * 0.7/0.7/0.3 team with the same linear average — matches the doctrine that
 * consistency beats high-variance in 3v3.
 *
 *   phi(1.0)  ≈ 0.7  (max win compressed)
 *   phi(0.5)  = 0.5  (tie unchanged)
 *   phi(0.0)  = 0.0  (max loss unchanged)
 */
function phiMargin(m) {
    if (m >= 0.5) return 0.5 + 0.2 * Math.pow(2 * (m - 0.5), 0.75);
    return m;
}

/**
 * Full 3v3 team score (0–1000) with matchup detail stats.
 * Weights (Tier-4 rebalance; prior weights 30/60/10 retained in history):
 *   Coverage   → 25%  (multi-shield blend)
 *   Role chain → 50%
 *   Synergy    → 10%
 *   Lead tree  → 15%  (new — lead slot vs cup's top leads)
 *
 * Tier-4 additions:
 *   - Coverage uses a 3-shield blend (0s/1s/2s) per matchup, not just 1s/1s.
 *     Many matchups flip on shield count: closers win at 0s, bait-dependent
 *     picks lose at 0s. Matches PvPoke's 0-shield + 1-shield methodology.
 *   - Species-level threat score: for each meta opponent, count how many
 *     team members lose (blended margin < 0.45). ≥2 losers → rank-weighted
 *     penalty. Catches "team killers" that pure type-overlap analysis misses.
 *   - Lead matchup tree: dedicated sim of battlers[0] (the lead) vs the
 *     cup's top LEAD_TOP_N meta picks at 1s/1s. Lead-vs-lead decides the
 *     opening — whether you stay in or burn your switch.
 *
 * Tier-6 additions:
 *   - Asymmetric shield scenarios: coverage blend now also tests 1v0
 *     (up-a-shield pressure) and 0v1 (down-a-shield stabilization),
 *     matching PvPoke's "attackers/chargers" methodology.
 *   - Opponent residual energy carryover: when lead loses, opp0 enters
 *     the safe-swap matchup with its actual remaining energy (from the
 *     prior fight) rather than resetting to 0 — a realistic "immediate
 *     nuke" pressure test for the safe swap.
 *   - Offensive type diversity: penalize teams whose primary (nuke-slot)
 *     charged moves are mono- or duo-type — these get walled by a single
 *     resistor. Counts distinct nuke types across all team members.
 *
 * @returns {{ score: number, stats: object }}
 */
function scoreTeamFull(team, cpCap, metaEntries, topN, attackPrevalence, leagueKey) {
    topN = topN || 30;
    const battlers = [];
    for (const m of team) {
        const b = getCachedBattler(m.id, cpCap, metaEntries, m.isShadow);
        if (b) battlers.push(b);
        else console.warn(`scoreTeamFull: getCachedBattler returned null for ${m.id}${m.isShadow ? ' (shadow)' : ''} at cpCap=${cpCap}`);
    }
    if (battlers.length < 2) return { score: 0, stats: null };

    // ── 1. Coverage score (25%) + threat + lead capture ──────────────────
    // Run each matchup across FIVE shield scenarios and blend them.
    // Symmetric:   0v0 (closer mirror),  1v1 (standard),   2v2 (lead mirror)
    // Asymmetric:  1v0 (up-shield pressure), 0v1 (down-shield stabilization)
    //   Tier-6 addition: PvPoke's published methodology uses asymmetric
    //   scenarios (attackers=0v2, chargers=energy-advantage, etc). A team
    //   that only wins symmetric 1v1s but folds when up a shield can't
    //   close; one that collapses when down a shield can't recover.
    //   Weights sum to 1.00 and emphasize the common 1v1 outcome while
    //   still testing pressure/recovery behavior.
    // hardHole: best team member's blended margin < 0.45 (no good answer).
    // Threat score: per opponent, count team members with blended < 0.45;
    //               ≥2 losers → rank-weighted penalty (team killer).
    // Lead capture: battlers[0] 1s-margin vs top LEAD_TOP_N opponents,
    //               reused for the leadScore term (no duplicate sims).
    const LEAD_TOP_N = 8;
    const W_00 = 0.15, W_11 = 0.35, W_22 = 0.15, W_10 = 0.20, W_01 = 0.15;
    let covWeightedSum = 0, totalWeight = 0;
    let hardHoles = 0, oppCount = 0;
    let wins = 0, winHpSum = 0, losses = 0, lossHpSum = 0;
    let threatPenalty = 0, threatCount = 0;
    const topKillers = [];
    let leadMarginSum = 0, leadMarginCount = 0;

    const limit = Math.min(topN, metaEntries.length);
    for (let i = 0; i < limit; i++) {
        const oppEntry = metaEntries[i];
        const opp = getCachedBattler(oppEntry.id, cpCap, metaEntries, false);
        if (!opp) continue;
        oppCount++;
        // Meta-rank weight: favors coverage against the cup's most common
        // opponents (rank 1 matters more than rank 30). Matches PvPoke's
        // doctrine: "weighs each Battle Rating by the opponent's average."
        const weight = oppEntry.weight ?? (limit - i);
        const rankWeight = 1 - i / limit; // for threat penalty scaling

        let bestBlended = 0, bestR1 = null;
        let losers = 0;
        for (let bi = 0; bi < battlers.length; bi++) {
            const b = battlers[bi];
            const r00 = simulateBattle(b, opp, 0, 0);
            const r11 = simulateBattle(b, opp, 1, 1);
            const r22 = simulateBattle(b, opp, 2, 2);
            const r10 = simulateBattle(b, opp, 1, 0); // up a shield
            const r01 = simulateBattle(b, opp, 0, 1); // down a shield
            const m00 = battleMargin(r00);
            const m11 = battleMargin(r11);
            const m22 = battleMargin(r22);
            const m10 = battleMargin(r10);
            const m01 = battleMargin(r01);
            const blended = W_00*m00 + W_11*m11 + W_22*m22 + W_10*m10 + W_01*m01;
            if (blended > bestBlended) { bestBlended = blended; bestR1 = r11; }
            if (blended < 0.45) losers++;
            // Lead slot: capture 1-shield margin vs the top common leads.
            if (bi === 0 && i < LEAD_TOP_N) {
                leadMarginSum += m11;
                leadMarginCount++;
            }
        }
        // Asymmetric ϕ: compresses high wins (diminishing returns) while
        // leaving losses linear, matching PvPoke's loss-averse aggregation.
        // Hard-hole / threat detection keeps the raw `bestBlended` so the
        // < 0.45 threshold semantics are preserved.
        covWeightedSum += phiMargin(bestBlended) * weight;
        totalWeight += weight;
        if (bestBlended < 0.45) hardHoles++;
        if (bestR1) {
            if (bestR1.winner === 'a')    { wins++;   winHpSum  += bestR1.aHpPct; }
            else if (bestR1.winner !== 'tie') { losses++; lossHpSum += bestR1.bHpPct; }
        }
        if (losers >= 2) {
            // PvPoke amplification: when PvPoke's published `matchups` list for
            // this meta opponent (= ids THIS opp beats) contains 2+ of our team
            // mons, the shared weakness is *confirmed by an external sim*, not
            // just our local engine. Amplify the penalty so the team-builder
            // avoids canonical anti-meta failure modes (e.g. all-Water vs Grass).
            // Threshold: at least one team mon must appear in the published list
            // before we trust the amplification — guards against off-meta IDs
            // PvPoke doesn't track.
            let pvpokeAmp = 1;
            const oppThreats = leagueKey ? getThreats(oppEntry.id, leagueKey) : null;
            if (oppThreats && oppThreats.matchups && oppThreats.matchups.length) {
                const teamIds = team.map(m => m.id || m.baseId);
                const confirmed = oppThreats.matchups.filter(mu =>
                    teamIds.includes(mu.opp)
                    || teamIds.includes(mu.opp + '_shadow')
                    || (mu.opp.endsWith('_shadow') && teamIds.includes(mu.opp.replace(/_shadow$/, '')))
                ).length;
                if (confirmed >= 2)      pvpokeAmp = 1.5;
                else if (confirmed >= 1) pvpokeAmp = 1.15;
            }
            threatPenalty += (losers - 1) * (losers - 1) * rankWeight * pvpokeAmp;
            threatCount++;
            topKillers.push({ id: oppEntry.id, losers, rankWeight, pvpokeAmp });
        }
    }
    if (oppCount === 0 || totalWeight === 0) return { score: 0, stats: null };
    const coverageScore = Math.max(0,
        covWeightedSum / totalWeight - hardHoles * 0.04 - threatPenalty * 0.02);

    // ── 2. Role-chain score (50%) ────────────────────────────────────────
    let roleScore = 0.5;
    if (battlers.length >= 3) {
        const chain = metaEntries.slice(0, 30)
            .map(e => getCachedBattler(e.id, cpCap, metaEntries, false)).filter(Boolean);
        function runChain(o0, o1, o2) {
            const r1 = simulateBattle(battlers[0], o0, 1, 1);
            const leadWon = r1.winner === 'a';
            const swE = leadWon ? Math.round(r1.aHpPct * 30) : 0;
            // If lead lost, safe swap faces the SAME opponent (o0) at their
            // residual HP (bHpPct) after KO'ing the lead — not a freshly-
            // healed o0. If lead won, next opponent o1 enters fresh.
            // Tier-6: when lead loses, opp0 has been banking fast-move energy
            // all fight and typically retains meaningful residual energy.
            // Carry r1.bEnergy directly (simulateBattle returns final energy
            // state) rather than resetting opp0 to 0 — this realistically
            // tests whether the safe swap can weather an immediate nuke.
            const r2 = leadWon
                ? simulateBattle(battlers[1], o1, 1, 1, null, swE, 0)
                : simulateBattle(battlers[1], o0, 1, 1, null, swE, r1.bEnergy || 0, 1.0, r1.bHpPct);
            // Closer faces o2 with no shields on either side.
            const r3  = simulateBattle(battlers[2], o2, 0, 0, null, Math.round(r2.aHpPct * 25), 0);
            return (battleMargin(r1) + battleMargin(r2) + battleMargin(r3)) / 3;
        }
        if (chain.length >= 3) {
            const starts = [0, 3, 6, 9, 12].filter(s => s + 2 < chain.length);
            const scores = starts.map(s => runChain(chain[s], chain[s+1], chain[s+2]));
            roleScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        }
    }

    // ── 3. Type-synergy score (10%) ──────────────────────────────────────
    // Tier 1: each shared/triple weakness is weighted by how prevalent that
    // attack type is in the cup's meta (mean across 18 types = 1.0). Sharing
    // a weakness to the dominant type hurts more than to a rare one.
    // Tier 2: additionally count "coverage holes" — attack types with
    // prevalence >= 0.7 that NO team member resists. An all-three-fold
    // scenario to a common attack type is a hard red flag.
    const prev = (t) => attackPrevalence ? (attackPrevalence[t] ?? 1) : 1;
    let sharedWeak = 0, tripleWeak = 0, coverageHoles = 0;
    for (const tp of TYPES_LIST) {
        const wc = battlers.filter(b =>
            typeEffectiveness(tp, b.types[0], b.types[1] || null) > 1.0).length;
        const p = prev(tp);
        if (wc >= 2) sharedWeak += p;
        if (wc === 3) tripleWeak += p;
        if (p >= 0.7) {
            const anyResist = battlers.some(b =>
                typeEffectiveness(tp, b.types[0], b.types[1] || null) < 1.0);
            if (!anyResist) coverageHoles += 1;
        }
    }
    // Tier-6: offensive charged-move type diversity. A team whose primary
    // nukes are all the same type gets walled by a single resistor
    // (e.g., all-Fighting nukes → Togekiss/Clefable shut down the team).
    // For each Pokemon, pick the higher-DPE charged move (the "nuke" slot)
    // and count distinct types across the team.
    const nukeTypes = new Set();
    for (const b of battlers) {
        const c1 = b.charged1, c2 = b.charged2;
        if (!c1) continue;
        // DPE = damage-per-energy at neutral attacker stats (power/energy
        // is a reasonable proxy — STAB/effectiveness vary by matchup).
        const c1Dpe = c1.pow / Math.max(1, c1.nrg);
        const c2Dpe = c2 ? c2.pow / Math.max(1, c2.nrg) : -1;
        const nuke = c2Dpe > c1Dpe ? c2 : c1;
        if (nuke && nuke.type) nukeTypes.add(nuke.type);
    }
    // 1 distinct type across 3 battlers → severe wall risk; 2 → moderate.
    let offensiveDiversityPenalty = 0;
    if (battlers.length >= 2 && nukeTypes.size === 1)      offensiveDiversityPenalty = 0.20;
    else if (battlers.length >= 3 && nukeTypes.size === 2) offensiveDiversityPenalty = 0.05;

    const synergyScore = Math.max(0,
        1 - sharedWeak * 0.08 - tripleWeak * 0.15 - coverageHoles * 0.10
          - offensiveDiversityPenalty);

    // ── 4. Lead matchup tree score (15%) ─────────────────────────────────
    // battlers[0] vs the cup's top LEAD_TOP_N picks, averaged 1s-margin.
    // Already accumulated inside the coverage loop — no extra sims.
    const leadScore = leadMarginCount > 0 ? leadMarginSum / leadMarginCount : 0.5;

    // ── Blend and scale ──────────────────────────────────────────────────
    const score = Math.round(Math.max(0, Math.min(1,
          coverageScore * 0.25
        + roleScore     * 0.50
        + synergyScore  * 0.10
        + leadScore     * 0.15
    )) * 1000);

    // Sort team killers by losers desc, then by rank weight desc.
    topKillers.sort((a, b) =>
        (b.losers - a.losers) || (b.rankWeight - a.rankWeight));

    // Keep full killer metadata (id, losers, pvpokeAmp) so the team-card UI can
    // render "PvPoke confirms" badges on threats whose shared-weakness was
    // independently corroborated by PvPoke's published matchups list.
    return {
        score,
        stats: {
            wins, losses, oppCount, hardHoles, coverageHoles,
            threatCount,
            topKillers: topKillers.slice(0, 3),
            avgWinMargin:  wins   > 0 ? Math.round(winHpSum  / wins   * 100) : 0,
            avgLossMargin: losses > 0 ? Math.round(lossHpSum / losses * 100) : 0,
            coverageScore: Math.round(coverageScore * 100),
            chainScore:    Math.round(roleScore * 100),
            leadScore:     Math.round(leadScore * 100),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anti-meta value: empirical "spice" replacement.
 *
 * The old spice bonus was a flat +0.08 for any Pokemon outside the top-100
 * rank cliff, rewarding obscurity rather than effectiveness. This version
 * measures what actually matters: does this candidate beat top-meta picks
 * that an average top-20 meta pick would NOT beat?
 *
 * Method:
 *   1. Compute baseline = median 1v1/1v1 wins of top-20 ranked Pokemon vs.
 *      the top-15 meta. This captures "how many top-15 a typical meta pick
 *      beats" — the bar a spice pick must clear to be worth including.
 *   2. For each non-top-20 candidate, count its 1v1/1v1 wins vs. top-15.
 *   3. antimetaValue = clamp(wins − baseline) × 0.03, capped at 0.15.
 *
 * Result: Galvantula-like picks that genuinely punch up at meta rise;
 * obscure-but-useless picks (rank ~500 with no wins) drop to 0 bonus.
 * Top-20 meta picks never get the bonus — they're already meta.
 */
function computeAntimetaBaseline(cpCap, metaEntries, top15Battlers) {
    const winsList = [];
    const sampleSize = Math.min(20, metaEntries.length);
    for (let i = 0; i < sampleSize; i++) {
        const cand = getCachedBattler(metaEntries[i].id, cpCap, metaEntries, false);
        if (!cand) continue;
        let wins = 0;
        for (const opp of top15Battlers) {
            if (!opp || opp === cand) continue; // skip self-mirror
            const r = simulateBattle(cand, opp, 1, 1);
            if (r.winner === 'a') wins++;
        }
        winsList.push(wins);
    }
    if (winsList.length === 0) return 0;
    winsList.sort((a, b) => a - b);
    return winsList[Math.floor(winsList.length / 2)]; // median
}

/**
 * Per-candidate anti-meta value. Returns 0 for top-20 meta picks.
 * @param {string}      candidateId
 * @param {number}      cpCap
 * @param {Array}       metaEntries
 * @param {Array}       top15Battlers  precomputed via getCachedBattler
 * @param {number}      baseline        median wins across top-20 meta
 * @param {boolean}     isShadow
 * @param {number|null} metaRank        0-indexed rank, or null if unranked
 * @returns {number} 0 to 0.15
 */
function computeAntimetaValue(candidateId, cpCap, metaEntries, top15Battlers, baseline, isShadow, metaRank) {
    // Top-20 meta picks don't get antimeta — they ARE the meta we score against.
    if (metaRank != null && metaRank < 20) return 0;
    const cand = getCachedBattler(candidateId, cpCap, metaEntries, isShadow);
    if (!cand) return 0;
    let wins = 0;
    for (const opp of top15Battlers) {
        if (!opp || opp === cand) continue;
        const r = simulateBattle(cand, opp, 1, 1);
        if (r.winner === 'a') wins++;
    }
    const margin = wins - baseline;
    if (margin <= 0) return 0;
    return Math.min(0.15, margin * 0.03);
}
