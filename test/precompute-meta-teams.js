/**
 * Precompute "Find meta-busting teams" output as static JSON.
 *
 * Why: the browser-side `runMetaBreaker` runs ~5-15s of battle sim per cup —
 * acceptable on user-click but pure waste when the same league always yields
 * the same teams (no user-specific input). Hoisting it into CI means the
 * browser becomes a JSON renderer (instant load), and the artifact updates
 * whenever the workflow refreshes PvPoke data.
 *
 * Output: wwwroot/data/meta-teams-{leagueKey}.json
 *
 * Reads:  wwwroot/csv/{leagueKey}_overall_rankings.csv + index.json
 *
 * Run all cups:   node test/precompute-meta-teams.js
 * Run one cup:    node test/precompute-meta-teams.js cp1500_all
 *
 * Browser consumer: `runMetaBreaker` (app.js) loads
 * `data/meta-teams-{key}.json` first; falls back to live compute on miss.
 */
'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'wwwroot');
const CLI_LEAGUE = process.argv[2] || null; // null = all cups

// ─── Bootstrap VM context (mirrors test/regression.js pattern) ───────────────
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
    document: {
        getElementById: () => ({
            value: '', checked: false, innerHTML: '', className: '', textContent: '',
            appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [],
        }),
    },
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
})();

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

// ─── Load a league's rankings synchronously into the VM caches ───────────────
function loadLeagueRankings(leagueKey) {
    const csvPath = path.join(root, 'csv', `${leagueKey}_overall_rankings.csv`);
    if (!fs.existsSync(csvPath)) return false;
    ctx.__csvText = fs.readFileSync(csvPath, 'utf8');
    // Hand-roll the same parsing loadRankings() does in the browser. We can't
    // call loadRankings directly because it uses fetch() — we already have the
    // text. The relevant outputs are rankingsCache + roleScoresCache +
    // threatListsCache, all keyed by formatKey.
    vm.runInContext(`(function(){
        const formatKey = ${JSON.stringify(leagueKey)};
        const lines = __csvText.trim().split(/\\r?\\n/);
        const delimiter = lines[0].includes(';') ? ';' : ',';
        const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
        let idCol = headers.indexOf('speciesid');
        if (idCol < 0) idCol = 0;
        const roleCols = {
            lead:     headers.indexOf('leadscore'),
            switch:   headers.indexOf('switchscore'),
            closer:   headers.indexOf('closerscore'),
            attacker: headers.indexOf('attackerscore'),
        };
        const matchupsCol = headers.indexOf('topmatchups');
        const countersCol = headers.indexOf('topcounters');
        const roleScores = { lead: {}, switch: {}, closer: {}, attacker: {} };
        const threatLists = {};
        const rankMap = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            const id = cols[idCol];
            if (!id) continue;
            const hasShadow = /shadow/i.test(id);
            const baseNormalId = normalizeId(id).replace(/_shadow$/i, '');
            const finalId = hasShadow ? baseNormalId + '_shadow' : baseNormalId;
            if (!finalId) continue;
            rankMap[finalId] = i - 1;
            for (const role of ROLE_KEYS) {
                const colIdx = roleCols[role];
                if (colIdx >= 0) {
                    const raw = cols[colIdx];
                    const num = raw === '' || raw == null ? NaN : parseFloat(raw);
                    if (Number.isFinite(num)) roleScores[role][finalId] = num;
                }
            }
            if (matchupsCol >= 0 || countersCol >= 0) {
                const matchups = matchupsCol >= 0 ? parseThreatList(cols[matchupsCol]) : [];
                const counters = countersCol >= 0 ? parseThreatList(cols[countersCol]) : [];
                if (matchups.length || counters.length) threatLists[finalId] = { matchups, counters };
            }
        }
        rankingsCache[formatKey]    = rankMap;
        roleScoresCache[formatKey]  = roleScores;
        threatListsCache[formatKey] = threatLists;
    })()`, ctx);
    return true;
}

