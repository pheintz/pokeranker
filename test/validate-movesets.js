/**
 * Sim-vs-PvPoke moveset divergence harness.
 *
 * Runs our sim's pickOptimalMovesetSim across all ranked species in a league,
 * compares each pick against PvPoke's CSV-shipped recommendation, and head-
 * to-head sims our-pick vs PvPoke-pick to measure which actually wins more
 * matchups against the meta.
 *
 * Why this exists: Pokeranker's anti-meta value proposition is finding picks
 * the math validates that PvPoke doesn't recommend. Without this harness,
 * every disagreement is ambiguous (sim bug? tournament-accessibility bias?).
 * With it, each disagreement gets a head-to-head sim verdict.
 *
 * Output: wwwroot/data/sim-vs-pvpoke-{league}.json — consumed by the app's
 * "Anti-meta picks" UI to surface findings.
 *
 * Run with:  node test/validate-movesets.js [leagueKey]
 *   default leagueKey: cp1500_all
 *
 * Categories per species:
 *   agreement       — our pick == PvPoke's pick
 *   sim-superior    — disagree AND our pick beats PvPoke's in head-to-head
 *   pvpoke-superior — disagree AND PvPoke's pick beats ours
 *   indeterminate   — disagree, head-to-head margin within ±0.02 (a wash)
 */
'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const LEAGUE_KEY = process.argv[2] || 'cp1500_all';
const TOP_N_META = 30;
const HEAD_TO_HEAD_TOP_N = 30;
const VERDICT_MARGIN = 0.02;

// ─── Bootstrap: same pattern as test/regression.js ─────────────────────────
const root = path.join(__dirname, '..', 'wwwroot');

function readScript(name) {
    return fs.readFileSync(path.join(root, name), 'utf8');
}

function localFetch(url) {
    const stripped = String(url).replace(/^\.\//, '');
    const fullPath = path.join(root, stripped);
    if (!fs.existsSync(fullPath)) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(''), json: () => Promise.reject(new Error('404')) });
    }
    const buf = fs.readFileSync(fullPath, 'utf8');
    return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(buf),
        json: () => Promise.resolve(JSON.parse(buf)),
    });
}

const ctx = vm.createContext({
    console, Math, Date, parseInt, parseFloat, isNaN, isFinite,
    JSON, Array, Object, Set, Map, Promise,
    fetch: localFetch,
    document: {
        getElementById: () => ({
            value: '', checked: false, innerHTML: '', className: '', textContent: '',
            appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [],
        }),
    },
    window: {},
});

for (const script of ['data.js', 'meta.js', 'battle-engine.js', 'team-builder.js', 'app.js']) {
    try {
        vm.runInContext(readScript(script), ctx, { filename: script });
    } catch (e) {
        console.error(`✗ Failed to load ${script}:\n`, e.message);
        process.exit(1);
    }
}

