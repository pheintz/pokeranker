/**
 * Sim engine fidelity harness.
 *
 * Compares our simulator's per-matchup Battle Rating against PvPoke's
 * published Battle Ratings (shipped in our CSVs as the topMatchups/
 * topCounters columns). Same species, same moveset (PvPoke's CSV pick),
 * same shield scenario — does our sim produce the same outcome PvPoke does?
 *
 * Why this matters: every claim our app makes ("Quagsire wins this matchup",
 * "this anti-meta pick beats PvPoke's pick") inherits whatever bugs our
 * simulator has. Without fidelity validation, the divergences we surface
 * could be sim artifacts rather than real anti-meta findings.
 *
 * Methodology:
 *   1. Use top-30 species in the league as the sample.
 *   2. For each species, read PvPoke's topMatchups + topCounters from CSV.
 *      These are pairs of {opponent, rating} where rating is from the
 *      species's perspective. Rating > 500 = species won, < 500 = species lost.
 *   3. Build battlers using PvPoke's CSV-shipped moveset for both sides.
 *      (Strips out moveset-selection disagreements — we're testing the sim
 *      engine alone.)
 *   4. Run our sim, compute Battle Rating per PvPoke's formula:
 *        BR = 500 × (1 − opp_hp_pct) + 500 × our_hp_pct
 *      Range 0–1000, 500 = tie.
 *   5. Compare to PvPoke's published rating. Tolerance bands:
 *        |Δ| ≤ 50  : "match" (within 5% — close enough for ranking parity)
 *        |Δ| ≤ 100 : "close" (10% — same broad outcome)
 *        |Δ| > 100 : "diverge" (worth investigating)
 *
 * Run: node test/validate-sim-fidelity.js [leagueKey]
 *      default leagueKey: cp1500_all
 *
 * Output: console summary + wwwroot/data/sim-fidelity-{league}.json
 */
'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const LEAGUE_KEY    = process.argv[2] || 'cp1500_all';
const TOP_N_SAMPLE  = 30;
const SHIELDS_LIST  = [[0,0],[1,1],[2,2]];
const MATCH_TOL     = 50;
const CLOSE_TOL     = 100;

// ─── Bootstrap (mirrors test/regression.js + test/validate-movesets.js) ──────
const root = path.join(__dirname, '..', 'wwwroot');

function readScript(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }

function localFetch(url) {
    const stripped = String(url).replace(/^\.\//, '');
    const fullPath = path.join(root, stripped);
    if (!fs.existsSync(fullPath)) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(''), json: () => Promise.reject(new Error('404')) });
    }
    const buf = fs.readFileSync(fullPath, 'utf8');
    return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(buf),
        json: () => Promise.resolve(JSON.parse(buf)),
    });
}

const ctx = vm.createContext({
    console, Math, Date, parseInt, parseFloat, isNaN, isFinite,
    JSON, Array, Object, Set, Map, Promise,
    fetch: localFetch,
    document: { getElementById: () => ({ value: '', checked: false, innerHTML: '', appendChild: () => {} }) },
    window: {},
});

for (const script of ['data.js', 'meta.js', 'battle-engine.js', 'team-builder.js', 'app.js']) {
    try { vm.runInContext(readScript(script), ctx, { filename: script }); }
    catch (e) { console.error(`✗ Load failed: ${script}\n`, e.message); process.exit(1); }
}

(function bootstrapGameData() {
    const movesPath   = path.join(root, 'data', 'moves.json');
    const pokemonPath = path.join(root, 'data', 'pokemon.json');
    if (!fs.existsSync(movesPath) || !fs.existsSync(pokemonPath)) {
        console.error('Missing data files — run process/download-csv.js first.');
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
})();

// ─── Load CSV with PvPoke's rating data ─────────────────────────────────────
function loadFidelityCsv(leagueKey) {
    const csvPath = path.join(root, 'csv', `${leagueKey}_overall_rankings.csv`);
    if (!fs.existsSync(csvPath)) {
        console.error(`✗ CSV not found: ${csvPath}`);
        process.exit(1);
    }
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const cols = {
        id:    headers.indexOf('speciesid'),
        fast:  headers.indexOf('fastmove'),
        c1:    headers.indexOf('chargedmove1'),
        c2:    headers.indexOf('chargedmove2'),
        topM:  headers.indexOf('topmatchups'),
        topC:  headers.indexOf('topcounters'),
    };
    if (Object.values(cols).some(v => v < 0)) {
        console.error(`✗ CSV missing required columns. Got: ${headers.join(', ')}`);
        process.exit(1);
    }

    const parseList = (raw) => {
        if (!raw) return [];
        return raw.split(';').filter(Boolean).map(pair => {
            const [opp, rating] = pair.split(':');
            return { opp: opp?.trim(), rating: parseInt(rating, 10) };
        }).filter(x => x.opp && Number.isFinite(x.rating));
    };

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        rows.push({
            id:        c[cols.id]?.trim(),
            rank:      i - 1,
            pvFast:    c[cols.fast]?.trim().toLowerCase(),
            pvC1:      c[cols.c1]?.trim().toLowerCase(),
            pvC2:      c[cols.c2]?.trim().toLowerCase() || null,
            topM:      parseList(c[cols.topM]),
            topC:      parseList(c[cols.topC]),
        });
    }
    return rows;
}