// ─── Run buildMetaBreakerTeams for a league via VM ───────────────────────────
function runMetaBreakerInVm(leagueKey, cpCap) {
    return vm.runInContext(
        `buildMetaBreakerTeams(${JSON.stringify(leagueKey)}, ${cpCap})`,
        ctx);
}

// ─── Strip non-serializable / oversized fields from the output ───────────────
// `team[i].battler` (if any), function pointers, etc. are stripped. The mon
// objects' .optimal.fastInfo/.charged1Info/.charged2Info are already plain
// objects (return value of scoreFastMove / scoreChargedMove) and serialize fine.
function sanitizeForJson(obj) {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
        // Strip functions, undefined, NaN/Infinity (JSON.stringify already drops the first two)
        if (typeof value === 'number' && !Number.isFinite(value)) return null;
        // Sets become arrays (cleaner than {})
        if (value instanceof Set) return [...value];
        return value;
    }));
}

function processLeague(entry) {
    const leagueKey = vm.runInContext(`keyFromFilename(${JSON.stringify(entry.file)})`, ctx);
    const cpCap     = vm.runInContext(`parseCpCapFromFilename(${JSON.stringify(entry.file)})`, ctx);

    if (cpCap !== 1500) {
        console.log(`  [skip] ${leagueKey}: non-1500 CP (we only ship 1500-CP cups)`);
        return null;
    }

    process.stdout.write(`  ${leagueKey} ${entry.restricted ? '(restricted)' : '(open)'}: `);

    if (!loadLeagueRankings(leagueKey)) {
        console.log('SKIP (no CSV)');
        return null;
    }

    const startMs = Date.now();
    const result  = runMetaBreakerInVm(leagueKey, cpCap);
    if (!result || !result.teams || result.teams.length === 0) {
        console.log('SKIP (no teams)');
        return null;
    }

    // Reduce the scorer table to top-30 — the browser only renders top-20 but
    // a small headroom is useful in case we ever surface "show more". Anything
    // beyond that is bytes the browser can't act on.
    const allScoredTrimmed = (result.allScored || []).slice(0, 30);

    // Each team is an Array with non-index props (`_chainScore`, `_archetype`,
    // `_matchupStats`) attached. JSON.stringify drops those props for arrays.
    // Convert to {members, chainScore, archetype, matchupStats} so the
    // serialized output captures everything the browser needs. The browser
    // reconstructs the array + props shape when consuming.
    const teamsAsObjects = (result.teams || []).map(t => ({
        members:      [...t],
        chainScore:   t._chainScore,
        archetype:    t._archetype,
        matchupStats: t._matchupStats,
    }));

    const payload = sanitizeForJson({
        leagueKey,
        cpCap,
        generated: new Date().toISOString(),
        metaEntries: result.metaEntries,
        teams:       teamsAsObjects,
        allScored:   allScoredTrimmed,
    });

    const outPath = path.join(root, 'data', `meta-teams-${leagueKey}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const bytes   = fs.statSync(outPath).size;
    const bytesKb = (bytes / 1024).toFixed(1);
    console.log(`OK ${result.teams.length} teams, ${elapsed}s, ${bytesKb} KB`);
    return outPath;
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log(`\n=== Precompute meta-busting teams ===\n`);

const index = ctx.__leagueIndex;
const targets = CLI_LEAGUE
    ? index.filter(e => vm.runInContext(`keyFromFilename(${JSON.stringify(e.file)})`, ctx) === CLI_LEAGUE)
    : index;

if (targets.length === 0) {
    console.error(`✗ No matching leagues for: ${CLI_LEAGUE || '(all)'}`);
    process.exit(1);
}

console.log(`Targets: ${targets.length} league(s)\n`);

let processed = 0, skipped = 0;
const startTotal = Date.now();
for (const entry of targets) {
    const r = processLeague(entry);
    if (r) processed++; else skipped++;
}

const totalSec = ((Date.now() - startTotal) / 1000).toFixed(1);
console.log(`\n=== Done in ${totalSec}s — ${processed} written, ${skipped} skipped ===`);