function bootstrapGameData() {
    const movesPath   = path.join(root, 'data', 'moves.json');
    const pokemonPath = path.join(root, 'data', 'pokemon.json');
    if (!fs.existsSync(movesPath) || !fs.existsSync(pokemonPath)) {
        console.error('Missing data/pokemon.json or data/moves.json. Run process/download-csv.js first.');
        process.exit(1);
    }
    ctx.__movesData   = JSON.parse(fs.readFileSync(movesPath, 'utf8'));
    ctx.__pokemonData = JSON.parse(fs.readFileSync(pokemonPath, 'utf8'));
    vm.runInContext(`
        for (const m of __movesData) { try { applyGamemasterMove(m); } catch (e) {} }
        for (const p of __pokemonData) {
            if (!p.speciesId) continue;
            const id = p.speciesId;
            if (p.baseStats) POKEMON_STATS[id] = [p.baseStats.atk, p.baseStats.def, p.baseStats.hp];
            if (p.types) {
                const t = p.types.filter(x => x !== 'none');
                if (t.length) POKEMON_TYPES[id] = t;
            }
            if (p.family && p.family.evolutions && p.family.evolutions.length) EVOLUTIONS[id] = p.family.evolutions;
            if (typeof POKEMON_MOVESETS !== 'undefined') {
                const fast    = (p.fastMoves    || []).map(s => s.toLowerCase());
                const charged = (p.chargedMoves || []).map(s => s.toLowerCase());
                const elite   = (p.eliteMoves   || []).map(s => s.toLowerCase());
                for (const eid of elite) {
                    if (FAST_MOVES[eid] !== undefined) { if (!fast.includes(eid)) fast.push(eid); }
                    else if (CHARGED_MOVES[eid] !== undefined) { if (!charged.includes(eid)) charged.push(eid); }
                }
                POKEMON_MOVESETS[id] = { fast, charged, elite };
            }
        }
        for (const [alias, canonical] of Object.entries(POKEMON_ID_ALIASES)) {
            if (POKEMON_STATS[canonical])    POKEMON_STATS[alias]    = POKEMON_STATS[canonical];
            if (POKEMON_TYPES[canonical])    POKEMON_TYPES[alias]    = POKEMON_TYPES[canonical];
            if (POKEMON_MOVESETS[canonical]) POKEMON_MOVESETS[alias] = POKEMON_MOVESETS[canonical];
            if (EVOLUTIONS[canonical])       EVOLUTIONS[alias]       = EVOLUTIONS[canonical];
        }
    `, ctx);
}
bootstrapGameData();

// Populate LEAGUE_FORMATS synchronously from csv/index.json (browser does this via fetch).
function bootstrapLeagues() {
    const indexPath = path.join(root, 'csv', 'index.json');
    if (!fs.existsSync(indexPath)) {
        console.error('Missing csv/index.json. Run process/download-csv.js first.');
        process.exit(1);
    }
    ctx.__leagueIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    vm.runInContext(`
        for (const entry of __leagueIndex) {
            const key = keyFromFilename(entry.file);
            const cpCap = parseCpCapFromFilename(entry.file);
            LEAGUE_FORMATS[key] = {
                label: entry.label,
                cpCap,
                csvFile: entry.file,
                restricted: !!entry.restricted,
            };
        }
    `, ctx);
}
bootstrapLeagues();

// ─── Load the league's CSV ──────────────────────────────────────────────────
function loadRankingsCsv(leagueKey) {
    const csvPath = path.join(root, 'csv', `${leagueKey}_overall_rankings.csv`);
    if (!fs.existsSync(csvPath)) {
        console.error(`✗ CSV not found: ${csvPath}`);
        process.exit(1);
    }
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idCol   = headers.indexOf('speciesid');
    const fastCol = headers.indexOf('fastmove');
    const c1Col   = headers.indexOf('chargedmove1');
    const c2Col   = headers.indexOf('chargedmove2');
    if (idCol < 0 || fastCol < 0 || c1Col < 0 || c2Col < 0) {
        console.error(`✗ CSV missing required columns. Found: ${headers.join(', ')}`);
        process.exit(1);
    }
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const id   = cols[idCol]?.trim();
        const fast = cols[fastCol]?.trim().toLowerCase();
        const c1   = cols[c1Col]?.trim().toLowerCase();
        const c2   = cols[c2Col]?.trim().toLowerCase();
        if (id && fast && c1) rows.push({ id, rank: i - 1, pvpokeFast: fast, pvpokeC1: c1, pvpokeC2: c2 || null });
    }
    return rows;
}

// ─── Run validation ─────────────────────────────────────────────────────────
function vmRef(name) {
    return vm.runInContext(name, ctx);
}