// ─── VM bridges ─────────────────────────────────────────────────────────────
function buildBattlerWithMoves(speciesId, cpCap, fast, c1, c2) {
    return vm.runInContext(
        `buildBattlerWithMoves(${JSON.stringify(speciesId)}, ${cpCap}, ${JSON.stringify(fast)}, ${JSON.stringify(c1)}, ${c2 ? JSON.stringify(c2) : 'null'}, false)`,
        ctx);
}
function simulateBattle(a, b, sa, sb) {
    ctx.__a = a; ctx.__b = b;
    return vm.runInContext(`simulateBattle(__a, __b, ${sa}, ${sb})`, ctx);
}

// ─── Battle Rating per PvPoke's formula ─────────────────────────────────────
// BR (from a's perspective) = 500 × (1 − bHpPct) + 500 × aHpPct
// 1000 = perfect win (a full HP, b 0 HP); 500 = tie; 0 = perfect loss.
function battleRating(simResult) {
    const ourHp = simResult.aHpPct;
    const oppHp = simResult.bHpPct;
    return Math.round(500 * (1 - oppHp) + 500 * ourHp);
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log(`\n=== Sim engine fidelity validation: ${LEAGUE_KEY} ===\n`);

const leagueInfo = vm.runInContext(`(function(){
    const idx = ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'csv', 'index.json'), 'utf8')))};
    const entry = idx.find(e => keyFromFilename(e.file) === ${JSON.stringify(LEAGUE_KEY)});
    if (!entry) return null;
    return { cpCap: parseCpCapFromFilename(entry.file), label: entry.label };
})()`, ctx);

if (!leagueInfo) { console.error(`✗ Unknown league: ${LEAGUE_KEY}`); process.exit(1); }
const cpCap = leagueInfo.cpCap;
console.log(`League: ${leagueInfo.label} (CP cap ${cpCap})`);

const rows = loadFidelityCsv(LEAGUE_KEY);
const sample = rows.slice(0, TOP_N_SAMPLE);
console.log(`Sample: top-${TOP_N_SAMPLE} species, comparing matchup outcomes against PvPoke's published ratings.\n`);

const speciesById = new Map(rows.map(r => [r.id, r]));

const compares = [];

for (const row of sample) {
    if (!row.pvFast || !row.pvC1) continue;
    const ourBattler = buildBattlerWithMoves(row.id, cpCap, row.pvFast, row.pvC1, row.pvC2);
    if (!ourBattler) continue;

    // Concatenate matchups + counters — both have same structure (opp, rating)
    const allOpps = [
        ...row.topM.map(m => ({ ...m, kind: 'win'  })),
        ...row.topC.map(m => ({ ...m, kind: 'loss' })),
    ];

    for (const m of allOpps) {
        const oppRow = speciesById.get(m.opp);
        if (!oppRow || !oppRow.pvFast) continue;
        const oppBattler = buildBattlerWithMoves(m.opp, cpCap, oppRow.pvFast, oppRow.pvC1, oppRow.pvC2);
        if (!oppBattler) continue;

        // Test all three symmetric shield scenarios. Pick the one that
        // produces the smallest |Δ| as the "best match" — PvPoke's published
        // rating is an aggregate, so we report the closest scenario plus the
        // averaged BR across all three.
        let bestDiff = Infinity;
        let bestBr = null;
        let bestScenario = null;
        const perScenario = [];
        let avgBr = 0;
        for (const [sa, sb] of SHIELDS_LIST) {
            const r = simulateBattle(ourBattler, oppBattler, sa, sb);
            const br = battleRating(r);
            const diff = br - m.rating;
            perScenario.push({ shields: `${sa}v${sb}`, ourBr: br, diff });
            avgBr += br;
            if (Math.abs(diff) < Math.abs(bestDiff)) {
                bestDiff = diff;
                bestBr = br;
                bestScenario = `${sa}v${sb}`;
            }
        }
        avgBr = Math.round(avgBr / SHIELDS_LIST.length);
        const avgDiff = avgBr - m.rating;

        compares.push({
            species:      row.id,
            speciesRank:  row.rank,
            opp:          m.opp,
            kind:         m.kind,
            pvpokeRating: m.rating,
            ourBrAvg:     avgBr,
            ourBrBest:    bestBr,
            avgDiff,
            bestDiff,
            bestScenario,
            perScenario,
        });
    }
}

// ─── Stats ──────────────────────────────────────────────────────────────────
const total = compares.length;
const matches = compares.filter(c => Math.abs(c.bestDiff) <= MATCH_TOL).length;
const close   = compares.filter(c => Math.abs(c.bestDiff) > MATCH_TOL && Math.abs(c.bestDiff) <= CLOSE_TOL).length;
const diverge = compares.filter(c => Math.abs(c.bestDiff) > CLOSE_TOL).length;

const meanAbsDiff = compares.length > 0
    ? Math.round(compares.reduce((s, c) => s + Math.abs(c.bestDiff), 0) / compares.length)
    : 0;
const meanSignedDiff = compares.length > 0
    ? Math.round(compares.reduce((s, c) => s + c.bestDiff, 0) / compares.length)
    : 0;

// Outcome agreement: do we and PvPoke agree on winner (rating > 500 vs < 500)?
const outcomeAgrees = compares.filter(c => {
    const ours = c.ourBrBest > 500;
    const pv   = c.pvpokeRating > 500;
    return ours === pv;
}).length;

console.log('=== Summary ===');
console.log(`Total matchups compared:    ${total}`);
console.log(`──────────────────────────────────────`);
console.log(`Match  (|Δ| ≤ ${MATCH_TOL}):           ${matches}  (${(matches/total*100).toFixed(1)}%)`);
console.log(`Close  (${MATCH_TOL} < |Δ| ≤ ${CLOSE_TOL}):    ${close}  (${(close/total*100).toFixed(1)}%)`);
console.log(`Diverge (|Δ| > ${CLOSE_TOL}):           ${diverge}  (${(diverge/total*100).toFixed(1)}%)`);
console.log(`──────────────────────────────────────`);
console.log(`Mean |Δ|:                   ${meanAbsDiff} BR points`);
console.log(`Mean signed Δ:              ${meanSignedDiff > 0 ? '+' : ''}${meanSignedDiff}  (positive = our sim more generous)`);
console.log(`Outcome agreement:          ${outcomeAgrees}/${total} (${(outcomeAgrees/total*100).toFixed(1)}%) — same winner regardless of magnitude`);

console.log(`\n=== Worst divergences (|Δ| > ${CLOSE_TOL}) ===\n`);
const worstDiverge = compares.filter(c => Math.abs(c.bestDiff) > CLOSE_TOL)
    .sort((a, b) => Math.abs(b.bestDiff) - Math.abs(a.bestDiff))
    .slice(0, 20);
for (const d of worstDiverge) {
    console.log(`  ${d.species} vs ${d.opp.padEnd(22)} `
        + `pvpoke=${String(d.pvpokeRating).padStart(4)} `
        + `ours=${String(d.ourBrBest).padStart(4)} (best ${d.bestScenario}) `
        + `Δ=${d.bestDiff > 0 ? '+' : ''}${d.bestDiff} `
        + `[${d.kind}]`);
}

// ─── Artifact ───────────────────────────────────────────────────────────────
const outPath = path.join(root, 'data', `sim-fidelity-${LEAGUE_KEY}.json`);
fs.writeFileSync(outPath, JSON.stringify({
    leagueKey: LEAGUE_KEY,
    cpCap,
    generated: new Date().toISOString(),
    summary: {
        total, matches, close, diverge,
        meanAbsDiff, meanSignedDiff,
        outcomeAgreement: outcomeAgrees,
        outcomeAgreementPct: +(outcomeAgrees/total*100).toFixed(1),
    },
    matchTolerance: MATCH_TOL,
    closeTolerance: CLOSE_TOL,
    compares: compares.sort((a, b) => Math.abs(b.bestDiff) - Math.abs(a.bestDiff)),
}, null, 2), 'utf8');
console.log(`\nWrote ${outPath}`);