function pickOptimalMovesetSim(speciesId, metaEntries, cpCap, oppCache) {
    if (oppCache) {
        ctx.__oppCacheTmp = oppCache;
        return vm.runInContext(
            `pickOptimalMovesetSim(${JSON.stringify(speciesId)}, __metaEntries, ${cpCap}, { oppCache: __oppCacheTmp })`,
            ctx);
    }
    return vm.runInContext(`pickOptimalMovesetSim(${JSON.stringify(speciesId)}, __metaEntries, ${cpCap})`, ctx);
}
function buildBattlerWithMoves(speciesId, cpCap, fast, c1, c2) {
    return vm.runInContext(`buildBattlerWithMoves(${JSON.stringify(speciesId)}, ${cpCap}, ${JSON.stringify(fast)}, ${JSON.stringify(c1)}, ${c2 ? JSON.stringify(c2) : 'null'}, false)`, ctx);
}
function simulateBattle(a, b, sa, sb) {
    ctx.__a = a; ctx.__b = b;
    return vm.runInContext(`simulateBattle(__a, __b, ${sa}, ${sb})`, ctx);
}
function battleMargin(r) {
    return (r.aHpPct - r.bHpPct + 1) / 2;
}

function buildOppBattler(speciesId, cpCap, metaEntries) {
    const moves = vm.runInContext(`pickOptimalMoveset(${JSON.stringify(speciesId)}, __metaEntries)`, ctx);
    if (!moves) return null;
    return buildBattlerWithMoves(speciesId, cpCap, moves.bestFast, moves.charged1, moves.charged2);
}

function headToHead(ourBattler, pvpokeBattler, opps) {
    if (!ourBattler || !pvpokeBattler) return null;
    const W_00 = 0.15, W_11 = 0.35, W_22 = 0.15, W_10 = 0.20, W_01 = 0.15;
    let oursTotal = 0, pvpokeTotal = 0, totalW = 0;
    let oursWins = 0, pvpokeWins = 0;
    const perOpp = [];
    for (const o of opps) {
        const oursBlend = blendVs(ourBattler, o.battler);
        const pvBlend   = blendVs(pvpokeBattler, o.battler);
        oursTotal   += oursBlend * o.weight;
        pvpokeTotal += pvBlend * o.weight;
        totalW += o.weight;
        if (oursBlend  > 0.5) oursWins++;
        if (pvBlend    > 0.5) pvpokeWins++;
        perOpp.push({ opp: o.id, ours: +oursBlend.toFixed(3), pvpoke: +pvBlend.toFixed(3), weight: o.weight });
    }
    function blendVs(b, opp) {
        const m00 = battleMargin(simulateBattle(b, opp, 0, 0));
        const m11 = battleMargin(simulateBattle(b, opp, 1, 1));
        const m22 = battleMargin(simulateBattle(b, opp, 2, 2));
        const m10 = battleMargin(simulateBattle(b, opp, 1, 0));
        const m01 = battleMargin(simulateBattle(b, opp, 0, 1));
        return W_00*m00 + W_11*m11 + W_22*m22 + W_10*m10 + W_01*m01;
    }

    // Bootstrap 95% CI on the margin diff (Efron 1979). We resample the 30
    // opp sample with replacement B times; each bootstrap sample produces a
    // weighted-mean diff. The 2.5th and 97.5th percentiles bracket the 95%
    // CI for "what's our pick's advantage if we'd happened to pick a
    // different sample of opps from this same meta?". Zero additional sim
    // cost — pure resampling on the per-opp data we already have.
    const B = 1000;
    const bootDiffs = new Array(B);
    const n = perOpp.length;
    for (let b = 0; b < B; b++) {
        let oursW = 0, pvW = 0, w = 0;
        for (let i = 0; i < n; i++) {
            const idx = Math.floor(Math.random() * n);
            const p = perOpp[idx];
            oursW += p.ours * p.weight;
            pvW   += p.pvpoke * p.weight;
            w     += p.weight;
        }
        bootDiffs[b] = w > 0 ? (oursW - pvW) / w : 0;
    }
    bootDiffs.sort((x, y) => x - y);
    const ci95Lo = bootDiffs[Math.floor(0.025 * B)];
    const ci95Hi = bootDiffs[Math.floor(0.975 * B)];

    return {
        oursAvgMargin:   totalW > 0 ? +(oursTotal / totalW).toFixed(3)   : 0,
        pvpokeAvgMargin: totalW > 0 ? +(pvpokeTotal / totalW).toFixed(3) : 0,
        oursWins,
        pvpokeWins,
        perOpp: perOpp.map(p => ({ opp: p.opp, ours: p.ours, pvpoke: p.pvpoke })),
        ci95Lo: +ci95Lo.toFixed(3),
        ci95Hi: +ci95Hi.toFixed(3),
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log(`\n=== Sim-vs-PvPoke moveset validation: ${LEAGUE_KEY} ===\n`);

const leagueInfo = vm.runInContext(`getLeagueInfo(${JSON.stringify(LEAGUE_KEY)})`, ctx);
if (!leagueInfo || !leagueInfo.cpCap) {
    console.error(`✗ Unknown league: ${LEAGUE_KEY}`);
    process.exit(1);
}
const cpCap = leagueInfo.cpCap;
console.log(`League: ${leagueInfo.label || LEAGUE_KEY} (CP cap ${cpCap})`);

const rows = loadRankingsCsv(LEAGUE_KEY);
console.log(`Loaded ${rows.length} ranked species.\n`);

// Build meta entries for the sim — reuse what app.js does.
const metaIds = rows.slice(0, TOP_N_META).map(r => r.id);
ctx.__metaEntries = metaIds.map((id, i) => ({
    id,
    types: vm.runInContext(`POKEMON_TYPES[${JSON.stringify(id)}] || ['normal']`, ctx),
    weight: TOP_N_META - i,
}));

// Pre-build opponent battlers for the head-to-head sim using heuristic moves
// (same approach pickOptimalMovesetSim uses internally).
const headToHeadOpps = [];
for (const e of ctx.__metaEntries.slice(0, HEAD_TO_HEAD_TOP_N)) {
    const b = buildOppBattler(e.id, cpCap, ctx.__metaEntries);
    if (b) headToHeadOpps.push({ id: e.id, battler: b, weight: e.weight });
}
console.log(`Built ${headToHeadOpps.length} head-to-head opponent battlers.\n`);

const results = [];
let agreements = 0, simSuperior = 0, pvpokeSuperior = 0, indeterminate = 0;
let processed = 0, skipped = 0;
const startMs = Date.now();

// ─── Round 1: heuristic-opp sim picks for top-N meta ─────────────────────────
// Fictitious play (Brown 1951): in round 1 each species best-responds to
// opponents using their heuristic-derived movesets. We populate a cache for
// only the top-N meta species since they're the only opps we'll ever face.
console.log(`\n=== Round 1 (heuristic opps) — top-${TOP_N_META} meta only ===`);
const round1Cache = {};
let r1Done = 0;
const r1Start = Date.now();
for (const row of rows.slice(0, TOP_N_META)) {
    const stats   = vm.runInContext(`POKEMON_STATS[${JSON.stringify(row.id)}]`,    ctx);
    const moveset = vm.runInContext(`POKEMON_MOVESETS[${JSON.stringify(row.id)}]`, ctx);
    if (!stats || !moveset || !moveset.charged || moveset.charged.length === 0) continue;
    const pick = pickOptimalMovesetSim(row.id, ctx.__metaEntries, cpCap);
    if (pick) {
        round1Cache[row.id] = {
            bestFast: pick.bestFast,
            charged1: pick.charged1,
            charged2: pick.charged2,
        };
    }
    r1Done++;
}
console.log(`  Round 1 done: ${r1Done} top-meta species cached in ${((Date.now()-r1Start)/1000).toFixed(1)}s\n`);

// Replace the head-to-head opponents with sim-derived picks too. This is what
// makes round-2 verdict comparisons meaningful — we're checking "does our pick
// beat PvPoke's pick when both face the converged meta opps", not "when both
// face a heuristic strawman." Without this, the head-to-head sim itself
// inherits the round-1 bias.
const headToHeadOppsR2 = [];
for (const e of ctx.__metaEntries.slice(0, HEAD_TO_HEAD_TOP_N)) {
    const moves = round1Cache[e.id];
    if (!moves) {
        // Fallback: heuristic if a top-30 species couldn't be sim'd
        const b = buildOppBattler(e.id, cpCap, ctx.__metaEntries);
        if (b) headToHeadOppsR2.push({ id: e.id, battler: b, weight: e.weight });
        continue;
    }
    const b = buildBattlerWithMoves(e.id, cpCap, moves.bestFast, moves.charged1, moves.charged2);
    if (b) headToHeadOppsR2.push({ id: e.id, battler: b, weight: e.weight });
}

// ─── Round 2: full pass with sim-cached opps ─────────────────────────────────
// For each species, evaluate against opps that now run their round-1 sim
// picks. This is the convergence step. Top-30 species are effectively at
// round 2; non-top-30 species see this as their first pass with sim-cached
// opps (already converged from their perspective since all their opps are
// in the top-30 cache).
console.log(`=== Round 2 (sim-cached opps) — full ${rows.length} species ===`);

for (const row of rows) {
    // Skip species with no stats / no charged moves
    const stats = vm.runInContext(`POKEMON_STATS[${JSON.stringify(row.id)}]`, ctx);
    const moveset = vm.runInContext(`POKEMON_MOVESETS[${JSON.stringify(row.id)}]`, ctx);
    if (!stats || !moveset || !moveset.charged || moveset.charged.length === 0) {
        skipped++;
        continue;
    }

    const ourPick = pickOptimalMovesetSim(row.id, ctx.__metaEntries, cpCap, round1Cache);
    if (!ourPick) { skipped++; continue; }

    const ourFast = ourPick.bestFast;
    const ourC1   = ourPick.charged1;
    const ourC2   = ourPick.charged2;

    const agree = (ourFast === row.pvpokeFast)
                && ((ourC1 === row.pvpokeC1 && ourC2 === row.pvpokeC2)
                 || (ourC1 === row.pvpokeC2 && ourC2 === row.pvpokeC1));

    if (agree) {
        agreements++;
        results.push({
            species: row.id,
            rank: row.rank,
            verdict: 'agreement',
            moves: { fast: ourFast, c1: ourC1, c2: ourC2 },
        });
        processed++;
        continue;
    }

    // Disagreement — head-to-head sim against round-2 opps.
    const ourBattler    = buildBattlerWithMoves(row.id, cpCap, ourFast, ourC1, ourC2);
    const pvpokeBattler = buildBattlerWithMoves(row.id, cpCap, row.pvpokeFast, row.pvpokeC1, row.pvpokeC2);

    const h2h = headToHead(ourBattler, pvpokeBattler, headToHeadOppsR2);
    if (!h2h) { skipped++; continue; }

    // Verdict via bootstrap 95% CI: indeterminate if CI crosses zero,
    // otherwise the sign of the CI determines the winner. More rigorous than
    // a fixed ±0.02 point-estimate threshold — "sim-superior" requires the
    // entire 95% CI to lie above zero. The point estimate is reported too
    // for ranking the findings.
    const diff = h2h.oursAvgMargin - h2h.pvpokeAvgMargin;
    let verdict;
    if (h2h.ci95Lo <= 0 && h2h.ci95Hi >= 0) verdict = 'indeterminate';
    else if (h2h.ci95Lo > 0)                verdict = 'sim-superior';
    else                                    verdict = 'pvpoke-superior';

    if (verdict === 'sim-superior')        simSuperior++;
    else if (verdict === 'pvpoke-superior') pvpokeSuperior++;
    else                                    indeterminate++;

    results.push({
        species: row.id,
        rank: row.rank,
        verdict,
        ourPick:    { fast: ourFast,        c1: ourC1,        c2: ourC2 },
        pvpokePick: { fast: row.pvpokeFast, c1: row.pvpokeC1, c2: row.pvpokeC2 },
        oursAvgMargin:   h2h.oursAvgMargin,
        pvpokeAvgMargin: h2h.pvpokeAvgMargin,
        marginDiff: +diff.toFixed(3),
        ci95Lo: h2h.ci95Lo,
        ci95Hi: h2h.ci95Hi,
        oursWins:   h2h.oursWins,
        pvpokeWins: h2h.pvpokeWins,
        topDifferingMatchups: h2h.perOpp
            .map(p => ({ ...p, diff: +(p.ours - p.pvpoke).toFixed(3) }))
            .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
            .slice(0, 5),
    });
    processed++;

    if (processed % 50 === 0) {
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        process.stdout.write(`  [${elapsed}s] ${processed}/${rows.length} processed (${skipped} skipped) — `
            + `${agreements} agree, ${simSuperior} sim-sup, ${pvpokeSuperior} pvpoke-sup, ${indeterminate} indet.\n`);
    }
}

const elapsedTotal = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n=== Summary (${elapsedTotal}s) ===`);
console.log(`Total ranked species:     ${rows.length}`);
console.log(`Processed:                ${processed}`);
console.log(`Skipped (no data):        ${skipped}`);
console.log(`──────────────────────────────────────`);
console.log(`Agreements (our = PvPoke):    ${agreements}  (${(agreements/processed*100).toFixed(1)}%)`);
console.log(`Sim-superior (anti-meta):     ${simSuperior}  (${(simSuperior/processed*100).toFixed(1)}%)`);
console.log(`PvPoke-superior:              ${pvpokeSuperior}  (${(pvpokeSuperior/processed*100).toFixed(1)}%)`);
console.log(`Indeterminate (within ±${VERDICT_MARGIN}): ${indeterminate}  (${(indeterminate/processed*100).toFixed(1)}%)`);

// Top sim-superior findings for the user to inspect
const simSuperiorResults = results
    .filter(r => r.verdict === 'sim-superior')
    .sort((a, b) => b.marginDiff - a.marginDiff);

if (simSuperiorResults.length) {
    console.log(`\n=== Top sim-superior anti-meta picks ===\n`);
    for (const r of simSuperiorResults.slice(0, 15)) {
        console.log(`  #${r.rank+1} ${r.species}: ours ${r.ourPick.fast}/${r.ourPick.c1}/${r.ourPick.c2 || '-'} `
            + `vs PvPoke ${r.pvpokePick.fast}/${r.pvpokePick.c1}/${r.pvpokePick.c2 || '-'} — `
            + `+${r.marginDiff.toFixed(3)} margin (${r.oursWins} vs ${r.pvpokeWins} wins)`);
    }
}

// Sim-inferior findings — these are the cases where sim diverged but PvPoke's
// pick wins. Either sim has a bias we should investigate, or PvPoke's pick is
// genuinely the better choice on the merits.
const pvpokeSuperiorResults = results
    .filter(r => r.verdict === 'pvpoke-superior')
    .sort((a, b) => a.marginDiff - b.marginDiff);

if (pvpokeSuperiorResults.length) {
    console.log(`\n=== Sim-inferior picks (sim diverges but PvPoke wins) ===\n`);
    for (const r of pvpokeSuperiorResults.slice(0, 15)) {
        console.log(`  #${r.rank+1} ${r.species}: ours ${r.ourPick.fast}/${r.ourPick.c1}/${r.ourPick.c2 || '-'} `
            + `vs PvPoke ${r.pvpokePick.fast}/${r.pvpokePick.c1}/${r.pvpokePick.c2 || '-'} — `
            + `${r.marginDiff.toFixed(3)} margin (${r.oursWins} vs ${r.pvpokeWins} wins)`);
    }
}

// Write artifact for the UI
const outPath = path.join(root, 'data', `sim-vs-pvpoke-${LEAGUE_KEY}.json`);
fs.writeFileSync(outPath, JSON.stringify({
    leagueKey: LEAGUE_KEY,
    cpCap,
    generated: new Date().toISOString(),
    summary: {
        total: rows.length, processed, skipped,
        agreements, simSuperior, pvpokeSuperior, indeterminate,
    },
    results,
}, null, 2), 'utf8');

console.log(`\nWrote ${outPath}`);
