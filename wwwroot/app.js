// ─── League Formats ──────────────────────────────────────────────────────────
// Populated at startup from csv/index.json — do not edit manually.
//
// To add a new league or cup:
//   1. Drop the CSV file into wwwroot/csv/
//   2. Add one line to wwwroot/csv/index.json  ← only file you need to touch
//
// Schema of each index.json entry:
//   file       {string}   CSV filename inside wwwroot/csv/
//   label      {string}   Human-readable name shown in the dropdown
//   restricted {boolean?} true → cup: only Pokémon listed in the CSV are eligible.
//                         Omit (or false) for open formats (GL, UL, etc.)
//
// cpCap is parsed automatically from the filename convention: cp{number}_…
// idColumn is auto-detected from the CSV headers when the file is first loaded.

let LEAGUE_FORMATS = {};  // populated by initLeagues()

/**
 * Parses the CP cap from a CSV filename using the convention cp{number}_…
 * e.g. "cp1500_all_overall_rankings.csv" → 1500
 */
function parseCpCapFromFilename(filename) {
    const m = String(filename).match(/cp(\d+)_/i);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Derives a stable format key from a CSV filename by stripping the common suffix.
 * e.g. "cp1500_fantasy_overall_rankings.csv" → "cp1500_fantasy"
 */
function keyFromFilename(filename) {
    return String(filename).replace(/_overall_rankings\.csv$/i, '').replace(/\.csv$/i, '');
}

/**
 * Fetches csv/index.json and populates LEAGUE_FORMATS.
 * Falls back gracefully to an empty object if the file can't be loaded.
 * Returns a promise that resolves when the dropdown is ready to build.
 */
async function initLeagues() {
    try {
        const resp = await fetch('./csv/index.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const entries = await resp.json();
        LEAGUE_FORMATS = {};
        for (const entry of entries) {
            const cpCap = parseCpCapFromFilename(entry.file);
            if (!cpCap) { console.warn('[leagues] could not parse cpCap from:', entry.file); continue; }
            const key = keyFromFilename(entry.file);
            LEAGUE_FORMATS[key] = {
                cpCap,
                csvFile:    entry.file,
                label:      entry.label || key,
                restricted: entry.restricted || false,
                // idColumn is intentionally omitted — loadRankings auto-detects it
            };
        }
        console.log('[leagues] loaded', Object.keys(LEAGUE_FORMATS).length, 'formats from index.json');
    } catch (err) {
        console.error('[leagues] failed to load csv/index.json:', err);
    }
}

/** Returns the LEAGUE_FORMATS entry for the given key (falls back to first entry). */
function getLeagueInfo(formatKey) {
    return LEAGUE_FORMATS[String(formatKey)] || Object.values(LEAGUE_FORMATS)[0] || {};
}

/** Reads the current league select and returns its info object. */
function getSelectedLeagueInfo() {
    const el  = document.getElementById('league');
    const key = el ? el.value : Object.keys(LEAGUE_FORMATS)[0] || '';
    return { key, ...getLeagueInfo(key) };
}

/**
 * Builds the league <select> from LEAGUE_FORMATS.
 * Called after initLeagues() resolves so the dropdown reflects whatever
 * CSV files are present — no code changes needed when adding a new cup.
 */
function populateLeagueDropdown() {
    const el = document.getElementById('league');
    if (!el) return;
    const currentVal = el.value;
    el.innerHTML = '';
    for (const [key, info] of Object.entries(LEAGUE_FORMATS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${info.label} (${info.cpCap} CP)`;
        el.appendChild(opt);
    }
    // Restore selection if it still exists, otherwise default to first entry
    if (currentVal && el.querySelector(`option[value="${currentVal}"]`)) {
        el.value = currentVal;
    }
}

const rankingsCache   = {};   // formatKey → { speciesId: zeroBasedRankIndex }
const roleScoresCache = {};   // formatKey → { lead:{id:score}, switch:{...}, closer:{...}, attacker:{...} }
// PvPoke per-Pokémon threat lists, packed in trailing CSV columns
// (topMatchups = ids that THIS species beats; topCounters = ids that beat it).
// Format: formatKey → { speciesId: { matchups: [{opp, rating}], counters: [{opp, rating}] } }
const threatListsCache = {};
const rankingsLoading = {};   // formatKey → Promise (prevents duplicate fetches)

// PvPoke role categories carried in the CSV trailing columns. Order matches
// the column order written by process/download-csv.js so display loops are stable.
const ROLE_KEYS = ['lead', 'switch', 'closer', 'attacker'];
const ROLE_LABELS = { lead: 'Lead', switch: 'Safe Swap', closer: 'Closer', attacker: 'Attacker' };

async function loadRankings(formatKey) {
    formatKey = String(formatKey);
    if (rankingsCache[formatKey]) return rankingsCache[formatKey];
    if (rankingsLoading[formatKey]) return rankingsLoading[formatKey];

    const { csvFile } = getLeagueInfo(formatKey);
    rankingsLoading[formatKey] = (async () => {
        const url = `./csv/${csvFile}`;
        console.log('[rankings] fetching', url);

        let response;
        try {
            response = await fetch(url);
        } catch (fetchErr) {
            throw new Error(
                `fetch() failed for ${url} — if opening via file://, serve the folder instead ` +
                `(e.g. npx serve wwwroot). Raw: ${fetchErr}`
            );
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url} — check the filename matches exactly`);
        }

        const text = await response.text();
        const lines = text.trim().split(/\r?\n/);
        if (!lines.length) throw new Error('Rankings CSV is empty');

        const delimiter = lines[0].includes(';') ? ';' : ',';
        const headers   = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));

        // Determine which column holds the species identifier.
        // 1. Use idColumn from LEAGUE_FORMATS config if specified (most reliable).
        // 2. Fall back to heuristic detection for future CSVs with unknown headers.
        const { idColumn: configIdColumn } = getLeagueInfo(formatKey);
        let idCol = configIdColumn ? headers.indexOf(configIdColumn.toLowerCase()) : -1;
        if (idCol < 0) idCol = headers.indexOf('speciesid');
        if (idCol < 0) idCol = headers.indexOf('specieid');   // typo seen in some exports
        if (idCol < 0) idCol = headers.indexOf('pokemon');
        if (idCol < 0) idCol = headers.indexOf('name');
        if (idCol < 0) idCol = headers.findIndex(h => h.includes('species') || h === 'mon');
        if (idCol < 0) idCol = 0; // last resort: first column

        // Optional per-role score columns (leadscore/switchscore/closerscore/attackerscore).
        // These ship in CSVs generated by process/download-csv.js since the role-rankings
        // change. Older CSVs without these columns will return -1 here and the role
        // overlay simply won't render — callers must guard with `?? null`.
        const roleCols = {
            lead:     headers.indexOf('leadscore'),
            switch:   headers.indexOf('switchscore'),
            closer:   headers.indexOf('closerscore'),
            attacker: headers.indexOf('attackerscore'),
        };
        const roleScores = { lead: {}, switch: {}, closer: {}, attacker: {} };

        // Optional threat-list columns (topMatchups / topCounters).
        // Format inside cell: `oppId:rating;oppId:rating;...`.
        // Used by the team builder to amplify shared-weakness penalties when
        // PvPoke's published list confirms a meta threat beats 2+ team mons.
        const matchupsCol = headers.indexOf('topmatchups');
        const countersCol = headers.indexOf('topcounters');
        const threatLists = {};

        const rankMap = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            const id = cols[idCol];
            if (id) {
                // Normalize display-format IDs (e.g. "Stunfisk (Galarian)" → "stunfisk_galarian")
                // so Fantasy Cup CSV keys match internal species IDs used everywhere else.
                const hasShadow = /shadow/i.test(id);
                const baseNormalId = normalizeId(id).replace(/_shadow$/i, '');
                const finalId = hasShadow ? baseNormalId + '_shadow' : baseNormalId;
                if (finalId) {
                    rankMap[finalId] = i - 1; // zero-based rank index
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
                        if (matchups.length || counters.length) {
                            threatLists[finalId] = { matchups, counters };
                        }
                    }
                }
            }
        }

        rankingsCache[formatKey]    = rankMap;
        roleScoresCache[formatKey]  = roleScores;
        threatListsCache[formatKey] = threatLists;
        return rankMap;
    })();

    return rankingsLoading[formatKey];
}

/**
 * Parse a packed PvPoke threat list cell (`oppId:rating;oppId:rating;...`)
 * into an array of { opp, rating } objects.  Empty / malformed cells return [].
 */
function parseThreatList(raw) {
    if (!raw) return [];
    const out = [];
    for (const pair of String(raw).split(';')) {
        if (!pair) continue;
        const idx = pair.indexOf(':');
        if (idx <= 0) continue;
        const opp = pair.slice(0, idx).trim();
        const rating = parseInt(pair.slice(idx + 1), 10);
        if (opp && Number.isFinite(rating)) out.push({ opp, rating });
    }
    return out;
}

/**
 * Look up PvPoke's published top matchups / counters for a species.
 *
 *   matchups = opponents THIS species beats (rating > 500)
 *   counters = opponents THAT BEAT this species (rating < 500)
 *
 * Returns null when no threat-list data is available for this league
 * (older CSV, untracked cup, or unknown species).  Shadow forms fall back
 * to the base form's lists.
 */
function getThreats(speciesId, formatKey) {
    const lists = threatListsCache[String(formatKey)];
    if (!lists) return null;
    return lists[speciesId]
        || (speciesId.endsWith('_shadow') ? lists[speciesId.replace(/_shadow$/, '')] : null)
        || null;
}

/**
 * Look up per-role PvPoke scores (0-100) for a species in a given league/cup.
 * Returns the highest-scoring role plus the full per-role breakdown, or null
 * when role data is unavailable (older CSV, unknown species, or untracked cup).
 *
 * @param {string} speciesId — internal id (already normalized; shadow forms
 *                             with `_shadow` suffix are tried first, then the
 *                             base form as a fallback).
 * @param {string} formatKey — LEAGUE_FORMATS key, e.g. "cp1500_all".
 * @returns {{ role: string, score: number, all: {lead:number, switch:number, closer:number, attacker:number} } | null}
 */
function getBestRole(speciesId, formatKey) {
    const scores = roleScoresCache[String(formatKey)];
    if (!scores) return null;
    const lookup = id => {
        const all = {};
        let any = false;
        for (const role of ROLE_KEYS) {
            const v = scores[role][id];
            if (typeof v === 'number') { all[role] = v; any = true; }
        }
        return any ? all : null;
    };
    let all = lookup(speciesId);
    if (!all && speciesId.endsWith('_shadow')) all = lookup(speciesId.replace(/_shadow$/, ''));
    if (!all) return null;
    let bestRole = null, bestScore = -Infinity;
    for (const role of ROLE_KEYS) {
        if (typeof all[role] === 'number' && all[role] > bestScore) {
            bestScore = all[role];
            bestRole = role;
        }
    }
    return bestRole ? { role: bestRole, score: bestScore, all } : null;
}

// ─── Move CSV loader ──────────────────────────────────────────────────────────
//
// csv/moves.csv is the source of truth for all move damage / energy / turn stats.
// On startup this function fetches the CSV and overlays every entry onto the
// FAST_MOVES / CHARGED_MOVES objects that meta.js pre-populates as a fallback.
// To apply a balance patch: edit moves.csv only — no JS changes required.

/**
 * Convert a display move name to the snake_case key used throughout the app.
 *   "Air Slash"            → "air_slash"
 *   "Weather Ball (Fire)"  → "weather_ball_fire"
 *   "Power-Up Punch"       → "power_up_punch"
 *   "X-Scissor"            → "x_scissor"
 *   "Nature's Madness"     → "natures_madness"
 */
function moveNameToId(name) {
    return name.trim()
        .toLowerCase()
        .replace(/\s*\(([^)]+)\)\s*/g, '_$1')   // "(Fire)" → "_fire"
        .replace(/['\u2019]/g, '')               // remove apostrophes
        .replace(/[-\s]+/g, '_')                 // hyphens / spaces → _
        .replace(/[^a-z0-9_]/g, '')              // strip remaining punctuation
        .replace(/_+/g, '_')                     // collapse repeated _
        .replace(/^_|_$/g, '');                  // trim leading/trailing _
}

// Aliases: a gamemaster move ID maps to a legacy ID that movesets still reference.
// Both keys are kept alive so nothing breaks.
const MOVE_ID_ALIASES = {
    'mystical_fire': 'mystic_fire',   // PvPoke MYSTICAL_FIRE → keep legacy key too
    'super_power':   'superpower',    // PvPoke SUPER_POWER  → keep legacy key too
    'vice_grip':     'vise_grip',     // PvPoke VICE_GRIP    → keep legacy key too
};

// Aliases: scanner app species names that differ from PvPoke's speciesId.
// After loadPokemon() runs, each alias key is copied from its canonical value
// so stat/type lookups succeed for both naming conventions.
const POKEMON_ID_ALIASES = {
    'cherrim_sunshine':       'cherrim_sunny',               // CalcyIV calls it sunshine
    'darmanitan_galarian':    'darmanitan_galarian_standard', // omits "standard" form suffix
    'dudunsparce_two_segment':'dudunsparce',                  // PvPoke uses un-suffixed ID
    'mareani':                'mareanie',                     // common misspelling in scanners
};

// ── loadMoves ─────────────────────────────────────────────────────────────────
// Priority: data/moves.json (PvPoke gamemaster, auto-updated by CI)
//         → csv/moves.csv  (legacy fallback — kept for offline/dev use)

let movesLoaded = false;
let movesLoadingPromise = null;

/**
 * Apply a single moves.json entry (PvPoke gamemaster format) to FAST_MOVES,
 * CHARGED_MOVES, and MOVE_EFFECTS.  Returns 'fast' | 'charged'.
 *
 *  Fast:    { moveId, type, power, energyGain, turns }
 *  Charged: { moveId, type, power, energy, buffs?, buffTarget?, buffApplyChance? }
 *
 * MOVE_EFFECTS mapping from PvPoke format → our format:
 *   buffTarget "self"     + positive buffs → selfBuff
 *   buffTarget "self"     + negative buffs → selfDebuff
 *   buffTarget "opponent" + negative buffs → oppDebuff
 *   buffApplyChance (string) → chance (float)
 */
function applyGamemasterMove(entry) {
    // PvPoke uses SCREAMING_SNAKE_CASE — convert to snake_case
    const id   = entry.moveId.toLowerCase();
    const type = (entry.type || 'normal').toLowerCase();
    const pow  = entry.power || 0;
    const alias = MOVE_ID_ALIASES[id];

    // Charged moves always have energy > 0 (cost to fire).
    // Fast moves and TRANSFORM have energy === 0 (generate or gain nothing).
    const isFast = !entry.energy;

    if (isFast) {
        const nrg   = entry.energyGain || 0;
        const turns = entry.turns || 1;
        if (typeof CHARGED_MOVES !== 'undefined') delete CHARGED_MOVES[id];
        if (typeof FAST_MOVES !== 'undefined') {
            FAST_MOVES[id] = { type, pow, nrg, turns };
            if (alias) FAST_MOVES[alias] = FAST_MOVES[id];
        }
        return 'fast';
    } else {
        const nrg = entry.energy || 0;
        if (typeof FAST_MOVES !== 'undefined') delete FAST_MOVES[id];
        if (typeof CHARGED_MOVES !== 'undefined') {
            CHARGED_MOVES[id] = { type, pow, nrg };
            if (alias) CHARGED_MOVES[alias] = CHARGED_MOVES[id];
        }

        // Populate MOVE_EFFECTS if this move has stat-change buffs
        if (entry.buffs && typeof MOVE_EFFECTS !== 'undefined') {
            const [atkStg, defStg] = entry.buffs;
            const chance = parseFloat(entry.buffApplyChance) || 0;
            if (chance > 0 && (atkStg !== 0 || defStg !== 0)) {
                const effect = { chance };
                if (entry.buffTarget === 'self') {
                    // positive = buff (e.g. Power-Up Punch), negative = self-debuff (e.g. Overheat)
                    const key = (atkStg >= 0 && defStg >= 0) ? 'selfBuff' : 'selfDebuff';
                    effect[key] = [atkStg, defStg];
                } else {
                    // opponent target — almost always a debuff
                    effect.oppDebuff = [atkStg, defStg];
                }
                MOVE_EFFECTS[id] = effect;
                if (alias) MOVE_EFFECTS[alias] = effect;
            }
        }

        return 'charged';
    }
}

async function loadMoves() {
    if (movesLoaded) return;
    if (movesLoadingPromise) return movesLoadingPromise;

    movesLoadingPromise = (async () => {
        // ── Try gamemaster JSON first ─────────────────────────────────────
        try {
            const resp = await fetch('./data/moves.json');
            if (resp.ok) {
                const entries = await resp.json();
                if (Array.isArray(entries) && entries.length > 0) {
                    let fast = 0, charged = 0;
                    for (const entry of entries) {
                        const kind = applyGamemasterMove(entry);
                        if (kind === 'fast') fast++;
                        else if (kind === 'charged') charged++;
                    }
                    console.log(`[moves] loaded ${fast} fast + ${charged} charged from data/moves.json`);
                    movesLoaded = true;
                    return;
                }
            }
        } catch (e) { /* fall through */ }

        // ── Fallback: csv/moves.csv ───────────────────────────────────────
        try {
            const resp = await fetch('./csv/moves.csv');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            const lines = text.trim().split(/\r?\n/);
            if (lines.length < 2) throw new Error('empty');

            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            const ci = n => headers.indexOf(n);
            const iName = ci('move'), iType = ci('type'), iCat = ci('category');
            const iDmg = ci('damage'), iNrg = ci('energy'), iTurns = ci('turns');

            let fast = 0, charged = 0;
            for (let i = 1; i < lines.length; i++) {
                const p = lines[i].split(',').map(s => s.trim());
                const rawName = p[iName]; if (!rawName) continue;
                const id    = moveNameToId(rawName);
                const type  = (p[iType] || '').toLowerCase();
                const cat   = p[iCat] || '';
                const pow   = parseInt(p[iDmg],   10) || 0;
                const nrg   = parseInt(p[iNrg],   10) || 0;
                const turns = parseInt(p[iTurns],  10) || 0;
                const alias = MOVE_ID_ALIASES[id];
                if (cat === 'Fast Attack') {
                    if (typeof CHARGED_MOVES !== 'undefined') delete CHARGED_MOVES[id];
                    if (typeof FAST_MOVES !== 'undefined') {
                        FAST_MOVES[id] = { type, pow, nrg, turns };
                        if (alias) FAST_MOVES[alias] = FAST_MOVES[id];
                        fast++;
                    }
                } else if (cat === 'Charged Attack') {
                    if (typeof FAST_MOVES !== 'undefined') delete FAST_MOVES[id];
                    if (typeof CHARGED_MOVES !== 'undefined') {
                        CHARGED_MOVES[id] = { type, pow, nrg };
                        if (alias) CHARGED_MOVES[alias] = CHARGED_MOVES[id];
                        charged++;
                    }
                }
            }
            console.log(`[moves] loaded ${fast} fast + ${charged} charged from csv/moves.csv`);
        } catch (e) {
            console.warn('[moves] could not load move data — using meta.js built-ins:', e.message);
        }

        movesLoaded = true;
    })();

    return movesLoadingPromise;
}

// ── loadPokemon ──────────────────────────────────────────────────────────────
// Loads pokemon.json (PvPoke gamemaster) and populates POKEMON_MOVESETS.
// Falls back to data.js / meta.js built-ins if the file isn't present.
//
// Populates from data/pokemon.json (one fetch, four data structures):
//   POKEMON_STATS    [atk, def, hp]          — replaces data.js hardcoding (~1155 entries)
//   POKEMON_TYPES    ['type1', 'type2']       — replaces meta.js hardcoding (~1155 entries)
//   EVOLUTIONS       { id: [nextEvoIds] }     — replaces data.js hardcoding (~456 entries)
//   POKEMON_MOVESETS { fast, charged, elite } — replaces meta.js 132-entry list with 700+

let pokemonLoaded = false;
let pokemonLoadingPromise = null;

async function loadPokemon() {
    if (pokemonLoaded) return;
    if (pokemonLoadingPromise) return pokemonLoadingPromise;

    pokemonLoadingPromise = (async () => {
        try {
            // Moves must be loaded first so we can classify elite moves below
            await loadMoves();

            const resp = await fetch('./data/pokemon.json');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const entries = await resp.json();
            if (!Array.isArray(entries) || entries.length === 0)
                throw new Error('empty or non-array');

            const toId = s => s.toLowerCase(); // SCREAMING_SNAKE → snake_case

            let count = 0;
            for (const p of entries) {
                if (!p.speciesId) continue;
                const id = p.speciesId; // already snake_case in PvPoke

                // ── baseStats → POKEMON_STATS ─────────────────────────────
                if (p.baseStats && typeof POKEMON_STATS !== 'undefined') {
                    POKEMON_STATS[id] = [p.baseStats.atk, p.baseStats.def, p.baseStats.hp];
                }

                // ── types → POKEMON_TYPES ─────────────────────────────────
                if (p.types && typeof POKEMON_TYPES !== 'undefined') {
                    // PvPoke uses "none" for single-type; we use a 1-element array
                    const types = p.types.filter(t => t !== 'none');
                    if (types.length) POKEMON_TYPES[id] = types;
                }

                // ── family.evolutions → EVOLUTIONS ────────────────────────
                if (p.family?.evolutions?.length && typeof EVOLUTIONS !== 'undefined') {
                    EVOLUTIONS[id] = p.family.evolutions; // already snake_case
                }

                // ── fastMoves / chargedMoves / eliteMoves → POKEMON_MOVESETS
                if (typeof POKEMON_MOVESETS !== 'undefined') {
                    const fast    = (p.fastMoves    || []).map(toId);
                    const charged = (p.chargedMoves || []).map(toId);
                    const elite   = (p.eliteMoves   || []).map(toId);

                    // Elite moves are additional moves (require Elite TM) that
                    // PvPoke lists separately from fastMoves/chargedMoves.
                    // Classify each by checking the move dicts so the scoring
                    // engine can consider them.
                    for (const eid of elite) {
                        if (FAST_MOVES[eid] !== undefined) {
                            if (!fast.includes(eid)) fast.push(eid);
                        } else if (CHARGED_MOVES[eid] !== undefined) {
                            if (!charged.includes(eid)) charged.push(eid);
                        }
                        // If not in either dict yet, leave it only in elite[]
                        // (may be a future/unreleased move)
                    }

                    POKEMON_MOVESETS[id] = { fast, charged, elite };
                }

                count++;
            }
            // ── Apply species ID aliases ──────────────────────────────────
            // Some scanner apps produce names that differ from PvPoke's IDs.
            // Copy the canonical entry under each alias key so lookups succeed.
            for (const [alias, canonical] of Object.entries(POKEMON_ID_ALIASES)) {
                if (POKEMON_STATS[canonical])    POKEMON_STATS[alias]    = POKEMON_STATS[canonical];
                if (POKEMON_TYPES[canonical])    POKEMON_TYPES[alias]    = POKEMON_TYPES[canonical];
                if (POKEMON_MOVESETS[canonical]) POKEMON_MOVESETS[alias] = POKEMON_MOVESETS[canonical];
                if (EVOLUTIONS[canonical])       EVOLUTIONS[alias]       = EVOLUTIONS[canonical];
            }

            console.log(`[pokemon] loaded ${count} species from data/pokemon.json`);
        } catch (e) {
            console.warn('[pokemon] could not load pokemon.json:', e.message);
        }
        pokemonLoaded = true;
    })();

    return pokemonLoadingPromise;
}

function setRankStatusDisplay(state, message) {
    const el = document.getElementById('rank-status');
    el.className = `rank-status rank-${state}`;
    el.textContent = message;
}

async function onLeagueChange() {
    const { key } = getSelectedLeagueInfo();

    // Clear stale analysis box so Box Builder re-runs analysis for the new league
    lastAnalysisBox    = new Set();
    lastAnalysisBox98  = new Set();

    // Clear any previous output that was rendered for the old league
    const outEl   = document.getElementById('out');
    const boxOut  = document.getElementById('box-out');
    const metaOut = document.getElementById('meta-out');
    if (outEl)   outEl.innerHTML   = '';
    if (boxOut)  boxOut.innerHTML  = '';
    if (metaOut) metaOut.innerHTML = '';

    if (rankingsCache[key]) { setRankStatusDisplay('ok', 'Rankings loaded ✓'); return; }
    setRankStatusDisplay('loading', 'Loading rankings…');
    try {
        await loadRankings(key);
        setRankStatusDisplay('ok', 'Rankings loaded ✓');
    } catch (err) {
        setRankStatusDisplay('err', 'Rankings unavailable');
        console.warn('Could not load rankings:', err);
    }
}

// Pre-load move stats and pokemon data on page open.
// loadMoves() must complete before any battle simulation runs so that
// move data is in place before the user clicks Analyze.
// Rankings are loaded separately via initLeagues() + onLeagueChange() in index.html.
(async () => {
    await Promise.all([loadMoves(), loadPokemon()]);
})();


// ─── Species ID normalisation ─────────────────────────────────────────────────

/**
 * Convert a raw Pokémon name (as CalcyIV exports it) to the snake_case
 * speciesId used as keys in POKEMON_STATS and EVOLUTIONS.
 *
 * Steps:
 *   1. Lowercase + strip accents (é → e, fixes Flabébé etc.)
 *   2. Gender symbols → _female / _male
 *   3. Strip the word "shadow" (shadow forms share base stats)
 *   4. Normalise regional/form aliases (galar → galarian, etc.)
 *   5. Collapse spaces and hyphens to underscores
 *   6. If the first word is a form prefix (galarian, alolan…), move it to the end
 *      so the base species name comes first: galarian_slowpoke → slowpoke_galarian
 */
function normalizeId(name) {
    let normalized = name.toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/♀/g, '_female').replace(/♂/g, '_male')
        .replace(/\bshadow\b/gi, '').trim()
        .replace(/\b(galarian|galar)\b/g, 'galarian')
        .replace(/\b(alolan|alola)\b/g,   'alolan')
        .replace(/\b(hisuian|hisui)\b/g,  'hisuian')
        .replace(/\b(paldean|paldea)\b/g, 'paldean')
        .replace(/\beast sea\b/g, 'east').replace(/\bwest sea\b/g, 'west')
        .replace(/-/g, '_')
        .replace(/[^a-z0-9_\s]/g, '').trim()
        .replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

    const parts = normalized.split('_');
    if (parts.length > 1 && FORM_PREFIXES.has(parts[0])) {
        normalized = parts.slice(1).concat(parts[0]).join('_');
    }
    return normalized;
}

/** Returns true if this Pokémon is a shadow form, based on its name or the
 *  ShadowForm column value from the CalcyIV CSV. */
function isShadowPokemon(name, shadowFormValue) {
    // In the CalcyIV/GoIV CSV format: ShadowForm=1 = Normal, ShadowForm=2 = Shadow
    return shadowFormValue === '2'
        || shadowFormValue === 'true'
        || shadowFormValue === 'shadow'
        || /\bshadow\b/i.test(name);
}

/**
 * Split a species ID that may carry a _shadow suffix into its components.
 * Used throughout the battle sim so shadow variants can share the same
 * base-stat data while receiving the 1.2× ATK / 0.833× DEF multipliers.
 *
 * @param {string} id  e.g. "galvantula_shadow" or "galvantula"
 * @returns {{ baseId: string, isShadow: boolean }}
 */
function parseShadowId(id) {
    if (typeof id === 'string' && id.endsWith('_shadow')) {
        return { baseId: id.slice(0, -7), isShadow: true };
    }
    return { baseId: id, isShadow: false };
}

/** Look up base stats [attack, defense, stamina] for a species.
 *  Falls back to the base form (before the first underscore) if the
 *  exact key isn't found — covers minor form variants. */
function lookupStats(speciesId) {
    const { baseId } = parseShadowId(speciesId);
    return POKEMON_STATS[baseId] || POKEMON_STATS[baseId.split('_')[0]] || null;
}

/** Convert a speciesId back to a human-readable title-case name. */
function toTitleCase(speciesId) {
    return speciesId.replace(/_/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
}


// ─── Core PvP calculations ────────────────────────────────────────────────────

/**
 * Combat Power formula (matches the official Niantic formula exactly).
 * CP = floor( atkTotal * sqrt(defTotal) * sqrt(staTotal) * cpm² / 10 ), min 10.
 */
function calcCp(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, level) {
    const cpm = CPM[level];
    return Math.max(10, Math.floor(
        (baseAtk + atkIv) * Math.sqrt(baseDef + defIv) * Math.sqrt(baseSta + staIv) * cpm * cpm / 10
    ));
}

/**
 * Stat product — the PvP optimisation metric.
 * Shadow Pokémon have a 1.2× attack bonus and 5/6 defence bonus baked in.
 * STA is floored (matches how in-game HP is truncated).
 */
function calcStatProduct(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, level, shadow) {
    const cpm        = CPM[level];
    const atkBonus   = shadow ? 1.2 : 1;
    const defPenalty = shadow ? 5 / 6 : 1;
    return (baseAtk + atkIv) * cpm * atkBonus
         * (baseDef + defIv) * cpm * defPenalty
         * Math.floor((baseSta + staIv) * cpm);
}

/**
 * Binary search for the highest level index where CP ≤ cpCap.
 * @param {number} maxLevelIdx  Upper bound index into LEVELS[].
 * @returns {number} Index into LEVELS[] of the optimal level.
 */
function findOptimalLevelIdx(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, cpCap, maxLevelIdx) {
    let lo = 0, hi = maxLevelIdx;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (calcCp(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, LEVELS[mid]) <= cpCap) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

/**
 * Compute the GL rank result for a given Pokémon and IV combination.
 * Exhaustively compares all 4096 IV combinations to determine rank.
 *
 * @returns {{ rank, statProduct, pct, optLevel, maxCp }}
 */
function computeRankResult(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, cpCap, maxLevelIdx, shadow) {
    const optLevelIdx    = findOptimalLevelIdx(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, cpCap, maxLevelIdx);
    const optLevel       = LEVELS[optLevelIdx];
    const myStatProduct  = calcStatProduct(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, optLevel, shadow);
    const maxCp          = calcCp(baseAtk, baseDef, baseSta, atkIv, defIv, staIv, optLevel);

    let rank = 1, bestStatProduct = 0;
    for (let atkIv2 = 0; atkIv2 <= 15; atkIv2++) {
        for (let defIv2 = 0; defIv2 <= 15; defIv2++) {
            for (let staIv2 = 0; staIv2 <= 15; staIv2++) {
                const candidateLevel = LEVELS[findOptimalLevelIdx(
                    baseAtk, baseDef, baseSta, atkIv2, defIv2, staIv2, cpCap, maxLevelIdx
                )];
                const candidateSp = calcStatProduct(
                    baseAtk, baseDef, baseSta, atkIv2, defIv2, staIv2, candidateLevel, shadow
                );
                if (candidateSp > bestStatProduct) bestStatProduct = candidateSp;
                if (candidateSp > myStatProduct)   rank++;
            }
        }
    }

    return {
        rank,
        statProduct: myStatProduct,
        pct: myStatProduct / bestStatProduct * 100,
        optLevel,
        maxCp,
    };
}

/**
 * Find all valid STA IVs (0–15) that produce the observed in-game HP at a
 * given level. Usually returns exactly one value, but two adjacent IVs can
 * produce the same floored HP (e.g. Talonflame STA IV 9 and 10 both give
 * HP 107 at level 17). Returns null if HP or level data is unavailable.
 */
function findValidStaIvs(baseSta, targetHp, level) {
    const cpm = CPM[level];
    if (!cpm || !(targetHp > 0)) return null;
    const valid = [];
    for (let staIv = 0; staIv <= 15; staIv++) {
        if (Math.floor((baseSta + staIv) * cpm) === targetHp) valid.push(staIv);
    }
    return valid.length ? valid : null;
}


// ─── Evolution chain helper ───────────────────────────────────────────────────

/**
 * Return the full evolution chain starting from speciesId, including itself.
 * Handles branching evolutions (Eevee, Applin, etc.) and guards against cycles.
 */
function getEvolutionChain(speciesId, visited = new Set()) {
    if (visited.has(speciesId)) return [];
    visited.add(speciesId);
    const chain = [speciesId];
    for (const nextEvolution of (EVOLUTIONS[speciesId] || [])) {
        chain.push(...getEvolutionChain(nextEvolution, visited));
    }
    return chain;
}


// ─── CSV parsing ─────────────────────────────────────────────────────────────

/**
 * Normalise a raw CSV header for fuzzy matching:
 *   - lowercase
 *   - strip accents (Ø → o, é → e, etc.)
 *   - remove every character that isn't a letter, digit, or space
 *   - collapse whitespace to a single space
 * This lets us match "ØATT IV", "ØAtk IV", "atk iv", "ATK_IV" all the same way.
 */
function normalizeHeader(h) {
    return h.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip combining accents
        .replace(/[^a-z0-9 ]/g, ' ')                      // non-alphanum → space
        .replace(/\s+/g, ' ').trim();
}

/**
 * Scan normalised headers for the first one that matches a test function.
 * Returns the column index, or -1 if not found.
 */
function scanHeader(normHeaders, testFn) {
    return normHeaders.findIndex(testFn);
}

/**
 * Parse a CalcyIV CSV export into an array of row objects.
 * Headers are scanned with pattern matching so any column order,
 * delimiter, accent variant, or CalcyIV version is handled automatically.
 * Supports both comma and semicolon delimiters.
 */
function parseCalcyIvExport(text) {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { rows: [], err: 'Need header + data rows.' };

    const delimiter  = lines[0].includes(';') ? ';' : ',';
    const rawHeaders = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
    const norm       = rawHeaders.map(normalizeHeader);

    // Helper: does the normalised header contain all of these word fragments?
    const has  = (h, ...words) => words.every(w => h.includes(w));
    // Helper: does it match this regex?
    const re   = (h, rx)       => rx.test(h);

    // ── Locate each column by scanning normalised headers ──────────────────
    // Required
    const nameCol = scanHeader(norm, h =>
        h === 'name' || h === 'pokemon' || h === 'species' || h === 'mon');

    // IV columns: look for headers that mention the stat AND "iv"
    // "ØATT IV" → "oatt iv", "ATK IV" → "atk iv", "Attack IV" → "attack iv"
    const atkIvCol = scanHeader(norm, h =>
        has(h, 'iv') && re(h, /\b(att|atk|attack)\b/));

    const defIvCol = scanHeader(norm, h =>
        has(h, 'iv') && re(h, /\b(def|defense|defence)\b/));

    // STA/HP IV — must contain "iv" and a stamina/hp keyword,
    // but must NOT match the ATK or DEF columns already found above
    const staIvCol = scanHeader(norm, (h, i) =>
        has(h, 'iv') && re(h, /\b(hp|sta|stam|stamina)\b/) && i !== atkIvCol && i !== defIvCol);

    // Optional
    const levelCol = scanHeader(norm, h =>
        h === 'level' || h === 'lv' || h === 'lvl' || re(h, /^level$/));

    // HP column: the raw in-game HP integer, not the HP IV.
    // It should be exactly "hp" (or very close) and NOT contain "iv".
    const hpCol = scanHeader(norm, h =>
        (h === 'hp' || re(h, /^hp$/)) && !has(h, 'iv'));

    const nicknameCol = scanHeader(norm, h =>
        h === 'nickname' || h === 'nick' || re(h, /^nickname$/));

    const shadowFormCol = scanHeader(norm, h =>
        re(h, /shadow\s*form/) || h === 'shadowform' || h === 'shadow');

    // ── Validate required columns found ────────────────────────────────────
    if (nameCol < 0) {
        return { rows: [], err: `Name column not found. Headers: ${rawHeaders.join(', ')}` };
    }
    if (atkIvCol < 0 || defIvCol < 0 || staIvCol < 0) {
        const missing = [];
        if (atkIvCol < 0) missing.push('atk IV');
        if (defIvCol < 0) missing.push('def IV');
        if (staIvCol < 0) missing.push('hp IV');
        return { rows: [], err: `IV columns not found: ${missing.join(', ')}. Found headers: ${rawHeaders.join(', ')}` };
    }

    const clamp = (n) => Math.min(15, Math.max(0, Math.floor(n)));

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
        if (cols.length < 3) continue;

        const name = cols[nameCol] || '';
        if (!name) continue;

        const atkIv = clamp(parseFloat(cols[atkIvCol]));
        const defIv = clamp(parseFloat(cols[defIvCol]));
        const staIv = clamp(parseFloat(cols[staIvCol]));
        if (isNaN(atkIv) || isNaN(defIv) || isNaN(staIv)) continue;

        const shadowFormValue = shadowFormCol >= 0 ? (cols[shadowFormCol] || '').toLowerCase() : '';

        rows.push({
            name,
            atkIv,
            defIv,
            staIv,                          // CalcyIV average STA IV (floored); may be ambiguous
            level:    levelCol    >= 0 ? parseFloat(cols[levelCol])  : null,
            hp:       hpCol       >= 0 ? parseInt(cols[hpCol])       : null,
            nickname: nicknameCol >= 0 ? cols[nicknameCol]           : '',
            shadow:   isShadowPokemon(name, shadowFormValue),
        });
    }

    return { rows, err: null };
}


// ─── UI rendering helpers ─────────────────────────────────────────────────────

/**
 * Returns the minimum IV% filter value from the UI input, or null if empty.
 * Used by run(), runMetaBreaker(), and runBoxBuilder().
 */
function getMinIvPct() {
    const el = document.getElementById('f98');
    if (!el) return null;
    const val = parseFloat(el.value);
    return isNaN(val) ? null : Math.max(0, Math.min(100, val));
}

/** Colour for the % of #1 text based on quality tier. */
function statPctColor(pct) {
    if (pct >= 98) return '#4ade80';
    if (pct >= 95) return '#60a5fa';
    if (pct >= 90) return '#fb923c';
    return '#555';
}

/** Fill colour for the stat product progress bar. */
function barFillColor(pct) {
    if (pct >= 98) return '#4ade80';
    if (pct >= 95) return '#60a5fa';
    if (pct >= 90) return '#fb923c';
    return '#444';
}

/** Render a coloured IV rank badge. */
function rankBadge(rank) {
    if (rank === 1)   return `<span class="badge badge-rank1">#1</span>`;
    if (rank <= 10)   return `<span class="badge badge-top10">#${rank}</span>`;
    if (rank <= 100)  return `<span class="badge badge-top100">#${rank}</span>`;
    return                   `<span class="badge badge-other">#${rank}</span>`;
}


// ─── Main analysis ────────────────────────────────────────────────────────────

// Species that passed 98% IV filter in the last analysis run
// Maps speciesId → best pct from the analyzer
let lastAnalysisBox = new Set();       // all species from last run
let lastAnalysisBox98 = new Set();     // species with at least one 98%+ entry

async function run() {
    const csvText     = document.getElementById('csv').value.trim();
    const { key: leagueKey, cpCap, restricted: isRestricted } = getSelectedLeagueInfo();
    const allowXl     = document.getElementById('xl').checked;
    const highestEvo  = document.getElementById('dedup').checked;
    const minIvPct    = getMinIvPct();
    const maxLevelIdx = LEVELS.indexOf(allowXl ? 50 : 40);
    const outputEl    = document.getElementById('out');

    if (!csvText) {
        outputEl.innerHTML = '<p style="color:#b4b4b4;font-size:13px;">Paste your CalcyIV export first.</p>';
        return;
    }

    const { rows, err } = parseCalcyIvExport(csvText);
    if (err) {
        outputEl.innerHTML = `<p style="color:#f87171;font-size:13px;">${err}</p>`;
        return;
    }
    if (!rows.length) {
        outputEl.innerHTML = '<p style="color:#b4b4b4;">No valid rows.</p>';
        return;
    }

    // Ensure move data from CSV is loaded before simulation
    await Promise.all([loadMoves(), loadPokemon()]);

    // Load meta rankings for the selected league
    let rankMap = {};
    try {
        rankMap = await loadRankings(leagueKey);
        setRankStatusDisplay('ok', 'Rankings loaded ✓');
    } catch (err) {
        setRankStatusDisplay('err', `Rankings unavailable — ${err.message}`);
        console.error('Rankings load failed:', err);
    }

    outputEl.innerHTML = `<p style="color:#b4b4b4;font-size:13px;">Computing ranks for ${rows.length} Pokémon…</p>`;

    // Defer the CPU-heavy rank computation so the browser can repaint first.
    // Wrapped in a promise so callers can await run() (e.g. Box Builder).
    return new Promise(resolve => { setTimeout(() => {
        // grouped: speciesId → array of result objects (one per scanned Pokémon)
        const grouped     = new Map();
        const unrecognized = [];

        for (const row of rows) {
            const speciesId = normalizeId(row.name);
            const baseStats = lookupStats(speciesId);
            if (!baseStats) {
                unrecognized.push(row);
                continue;
            }

            // ── STA IV: trust the CSV value as exact ───────────────────────
            // IVs are treated as exact inputs — no HP-based ambiguity resolution.
            const staIv = row.staIv;

            // ── Walk the evolution chain ────────────────────────────────────
            const evoChain       = getEvolutionChain(speciesId);
            const eligibleIds    = new Set();
            const candidates     = [];

            for (const evoId of evoChain) {
                const evoStats = lookupStats(evoId);
                if (!evoStats) continue;

                // Restricted cups (e.g. Fantasy Cup): only show Pokémon listed in the
                // rankings CSV. Check both the base ID and the _shadow variant.
                if (isRestricted) {
                    const cupId = row.shadow ? evoId + '_shadow' : evoId;
                    if (!(cupId in rankMap) && !(evoId in rankMap)) continue;
                }

                const [evoAtk, evoDef, evoSta] = evoStats;

                // Determine if this form is already over the CP cap at the scanned level.
                // We still include it — the GL ranking is useful for IV planning even if
                // the Pokémon can't be used at its current level. Only skip if it can never
                // be GL-legal (CP > cap even at level 1, which is essentially impossible).
                const scanCp  = (row.level != null && CPM[row.level])
                    ? calcCp(evoAtk, evoDef, evoSta, row.atkIv, row.defIv, staIv, row.level)
                    : null;
                const overCap = scanCp !== null && scanCp > cpCap;

                if (calcCp(evoAtk, evoDef, evoSta, row.atkIv, row.defIv, staIv, LEVELS[0]) > cpCap) {
                    continue; // truly unplayable at any level
                }

                eligibleIds.add(evoId);
                candidates.push({ evoId, isSelf: evoId === speciesId, stats: evoStats, overCap });
            }

            // When "Highest evo only" is checked, drop any form that has an
            // eligible evolution (show only the final form in each branch)
            const topEvoOnly = highestEvo
                ? candidates.filter(c => !(EVOLUTIONS[c.evoId] || []).some(next => eligibleIds.has(next)))
                : candidates;
            const finalCandidates = topEvoOnly.length ? topEvoOnly : candidates;

            // ── Compute rank results ────────────────────────────────────────
            for (const { evoId, isSelf, stats: [evoAtk, evoDef, evoSta], overCap } of finalCandidates) {
                const rankResult = computeRankResult(evoAtk, evoDef, evoSta, row.atkIv, row.defIv, staIv, cpCap, maxLevelIdx, row.shadow);

                if (!grouped.has(evoId)) grouped.set(evoId, []);
                grouped.get(evoId).push({ row, staIv, rankResult, isSelf, overCap });
            }
        }

        // Sort each group by IV rank ascending (best first)
        for (const entries of grouped.values()) {
            entries.sort((a, b) => a.rankResult.rank - b.rankResult.rank);
        }

        // Sort groups: first by meta rank (best meta Pokémon first), then by IV rank
        const sortedGroups = [...grouped.entries()].map(([evoId, entries]) => ({
            evoId,
            entries,
            metaRank: rankMap[evoId] ?? Infinity,
            bestIvRank: entries[0].rankResult.rank,
        }));
        sortedGroups.sort((a, b) =>
            a.metaRank !== b.metaRank ? a.metaRank - b.metaRank : a.bestIvRank - b.bestIvRank
        );

        // ── Summary counters & populate box sets for Box Builder ─────────
        // Box sets use a _shadow suffix for shadow Pokémon so the battle sim
        // can apply the correct 1.2× ATK / 0.833× DEF multipliers per entry.
        lastAnalysisBox = new Set();
        lastAnalysisBox98 = new Set();
        let totalCount = 0, count95pct = 0, count98pct = 0, countMinPct = 0, rank1Count = 0;
        for (const { evoId, entries } of sortedGroups) {
            const hasShadow    = entries.some(e => e.row.shadow);
            const hasNonShadow = entries.some(e => !e.row.shadow);
            if (hasNonShadow) lastAnalysisBox.add(evoId);
            if (hasShadow)    lastAnalysisBox.add(evoId + '_shadow');
            for (const entry of entries) {
                totalCount++;
                if (entry.rankResult.pct >= 95) count95pct++;
                if (entry.rankResult.pct >= 98) count98pct++;
                // Track species that pass the active min IV% filter (or 98% default)
                const filterThreshold = minIvPct != null ? minIvPct : 98;
                if (entry.rankResult.pct >= filterThreshold) {
                    if (minIvPct != null) countMinPct++;
                    if (entry.row.shadow) lastAnalysisBox98.add(evoId + '_shadow');
                    else                  lastAnalysisBox98.add(evoId);
                }
                if (entry.rankResult.rank === 1) rank1Count++;
            }
        }

        // ── Pre-build meta entries for breakpoint calculator ─────────────
        // Top 5 meta Pokémon (by rank), used in computeBreakpoints below.
        const bpMetaEntries = Object.entries(rankMap)
            .sort(([,a],[,b]) => a - b)
            .slice(0, 5)
            .map(([id], i) => ({
                id,
                types: (typeof POKEMON_TYPES !== 'undefined' ? POKEMON_TYPES[id] : null) || ['normal'],
                weight: 5 - i,
            }));

        // ── Build HTML ────────────────────────────────────────────────────
        const minPctCard = minIvPct != null
            ? `<div class="card"><div class="card-label">${minIvPct}%+ quality</div><div class="card-value">${countMinPct}</div></div>`
            : `<div class="card"><div class="card-label">98%+ quality</div><div class="card-value">${count98pct}</div></div>
                <div class="card"><div class="card-label">95%+ quality</div><div class="card-value">${count95pct}</div></div>`;
        let html = `
            <div class="cards">
                <div class="card"><div class="card-label">Species groups</div><div class="card-value">${sortedGroups.length}</div></div>
                <div class="card"><div class="card-label">Total entries</div><div class="card-value">${totalCount}</div></div>
                ${minPctCard}
                <div class="card"><div class="card-label">Rank 1 IVs</div><div class="card-value">${rank1Count}</div></div>
            </div>`;

        for (const { evoId, entries, metaRank } of sortedGroups) {
            // Apply min IV% filter
            const visibleEntries = minIvPct != null ? entries.filter(e => e.rankResult.pct >= minIvPct) : entries;
            if (!visibleEntries.length) continue;

            const isMetaRanked = metaRank < Infinity;
            const metaLabel = isMetaRanked
                ? `<span class="meta-rank">Meta #${metaRank + 1}</span>`
                : `<span class="meta-unranked">Unranked</span>`;
            const bestBadge = rankBadge(visibleEntries[0].rankResult.rank);
            const candidateWord = visibleEntries.length === 1 ? 'candidate' : 'candidates';

            // Per-role score overlay — best role gets primary styling, others
            // appear in a tooltip so the header stays compact.
            const roleInfo = getBestRole(evoId, leagueKey);
            const roleLabel = roleInfo
                ? (() => {
                    const tooltip = ROLE_KEYS
                        .map(r => `${ROLE_LABELS[r]} ${typeof roleInfo.all[r] === 'number' ? roleInfo.all[r].toFixed(1) : '—'}`)
                        .join(' · ');
                    return `<span class="role-badge role-${roleInfo.role}" title="${tooltip}">${ROLE_LABELS[roleInfo.role]} ${roleInfo.score.toFixed(0)}</span>`;
                })()
                : '';

            html += `
                <div class="group">
                    <div class="group-header">
                        <span class="group-name">${toTitleCase(evoId)}</span>
                        ${metaLabel}
                        ${roleLabel}
                        <span class="group-count">${visibleEntries.length} ${candidateWord} · best IV ${bestBadge}</span>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>IV rank</th>
                                <th>IVs (A/D/S)</th>
                                <th>Opt level</th>
                                <th>Max CP</th>
                                <th>Stat product</th>
                                <th>% of #1</th>
                                <th>Source</th>
                            </tr>
                        </thead>
                        <tbody>`;

            for (const { row, staIv, rankResult, isSelf, overCap } of visibleEntries) {
                const { rank, statProduct, pct, optLevel, maxCp } = rankResult;

                const shadowTag   = row.shadow ? '<span class="tag-shadow">shadow</span>' : '';
                const evoTag      = !isSelf    ? '<span class="tag-evo">evo</span>'       : '';
                const overCapTag  = overCap
                    ? '<span class="tag-overcap" title="Already over GL cap at scanned level — GL rank shown for IV planning">over cap</span>'
                    : '';
                const nicknameTag = row.nickname ? ` <span class="nickname">(${row.nickname})</span>` : '';

                const ivCellContent = `${row.atkIv}/${row.defIv}/${staIv}`;
                const cpCellContent = maxCp;

                html += `
                            <tr>
                                <td>${rankBadge(rank)}</td>
                                <td style="font-family:monospace;font-size:11px;">${ivCellContent}</td>
                                <td>${optLevel}</td>
                                <td>${cpCellContent}</td>
                                <td>
                                    <div style="font-size:11px;">${Math.round(statProduct).toLocaleString()}</div>
                                    <div class="stat-bar">
                                        <div class="stat-bar-fill" style="width:${Math.min(100, pct).toFixed(1)}%;background:${barFillColor(pct)};"></div>
                                    </div>
                                </td>
                                <td><span style="font-weight:500;color:${statPctColor(pct)};">${pct.toFixed(1)}%</span></td>
                                <td style="font-size:11px;">${toTitleCase(normalizeId(row.name))}${shadowTag}${evoTag}${overCapTag}${nicknameTag}</td>
                            </tr>`;
            }

            html += `       </tbody>
                    </table>`;

            // ── Breakpoint analysis for best entry in this group ──────────────
            // Show breakpoints vs. top 5 meta for the highest-IV entry.
            if (isMetaRanked && visibleEntries.length > 0) {
                const bestEntry = visibleEntries[0]; // already sorted by rank
                const bps = computeBreakpoints(bestEntry.row, cpCap, bpMetaEntries);
                if (bps && bps.length > 0) {
                    const anyFlag = bps.some(b => b.atBreakpoint || b.atBulkpoint);
                    if (anyFlag) {
                        html += `<div style="margin:6px 0 0;padding:6px 8px;background:#0f172a;border-radius:4px;border:1px solid #1e293b;font-size:10px;">`;
                        html += `<span style="color:#94a3b8;font-weight:600;">Breakpoints (best entry vs. top meta):</span> `;
                        for (const bp of bps) {
                            if (!bp.atBreakpoint && !bp.atBulkpoint) continue;
                            const flags = [];
                            if (bp.atBreakpoint) flags.push(`<span style="color:#f87171;" title="Your ATK IV deals ${bp.userDmg} fast dmg, rank-1 deals ${bp.r1Dmg}. KO in ${bp.userMovesToKo} vs ${bp.r1MovesToKo} fast moves.">ATK ▲</span>`);
                            if (bp.atBulkpoint)  flags.push(`<span style="color:#fb923c;" title="Your DEF IV survives fewer of ${toTitleCase(bp.oppId)}'s fast moves than rank-1 would.">DEF ▼</span>`);
                            html += `<span style="margin-right:8px;"><span style="color:#cbd5e1;">${toTitleCase(bp.oppId)}</span> ${flags.join(' ')}</span>`;
                        }
                        html += `</div>`;
                    }
                }
            }

            html += `</div>`;
        }

        if (unrecognized.length) {
            const uniqueNames = [...new Set(unrecognized.map(r => r.name))];
            html += `<div class="warn"><b>${unrecognized.length} unrecognized (${uniqueNames.length} unique):</b> ${uniqueNames.join(' · ')}</div>`;
        }

        outputEl.innerHTML = html;
        resolve();
    }, 30); });
}


// ─── Demo data ────────────────────────────────────────────────────────────────

function demo() {
    // CP and HP values are computed from the app's own formula so they match exactly.
    // Haunter (lv28) demonstrates the "over cap" tag: Gengar at lv28 exceeds 1500 CP
    // but the app still shows Gengar's GL ranking (optimal lv19, CP 1488) for IV planning.
    // Wooper demonstrates branching evolutions: shows both Quagsire and Clodsire.
    const headerRow = [
        'scan date', 'nr', 'name', 'temp evo', 'gender', 'nickname',
        'level', 'possiblelevels', 'cp', 'hp', 'dust cost',
        'min iv%', 'øiv%', 'max iv%', 'øatt iv', 'ødef iv', 'øhp iv',
        'unique?', 'fast move', 'fast move (id)', 'special move', 'special move (id)',
        'special move 2', 'special move 2 (id)', 'dps',
        'gl evo', 'gl rank (min)', 'gl rank (max)',
        'box', 'custom1', 'custom2', 'saved', 'egg', 'lucky?', 'favorite', 'buddyboosted',
        'form', 'shadowform', 'multiform?', 'dynamax',
        'height (cm)', 'weight (g)', 'height tag', 'catch date', 'catch level',
    ].join(',');

    // Columns 0–16 carry data; columns 17–36 are empty (20 placeholders); column 37 = shadowform
    const dataRows = [
        '2025-01-10,618,Galarian Stunfisk,,,stunfisk,26.5,,1497,173,,,,,2,15,13,,,,,,,,,,,,,,,,,,,,,0',
        '2025-01-15,205,Forretress,,,forret,25.5,,1487,126,,,,,4,5,6,,,,,,,,,,,,,,,,,,,,,0',
        '2025-01-15,184,Azumarill,,,azuma,40,,1396,189,,,,,0,14,15,,,,,,,,,,,,,,,,,,,,,0',
        '2025-01-20,93,Haunter,,,haunter,28,,1479,97,,,,,10,10,10,,,,,,,,,,,,,,,,,,,,,0',
        '2025-03-01,194,Wooper,,,wooper,40,,545,122,,,,,5,11,9,,,,,,,,,,,,,,,,,,,,,0',
    ];

    document.getElementById('csv').value = headerRow + '\n' + dataRows.join('\n');
    run();
}


// ─── Meta Breaker Engine ─────────────────────────────────────────────────────

/**
 * Score how well a Pokémon's type(s) cover the meta defensively and offensively.
 * metaTypes: array of {types: [t1, t2?], weight: number} from the top-N meta list.
 *
 * Returns { defScore, offScore, totalScore }
 *   defScore: weighted average defensive multiplier (lower = better resister)
 *   offScore: weighted average offensive multiplier (higher = better attacker)
 *   totalScore: combined (offScore / defScore)
 */
function scoreTypeCoverage(candidateTypes, moveTypes, metaEntries) {
    let defSum = 0, offSum = 0, wSum = 0;

    for (const { types: oppTypes, weight } of metaEntries) {
        // Defensive: how much damage does the opponent deal to us?
        // Assume opponent uses STAB of both its types; take the worse (higher) multiplier
        let worstIncoming = 0;
        for (const oppType of oppTypes) {
            const mult = typeEffectiveness(oppType, candidateTypes[0], candidateTypes[1] || null);
            if (mult > worstIncoming) worstIncoming = mult;
        }
        defSum += worstIncoming * weight;

        // Offensive: how much damage do our moves deal to the opponent?
        // Take the best multiplier across our move types
        let bestOutgoing = 0;
        for (const moveType of moveTypes) {
            const mult = typeEffectiveness(moveType, oppTypes[0], oppTypes[1] || null);
            if (mult > bestOutgoing) bestOutgoing = mult;
        }
        offSum += bestOutgoing * weight;

        wSum += weight;
    }

    if (wSum === 0) return { defScore: 1, offScore: 1, totalScore: 1 };
    const defScore = defSum / wSum;
    const offScore = offSum / wSum;
    return { defScore, offScore, totalScore: offScore / defScore };
}

// ─── PvP Move Scoring Engine ────────────────────────────────────────────────
// Based on competitive Great League strategy:
//   - Fast moves: balance EPT (energy) and DPT (damage). High EPT preferred
//     for shield pressure, but DPT matters for farm-down and closing power.
//   - Charged moves: bait move (cheap, low energy) + nuke (expensive, high damage).
//     Not just "2 cheapest" — teams need one shield-pressure move and one closer.
//   - STAB: 1.2x multiplier in PvP. Strongly preferred for fast move; charged
//     moves trade STAB for coverage when it hits SE against meta threats.
//   - Stat effects: Power-Up Punch, Icy Wind, etc. have enormous strategic value.
//   - Off-meta bonus: Pokémon rarely seen in rankings create information asymmetry.
// ────────────────────────────────────────────────────────────────────────────

const STAB_MULT = 1.2;

/**
 * Score a single fast move for PvP quality.
 *
 * Uses PvPoke's geometric quality form (Pokemon.js::generateMoveUsage):
 *     quality = (dpt * ept^4)^(1/5)
 * EPT is raised to the 4th power before the geometric mean — PvP rewards
 * shield pressure much more than raw fast-move chip. The `bestChargedDPE`
 * argument (optional) further scales quality: Pokemon that own a high-DPE
 * charged move reward a spam fast move more than Pokemon with mid-DPE options.
 *
 * Adds three guards the old linear blend lacked:
 *  - Viability floor: (DPT>=3 OR EPT>=3) AND DPT+EPT>=6. Caller is expected
 *    to filter `viable:false` moves but fall back if no legal move is viable.
 *  - Tempo factor: 1-turn moves get +5%, 4-5T moves get a small penalty.
 *    Carve-out for moves that are simultaneously DPT>=3.5 AND EPT>=3.5
 *    (Incinerate, Confusion, Volt Switch) — those earn their length.
 *  - STAB only multiplies DPT (energy generation is unaffected by STAB).
 */
function scoreFastMove(moveId, pokemonTypes, bestChargedDPE) {
    const fm = FAST_MOVES[moveId];
    if (!fm) return { id: moveId, score: 0, ept: 0, dpt: 0, type: 'normal', stab: false, viable: false };
    const ept = fm.nrg / fm.turns;
    const dpt = fm.pow / fm.turns;
    const stab = pokemonTypes.includes(fm.type);
    const effectiveDpt = dpt * (stab ? STAB_MULT : 1);

    // ── Viability floor ──
    // At least one dimension must clear a 3.0 baseline AND the combined
    // quality must be >= 6. Filters Pound (4.0), Take Down (4.33),
    // Zen Headbutt (4.67), Cut (5.0), Present (5.0), Rock Smash (5.33),
    // Hidden Power (5.67), Iron Tail (5.67), Struggle Bug (5.67), and below.
    const viable = (dpt >= 3.0 || ept >= 3.0) && (dpt + ept) >= 6.0;

    // ── PvPoke geometric quality ──
    // Squeeze DPT by STAB before mixing. Energy is unaffected by STAB.
    const base = Math.pow(effectiveDpt * Math.pow(ept, 4), 1 / 5);

    // ── Tempo factor ──
    // Short moves are easier to use (tighter baits, less punishable).
    // Carve-out for elite high-D/high-E moves so Incinerate isn't punished.
    const eliteBoth = dpt >= 3.5 && ept >= 3.5;
    const tempo = eliteBoth ? 1.00
        : ({ 1: 1.05, 2: 1.00, 3: 1.00, 4: 0.96, 5: 0.94 }[fm.turns] ?? 1.00);

    // ── Charged-DPE coupling (P3) ──
    // PvPoke scales fast-move usage by max(highestDPE - 1, 1). When the
    // Pokemon owns a >=2.0 DPE nuke, a spam fast move is worth noticeably
    // more than when the options are mid-DPE. Clamp 1..1.5 so the effect
    // is a nudge, not a dominant factor.
    const dpeMult = bestChargedDPE == null ? 1.0
        : Math.max(1.0, Math.min(1.5, bestChargedDPE));

    const score = base * tempo * dpeMult;
    return { id: moveId, score, ept, dpt, effectiveDpt, type: fm.type, stab, turns: fm.turns, viable };
}

/**
 * Score a single charged move for PvP quality.
 * Accounts for DPE, energy cost, STAB, and special effects (buffs/debuffs).
 */
function scoreChargedMove(moveId, pokemonTypes) {
    const cm = CHARGED_MOVES[moveId];
    if (!cm) return { id: moveId, score: 0, dpe: 0, nrg: 100, type: 'normal', stab: false, role: 'none', effectValue: 0 };
    const dpe = cm.pow / cm.nrg;
    const stab = pokemonTypes.includes(cm.type);
    const effectiveDpe = dpe * (stab ? STAB_MULT : 1);

    // Determine role: bait (<=45 energy), nuke (>=60), mid-range.
    // 45e moves (Rock Slide, Icy Wind, Aqua Tail) are fast enough to create
    // genuine shield pressure and qualify as baits alongside 35-40e moves.
    let role = 'mid';
    if (cm.nrg <= 45) role = 'bait';
    else if (cm.nrg >= 60) role = 'nuke';

    // Special effect value (stat buffs/debuffs)
    let effectValue = 0;
    const eff = typeof MOVE_EFFECTS !== 'undefined' ? MOVE_EFFECTS[moveId] : null;
    if (eff) {
        // Self ATK buff: each +1 stage = ×(4/3) ≈ +33% damage to all future moves.
        // This compounds (two PUPs ≈ ×1.78 ATK), making it the single most impactful
        // secondary effect in the game. Weight it accordingly.
        if (eff.selfBuff) {
            const [atkBuff, defBuff] = eff.selfBuff;
            effectValue += (atkBuff * 1.5 + defBuff * 0.5) * eff.chance;
        }
        // Self debuffs are a cost (Close Combat = -1 DEF, Overheat = -2 DEF)
        if (eff.selfDebuff) {
            const [atkDeb, defDeb] = eff.selfDebuff;
            effectValue += (atkDeb * 0.15 + defDeb * 0.15) * eff.chance; // negative values = penalty
        }
        // Opponent ATK debuff (-1 stage) cuts all their future fast-move damage by 25%.
        // Opponent DEF debuff (+effective DPE on your next charged move).
        if (eff.oppDebuff) {
            const [atkDeb, defDeb] = eff.oppDebuff;
            effectValue += (Math.abs(atkDeb) * 0.7 + Math.abs(defDeb) * 0.4) * eff.chance;
        }
    }

    // Composite: DPE weighted by role + effect value.
    // Nukes no longer get a raw-power bonus — DPE already captures efficiency,
    // and large raw numbers (Zap Cannon 150) shouldn't beat tighter alternatives
    // (Flash Cannon 110) purely on power.
    let score;
    if (role === 'bait') {
        score = effectiveDpe * 0.5 + (1 - cm.nrg / 80) * 0.8 + effectValue * 0.6;
    } else if (role === 'nuke') {
        score = effectiveDpe * 0.9 + effectValue * 0.3;
    } else {
        score = effectiveDpe * 0.7 + (1 - cm.nrg / 80) * 0.3 + effectValue * 0.5;
    }

    return { id: moveId, score, dpe, effectiveDpe, nrg: cm.nrg, pow: cm.pow, type: cm.type, stab, role, effectValue };
}

/**
 * Pick the optimal PvP moveset for a Pokémon: 1 fast + bait charged + nuke charged.
 * Evaluates every combination and scores based on:
 *   - Fast move quality (EPT/DPT balance)
 *   - Bait + Nuke pairing (one cheap for shield pressure, one heavy for closing)
 *   - Type coverage diversity (different types across charged moves)
 *   - STAB bonuses
 *   - Stat effect bonuses
 *   - Meta-specific SE hits when metaEntries provided
 */
function pickOptimalMoveset(speciesId, metaEntries) {
    const moveset = typeof POKEMON_MOVESETS !== 'undefined' ? POKEMON_MOVESETS[speciesId] : null;
    if (!moveset || !moveset.fast) return null;

    const eliteSet = new Set(moveset.elite || []);
    const pokemonTypes = POKEMON_TYPES[speciesId] || ['normal'];

    // Score all charged moves first so we know the Pokemon's best DPE,
    // then feed it into fast-move scoring (P3: charged-DPE coupling).
    const chargedScored = moveset.charged.map(cid => scoreChargedMove(cid, pokemonTypes)).filter(c => c.score > 0);
    if (chargedScored.length === 0) return null;
    const bestChargedDPE = Math.max(...chargedScored.map(c => c.effectiveDpe));

    // Score all fast moves with DPE coupling, then apply the viability floor.
    // Fallback: if no fast move clears the floor, keep the full list so
    // Pokemon stuck with only trash moves (e.g. Farfetch'd-class) can still
    // be evaluated — but only then.
    const fastScoredAll = moveset.fast.map(fid => scoreFastMove(fid, pokemonTypes, bestChargedDPE)).filter(f => f.score > 0);
    if (fastScoredAll.length === 0) return null;
    const fastViable = fastScoredAll.filter(f => f.viable);
    const fastScored = fastViable.length > 0 ? fastViable : fastScoredAll;

    // ── Meta offensive scoring (P5 + P9 + P10) ──
    // Split into three terms: fastOff (the fast move's meta coverage,
    // squared-then-RMSd so STAB×SE peaks dominate), c1Off and c2Off
    // (charged-move coverage, linear). Fast fires every turn and gets
    // a much bigger share of the composite than either charged move.
    const NO_META = !metaEntries || metaEntries.length === 0;
    const totalMetaW = NO_META ? 1 : metaEntries.reduce((s, e) => s + e.weight, 0) || 1;

    // RMS (root-mean-square) of the effectiveness multiplier across meta.
    // Squaring rewards peaks: a 1.92x STAB×SE hit contributes 3.69 to the
    // weighted mean, vs 1.21 for a plain 1.1x neutral hit. Taking sqrt at
    // the end keeps the resulting number in a comparable scale (~0.6–1.3).
    function fastMetaRms(moveType) {
        if (NO_META) return 1.0;
        const stab = pokemonTypes.includes(moveType);
        let sum = 0;
        for (const { types: oppTypes, weight } of metaEntries) {
            let mult = typeEffectiveness(moveType, oppTypes[0], oppTypes[1] || null);
            if (stab) mult *= STAB_MULT;
            sum += (mult * mult) * weight;
        }
        return Math.sqrt(sum / totalMetaW);
    }

    function chargedMetaAvg(moveType) {
        if (NO_META) return 1.0;
        const stab = pokemonTypes.includes(moveType);
        let sum = 0;
        for (const { types: oppTypes, weight } of metaEntries) {
            let mult = typeEffectiveness(moveType, oppTypes[0], oppTypes[1] || null);
            if (stab) mult *= STAB_MULT;
            sum += mult * weight;
        }
        return sum / totalMetaW;
    }

    // Legacy helper retained for `moveTypeSet` callers that still want a
    // single number — composes the split terms with fast-weighted mixing.
    function metaOffScore(fastType, c1Type, c2Type) {
        const fastOff = fastMetaRms(fastType);
        const c1Off = chargedMetaAvg(c1Type);
        const c2Off = c2Type ? chargedMetaAvg(c2Type) : c1Off;
        // Fast fires every turn (~15-30 times/match); each charged fires 2-4.
        // Weight fast 60% of the meta-offense vote.
        return fastOff * 0.6 + c1Off * 0.25 + c2Off * 0.15;
    }

    let bestCombo = null, bestScore = -Infinity;

    for (const fast of fastScored) {
        for (let i = 0; i < chargedScored.length; i++) {
            for (let j = i; j < chargedScored.length; j++) {
                const c1 = chargedScored[i], c2 = chargedScored[j];

                // ── Bait + Nuke structure bonus ──
                // Reward having one cheap move (≤50e) and one heavy hitter (≥55e).
                // Flat bonus — no energy-gap scaling. Scaling caused lower-energy baits
                // (e.g. Muddy Water 35e) to beat higher-quality ones (Rock Slide 45e)
                // purely because of the energy gap, not because they're better moves.
                let structureBonus = 0;
                const cheapest = Math.min(c1.nrg, c2.nrg);
                const costliest = Math.max(c1.nrg, c2.nrg);
                const hasBait = cheapest <= 50;
                const hasNuke = costliest >= 55;
                if (hasBait && hasNuke && i !== j) {
                    structureBonus = 0.3; // flat bait+nuke bonus
                } else if (i !== j) {
                    structureBonus = 0.1; // two charged moves always better than one
                }

                // ── Type coverage diversity bonus ──
                // Only count charged-move type diversity; the fast move's type is
                // not a meaningful coverage dimension (it fires every turn regardless).
                // Rewarding fast-type uniqueness caused e.g. Peck to edge out
                // Dragon Breath on Altaria due to spurious "Flying ≠ Dragon" bonus.
                const moveTypeSet = new Set([fast.type, c1.type, c2.type]);
                let coverageBonus = 0;
                if (i !== j && c1.type !== c2.type) coverageBonus += 0.2; // different charged types

                // ── Meta SE coverage (P5 + P9) ──
                // Fast move gets its own RMS-weighted term (peaks matter —
                // STAB×SE = 1.92x chip every turn is a different weapon from
                // a flat 1.1x neutral). Charged moves share the remaining
                // 40% with a linear average since they fire only 2–4 times.
                const metaOff = metaOffScore(fast.type, c1.type, i === j ? null : c2.type);

                // ── Shield pressure: cost of cheapest charged move ──
                // Intentionally does NOT use fast.ept here — EPT is already captured in
                // fast move score. Using cheapest/fast.ept double-counts EPT and causes
                // high-EPT moves (Psycho Cut, Peck) to dominate over higher-damage
                // alternatives (Counter, Dragon Breath) due to a second EPT reward.
                // Clamp cheapest at 38 so very cheap moves (35e) don't gain a runaway
                // pressure advantage over quality 45e baits (e.g. Muddy Water 35e vs
                // Rock Slide 45e). Value 38 is the tight threshold: high enough to let
                // RS beat MW on individual quality, low enough for WBW to still beat
                // mid-cost alternatives on Politoed.
                const pressureScore = Math.max(0, Math.min(1, (80 - Math.max(cheapest, 38)) / 60));

                // ── Composite scoring ──
                // Move quality (individual scores)
                const moveQuality = fast.score * 0.35
                    + (i !== j ? (c1.score + c2.score) * 0.5 : c1.score)
                    * 0.35;

                // Meta effectiveness
                const metaScore = metaOff * 0.6;

                // Structure & pressure
                const tacticsScore = structureBonus + coverageBonus + pressureScore * 0.15;

                const total = moveQuality + metaScore + tacticsScore;

                if (total > bestScore) {
                    bestScore = total;
                    const eliteMoves = [fast.id, c1.id, c2.id].filter(m => eliteSet.has(m));
                    bestCombo = {
                        bestFast: fast.id,
                        charged1: c1.id,
                        charged2: i === j ? null : c2.id,
                        moveTypes: [...moveTypeSet],
                        fastInfo: fast,
                        charged1Info: c1,
                        charged2Info: i === j ? null : c2,
                        eliteMoves,
                        metaOff,
                        pressureScore,
                        structureBonus,
                        coverageBonus,
                        totalMoveScore: total,
                    };
                }
            }
        }
    }
    return bestCombo;
}

// ─── Battle Engine ───────────────────────────────────────────────────────────
// findRank1IVs, getRank1Stats, pvpDamage, computeBreakpoints, simulateBattle,
// buildBattler, getCachedBattler, SHIELD_SCENARIOS_*, computeBattleRating,
// computeRoleRatings → see battle-engine.js (loaded by index.html before app.js).

/**
 * Reciprocal Rank Fusion — research-validated method for combining heterogeneous scores.
 * Ranks each entry by its heuristic score and by its battle simulation rating independently,
 * then fuses them: RRF = 1/(k + heuristicRank) + 1/(k + battleRank)
 * where k=60 is the standard constant from the original Cormack et al. paper.
 *
 * This is scale-invariant (no normalisation needed), outlier-robust, and proven to
 * outperform weighted-sum and min-max approaches for multimodal ranking problems.
 *
 * The function mutates each entry, adding:
 *   .battleRating  — raw 0–1000 sim score (or null if species has no moveset data)
 *   .rrfScore      — fused composite (higher = better)
 *   .finalScore    — overwritten with rrfScore so all downstream code just uses finalScore
 *
 * @param {Array}  scored       Array of scored entries with at least { id, finalScore }
 * @param {number} cpCap
 * @param {Array}  metaEntries  Weighted meta opponent list for the battle sim
 */
function applyRRF(scored, cpCap, metaEntries) {
    const k = 60;

    // 1. Compute battle ratings (standard asymmetric scenarios) + role ratings for every entry
    for (const entry of scored) {
        const shadow = entry.isShadow || false;
        if (entry.battleRating == null) {
            const br = computeBattleRating(entry.id, cpCap, metaEntries, 80, shadow);
            entry.battleRating  = br ? br.battleRating  : null;
            entry.battleWins    = br ? br.wins           : null;
            entry.battleLosses  = br ? br.losses         : null;
        }
        // Role-specific ratings (computed once; used by team builder and display)
        if (entry.roleRatings == null) {
            entry.roleRatings = computeRoleRatings(entry.id, cpCap, metaEntries, shadow);
        }
    }

    // 2. Assign heuristic rank (sorted by existing finalScore, which is the heuristic)
    const byHeuristic = [...scored].sort((a, b) => b.finalScore - a.finalScore);
    byHeuristic.forEach((entry, i) => { entry._hRank = i + 1; });

    // 3. Assign battle rank — entries with no battle rating get a last-place rank
    const withBR    = scored.filter(e => e.battleRating != null)
                            .sort((a, b) => b.battleRating - a.battleRating);
    const noBR      = scored.filter(e => e.battleRating == null);
    const lastRank  = withBR.length + 1;
    withBR.forEach((entry, i)  => { entry._bRank = i + 1; });
    noBR.forEach(entry         => { entry._bRank = lastRank; });

    // 4. Compute RRF score and overwrite finalScore
    // NOTE: baseScore is intentionally NOT overwritten here.
    // buildBoxTeams category scoreFns (metaScoreFn, semiScoreFn, disruptionScoreFn) use
    // baseScore as their foundation. Overwriting it with the tiny RRF value (~0.013–0.033)
    // would make categorical bonuses (+0.05 to +0.20) completely swamp quality differences,
    // breaking per-category selection. finalScore is overwritten for display and greedy
    // ordering in buildMetaBreakerTeams; baseScore remains the original heuristic quality signal.
    // Theoretical max RRF when both ranks are 1: 1/(k+1) + 1/(k+1)
    const rrfMax = 2 / (k + 1); // ≈ 0.03279 for k=60
    for (const entry of scored) {
        entry.rrfScore    = 1 / (k + entry._hRank) + 1 / (k + entry._bRank);
        entry.finalScore  = entry.rrfScore;
        // Human-readable 0–1000 display score (does not affect sorting or logic)
        entry.displayScore = Math.round((entry.rrfScore / rrfMax) * 1000);
    }

    // 5. Re-sort in place
    scored.sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Build meta-busting teams of 3.
 * Scoring incorporates:
 *   - Meta-optimized moveset selection (bait+nuke, STAB, stat effects)
 *   - Type coverage against top 30 meta weighted by rank
 *   - Defensive resilience (resistance profile vs meta attackers)
 *   - Anti-meta value: empirical wins vs top-15 over meta-baseline
 *   - Shield pressure: fast energy generation for bait potential
 * Team building uses role-aware greedy coverage with ABB detection.
 */

// ─── Team Builder ────────────────────────────────────────────────────────────
// battleMargin, phiMargin, computeEnergyMomentum, classifyTeamArchetype,
// ARCHETYPE_COLORS, deriveDefensiveCores, computeAttackPrevalence,
// buildTeamsGreedy, scoreTeamFull, computeAntimetaBaseline, computeAntimetaValue
// → see team-builder.js (loaded by index.html before app.js).

function buildMetaBreakerTeams(leagueKey, cpCap) {
    const leagueInfo = getLeagueInfo(leagueKey);
    const isRestricted = leagueInfo.restricted || false;
    const rankMap = rankingsCache[leagueKey] || {};
    const metaIds = Object.entries(rankMap)
        .sort(([,a],[,b]) => a - b)
        .slice(0, 30)
        .map(([id]) => id);

    if (metaIds.length === 0) return { metaEntries: [], teams: [], allScored: [] };

    // Build weighted meta entries (higher weight = more meta-relevant)
    const metaEntries = metaIds.map((id, i) => ({
        id,
        types: (typeof POKEMON_TYPES !== 'undefined' ? POKEMON_TYPES[id] : null) || ['normal'],
        weight: metaIds.length - i // #1 meta = highest weight
    }));

    // ── Precompute anti-meta baseline once per run ──────────────────────
    // Top-15 battlers are the opponents we test each candidate against.
    // Baseline = median wins of top-20 meta picks vs. these top-15.
    const top15Battlers = metaEntries.slice(0, 15)
        .map(e => getCachedBattler(e.id, cpCap, metaEntries, false))
        .filter(Boolean);
    const antimetaBaseline = computeAntimetaBaseline(cpCap, metaEntries, top15Battlers);

    // Score every Pokémon in the DB (restricted formats only score eligible species)
    const allScored = [];
    for (const speciesId of Object.keys(POKEMON_STATS)) {
        const pokemonTypes = typeof POKEMON_TYPES !== 'undefined' ? POKEMON_TYPES[speciesId] : null;
        if (!pokemonTypes) continue;

        // Only score Pokémon that appear in the loaded rankings for this league.
        // This automatically excludes Mega, unreleased, Palafin-Hero, etc.
        if (!(speciesId in rankMap)) continue;

        const [a, d, s] = POKEMON_STATS[speciesId];
        if (calcCp(a, d, s, 0, 0, 0, LEVELS[0]) > cpCap) continue;

        // Get meta-optimized moveset
        const optimal = pickOptimalMoveset(speciesId, metaEntries);
        const moveTypes = optimal ? optimal.moveTypes : (pokemonTypes ? [...pokemonTypes] : []);
        if (moveTypes.length === 0) continue;

        const coverage = scoreTypeCoverage(pokemonTypes, moveTypes, metaEntries);

        // ── Shield pressure & efficiency from optimal moveset ──
        let efficiency = 0.5, pressureScore = 0;
        if (optimal) {
            efficiency = Math.max(0, Math.min(1, (optimal.totalMoveScore - 0.8) / 2.2));
            pressureScore = optimal.pressureScore || 0;
        }

        // ── Anti-meta value (empirical "spice" replacement) ──────────
        // Earned coverage: wins vs. top-15 meta minus the baseline that a
        // typical top-20 meta pick achieves. Obscurity alone no longer
        // earns a bonus — a candidate must out-beat the meta.
        const metaRankIdx = rankMap[speciesId];
        const antimetaValue = computeAntimetaValue(
            speciesId, cpCap, metaEntries, top15Battlers, antimetaBaseline,
            false, metaRankIdx != null ? metaRankIdx : null
        );

        // ── Stat effect bonus ──
        // Pokemon with stat-changing moves (PuP, Icy Wind, Acid Spray) get extra value
        let statEffectBonus = 0;
        if (optimal) {
            for (const cInfo of [optimal.charged1Info, optimal.charged2Info]) {
                if (cInfo && cInfo.effectValue > 0) statEffectBonus += cInfo.effectValue * 0.15;
            }
        }

        // ── Final composite ──
        const finalScore = (coverage.totalScore * 0.45)           // type matchup is still king
            + (efficiency * 0.25)                                  // move quality (EPT/DPT, bait+nuke)
            + (pressureScore * 0.10)                               // shield pressure ability
            + antimetaValue                                        // empirical anti-meta coverage
            + statEffectBonus                                      // stat buff/debuff utility
            + (coverage.offScore > 1.3 ? 0.05 : 0);              // SE coverage jackpot

        // PvPoke's published per-role scores (lead/switch/closer/attacker)
        // for this candidate in this cup. Used by buildTeamsGreedy slot bonus
        // — calibrated against the full meta, more reliable than our internal
        // roleRatings for slot-fit weighting. Null if the loaded CSV predates
        // the role-scores schema.
        const roleInfo = getBestRole(speciesId, leagueKey);

        allScored.push({
            id: speciesId,
            types: pokemonTypes,
            moveTypes,
            defScore: coverage.defScore,
            offScore: coverage.offScore,
            coverageScore: coverage.totalScore,
            efficiency,
            pressureScore,
            antimetaValue,
            finalScore,
            metaRank: rankMap[speciesId] ?? null,
            optimal,
            pvpokeRoles: roleInfo ? roleInfo.all : null,
        });
    }

    allScored.sort((a, b) => b.finalScore - a.finalScore);

    // ── Fuse heuristic + battle-sim scores via Reciprocal Rank Fusion ──
    // Computes battle ratings for all candidates and re-sorts using RRF.
    applyRRF(allScored, cpCap, metaEntries);

    // ── Pre-compute energy-momentum and top-threat flags ─────────────────
    // These are used by buildTeamsGreedy's slot bonuses.
    const rank1Battler = metaEntries.length >= 1
        ? getCachedBattler(metaEntries[0].id, cpCap, metaEntries, false) : null;
    const rank2Battler = metaEntries.length >= 2
        ? getCachedBattler(metaEntries[1].id, cpCap, metaEntries, false) : null;

    for (const cand of allScored) {
        cand.energyMomentum = computeEnergyMomentum(cand.id, false, cpCap, metaEntries);
        const cb = getCachedBattler(cand.id, cpCap, metaEntries, false);
        cand.beatsRank1 = !!(cb && rank1Battler && simulateBattle(cb, rank1Battler, 1, 1).winner === 'a');
        cand.beatsRank2 = !!(cb && rank2Battler && simulateBattle(cb, rank2Battler, 1, 1).winner === 'a');
    }

    // ── Team building via shared greedy engine ────────────────────────────
    const defensiveCores = deriveDefensiveCores(metaEntries);
    const attackPrevalence = computeAttackPrevalence(metaEntries);
    const teams = buildTeamsGreedy(
        allScored, 5,
        (cand, _slot) => cand.finalScore,   // base score from RRF heuristic
        null,
        { rank1Battler, rank2Battler, defensiveCores, attackPrevalence }
    );

    // ── Score and classify every team ─────────────────────────────────────
    for (const team of teams) {
        const { score, stats } = scoreTeamFull(team, cpCap, metaEntries, 30, attackPrevalence, leagueKey);
        team._chainScore    = score;
        team._matchupStats  = stats;
        team._archetype     = classifyTeamArchetype(team);
    }
    teams.sort((a, b) => b._chainScore - a._chainScore);

    return { metaEntries, teams, allScored };
}

// All 18 types for iteration
const TYPES_LIST = ['normal','fire','water','electric','grass','ice','fighting','poison',
    'ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'];

// ─── Shared rendering helpers ────────────────────────────────────────────────

const ROLE_COLORS = { 'Lead': '#38bdf8', 'Safe Swap': '#a78bfa', 'Closer': '#fb923c' };

function fmtMove(id) { return toTitleCase((id || '').replace(/_/g, ' ')); }

/**
 * Render a single Pokémon card (used in both Meta Breaker and Box Builder teams).
 * opts: { userBox, role, borderColor }
 */
/**
 * Render the "team killers" line for a team card: the meta opponents that
 * beat 2+ of the team's mons. PvPoke-confirmed threats (where PvPoke's
 * published `matchups` list also lists ≥1 of our mons as losing to that opp)
 * get a brighter color and a "PvPoke" badge — those are externally verified
 * shared weaknesses, not just artifacts of our local sim.
 */
function renderThreatLine(killers) {
    if (!Array.isArray(killers) || killers.length === 0) return '';
    const parts = killers.map(k => {
        // Older callers may have shipped string ids; tolerate both shapes.
        const id     = typeof k === 'string' ? k : k.id;
        const losers = typeof k === 'string' ? null : k.losers;
        const conf   = typeof k === 'string' ? false : (k.pvpokeAmp && k.pvpokeAmp > 1);
        const color  = conf ? '#f87171' : '#fb923c';
        const badge  = conf
            ? `<span style="font-size:9px;color:#f87171;background:#3b1414;padding:1px 4px;border-radius:3px;margin-left:3px;" title="PvPoke's published matchups list independently confirms this opponent beats 2+ team members">PvPoke</span>`
            : '';
        const losersTag = losers != null && losers >= 2
            ? `<span style="color:#94a3b8;font-size:9px;margin-left:2px;">(${losers}/3)</span>` : '';
        return `<span style="color:${color};">${toTitleCase(id)}${losersTag}</span>${badge}`;
    });
    return `<div style="font-size:10px;color:#64748b;margin-top:2px;margin-bottom:6px;">` +
           `team killers: ${parts.join(' · ')}` +
           `</div>`;
}

function renderMonCard(mon, opts) {
    const userBox = opts.userBox || new Set();
    const role = opts.role || '';
    const borderColor = opts.borderColor || '#334155';

    const inBox = userBox.has(mon.id);
    const boxTag = inBox
        ? '<span style="background:#22c55e;color:#000;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;">IN BOX</span>'
        : '';
    const metaTag = mon.metaRank != null
        ? `<span style="color:#f59e0b;font-size:10px;"> Meta #${mon.metaRank+1}</span>`
        : '';
    const antimetaVal = mon.antimetaValue || 0;
    const spiceTag = (antimetaVal > 0)
        ? ` <span style="background:#d946ef;color:#fff;padding:0 4px;border-radius:3px;font-size:8px;" title="Anti-meta value: +${antimetaVal.toFixed(2)} from wins vs top-15 meta">ANTI-META</span>`
        : '';
    const roleTag = role
        ? `<span style="color:${ROLE_COLORS[role] || '#94a3b8'};font-size:9px;font-weight:600;display:block;margin-bottom:2px;">${role}</span>`
        : '';

    const typesTags = mon.types.map(t => `<span class="type-badge type-${t}">${t}</span>`).join(' ');

    // Moveset display with bait/nuke role labels
    let movesetHtml = '';
    if (mon.optimal) {
        const o = mon.optimal;
        const eliteTag = id => (o.eliteMoves.includes(id)
            ? ' <span style="background:#7c3aed;color:#fff;padding:0 4px;border-radius:3px;font-size:8px;font-weight:600;">ELITE TM</span>'
            : '');
        const roleLabel = (info) => {
            if (!info) return '';
            if (info.effectValue > 0) return ' <span style="color:#fbbf24;font-size:8px;">[BUFF]</span>';
            if (info.role === 'bait') return ' <span style="color:#22d3ee;font-size:8px;">[BAIT]</span>';
            if (info.role === 'nuke') return ' <span style="color:#f87171;font-size:8px;">[NUKE]</span>';
            return '';
        };
        movesetHtml = `<div style="font-size:10px;color:#94a3b8;margin-top:3px;">
            <span style="color:#64748b;">Fast:</span> ${fmtMove(o.bestFast)}${eliteTag(o.bestFast)}<br>
            <span style="color:#64748b;">Charged:</span> ${fmtMove(o.charged1)}${eliteTag(o.charged1)}${roleLabel(o.charged1Info)}${o.charged2 ? ', '+fmtMove(o.charged2)+eliteTag(o.charged2)+roleLabel(o.charged2Info) : ''}
        </div>`;
    }
    const eliteWarn = (mon.optimal && mon.optimal.eliteMoves.length > 0)
        ? '<div style="font-size:9px;color:#c084fc;margin-top:3px;">⚠ Requires Elite TM</div>'
        : '';

    // Pressure bar
    const pressurePct = Math.round((mon.pressureScore || 0) * 100);

    // Shadow indicator
    const shadowTag = mon.isShadow
        ? ' <span style="background:#7c3aed;color:#fff;padding:0 5px;border-radius:3px;font-size:9px;font-weight:600;">SHADOW</span>'
        : '';

    // Energy momentum tag — shown on Safe Swap cards only
    const emPct = Math.round((mon.energyMomentum || 0) * 100);
    const momentumTag = (role === 'Safe Swap' && emPct > 2)
        ? `<div style="font-size:9px;color:#fbbf24;margin-top:2px;">⚡ +${emPct}% with banked energy</div>`
        : '';

    // Role ratings mini-bar (Lead / Safe / Closer)
    let roleRatingHtml = '';
    if (mon.roleRatings) {
        const rr = mon.roleRatings;
        const rBar = (label, val, color) => val == null ? '' :
            `<span style="font-size:9px;color:#64748b;">${label}:</span> <span style="color:${color};font-weight:600;font-size:9px;">${val}</span> `;
        const lv = rr.lead    ? rr.lead.battleRating    : null;
        const sv = rr.safeSwap? rr.safeSwap.battleRating: null;
        const cv = rr.closer  ? rr.closer.battleRating  : null;
        const col = v => v >= 600 ? '#4ade80' : v >= 450 ? '#60a5fa' : v >= 300 ? '#fbbf24' : '#fb923c';
        roleRatingHtml = `<div style="margin-top:4px;">`
            + rBar('Lead', lv, col(lv))
            + rBar('Safe', sv, col(sv))
            + rBar('Close', cv, col(cv))
            + `</div>`;
    }

    // Display name: strip _shadow suffix for readability
    const displayName = toTitleCase(mon.baseId || mon.id);

    return `<div style="flex:1;min-width:200px;background:#0f172a;border:1px solid ${borderColor};border-radius:6px;padding:10px;">
        ${roleTag}
        <div style="font-weight:600;color:#e2e8f0;font-size:14px;">${displayName}${shadowTag}${boxTag}${metaTag}${spiceTag}</div>
        <div style="margin:4px 0;">${typesTags}</div>
        <div style="font-size:11px;color:#94a3b8;">
            Coverage: <span style="color:${mon.coverageScore > 1.5 ? '#4ade80' : mon.coverageScore > 1.0 ? '#60a5fa' : '#f87171'}">${mon.coverageScore.toFixed(2)}</span> ·
            Pressure: <span style="color:${pressurePct > 60 ? '#4ade80' : pressurePct > 30 ? '#60a5fa' : '#f87171'}">${pressurePct}%</span> ·
            Score: <span style="font-weight:600;">${mon.displayScore ?? Math.round(mon.finalScore * 30497)}</span>
        </div>
        ${roleRatingHtml}
        ${momentumTag}
        ${movesetHtml}${eliteWarn}
        <div style="font-size:10px;color:#64748b;margin-top:2px;">Coverage: ${mon.moveTypes.map(t => `<span class="type-badge type-${t}" style="font-size:9px;padding:0 4px;">${t}</span>`).join(' ')}</div>
    </div>`;
}

/**
 * Render the top N scorers table.
 */
function renderScorerTable(allScored, count, userBox, cpCap, metaEntries) {
    const n = Math.min(count, allScored.length);
    let html = `<h3 style="margin:20px 0 10px;color:#e2e8f0;">Top ${n} Individual Scorers</h3>`;

    // Compute battle ratings for displayed rows (sim is expensive, only do top N)
    const battleRatings = {};
    if (cpCap && metaEntries && metaEntries.length > 0) {
        for (let i = 0; i < n; i++) {
            const br = computeBattleRating(allScored[i].id, cpCap, metaEntries, 80);
            if (br) battleRatings[allScored[i].id] = br;
        }
    }
    const hasBR = Object.keys(battleRatings).length > 0;

    html += `<table style="width:100%;"><thead><tr>
        <th>#</th><th>Pokémon</th><th>Types</th><th>Moveset</th>${hasBR ? '<th title="1v1 battle sim vs top 80 meta (rank-weighted, 3-seed averaged, asymmetric shield scenarios)">Battle</th>' : ''}<th>Coverage</th><th>Pressure</th><th title="Reciprocal Rank Fusion of heuristic + battle sim (0–1000 scale)">RRF Score</th>
    </tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
        const s = allScored[i];
        const inBox = (userBox || new Set()).has(s.id);
        const boxTag = inBox ? ' <span style="background:#22c55e;color:#000;padding:0 4px;border-radius:3px;font-size:9px;">IN BOX</span>' : '';
        const antimetaVal = s.antimetaValue || 0;
        const spiceTag = (antimetaVal > 0) ? ` <span style="background:#d946ef;color:#fff;padding:0 3px;border-radius:2px;font-size:8px;" title="Anti-meta: +${antimetaVal.toFixed(2)} from empirical wins vs top-15">ANTI-META</span>` : '';
        const typesTags = s.types.map(t => `<span class="type-badge type-${t}" style="font-size:10px;">${t}</span>`).join(' ');

        let movesetCell = '<span style="color:#b4b4b4;">STAB only</span>';
        if (s.optimal) {
            const o = s.optimal;
            const eliteTag = id => (o.eliteMoves.includes(id)
                ? ' <span style="background:#7c3aed;color:#fff;padding:0 3px;border-radius:2px;font-size:8px;">ETM</span>'
                : '');
            const c1Role = o.charged1Info?.role === 'bait' ? ' <span style="color:#22d3ee;font-size:8px;">bait</span>'
                : o.charged1Info?.effectValue > 0 ? ' <span style="color:#fbbf24;font-size:8px;">buff</span>' : '';
            const c2Role = o.charged2Info?.role === 'nuke' ? ' <span style="color:#f87171;font-size:8px;">nuke</span>'
                : o.charged2Info?.effectValue > 0 ? ' <span style="color:#fbbf24;font-size:8px;">buff</span>' : '';
            movesetCell = `<span style="font-size:11px;">${fmtMove(o.bestFast)}${eliteTag(o.bestFast)}</span><br>`
                + `<span style="font-size:10px;color:#94a3b8;">${fmtMove(o.charged1)}${eliteTag(o.charged1)}${c1Role}${o.charged2 ? ', '+fmtMove(o.charged2)+eliteTag(o.charged2)+c2Role : ''}</span>`;
        }

        // Battle rating cell
        let brCell = '';
        if (hasBR) {
            const br = battleRatings[s.id];
            if (br) {
                const brColor = br.battleRating >= 600 ? '#4ade80' : br.battleRating >= 450 ? '#60a5fa' : br.battleRating >= 300 ? '#fbbf24' : '#fb923c';
                brCell = `<td><span style="font-weight:600;color:${brColor};">${br.battleRating}</span><br><span style="font-size:9px;color:#64748b;">${br.wins}W ${br.losses}L</span></td>`;
            } else {
                brCell = `<td style="color:#b4b4b4;">—</td>`;
            }
        }

        const pressurePct = Math.round((s.pressureScore || 0) * 100);
        html += `<tr>
            <td>${i+1}</td>
            <td style="font-weight:500;">${toTitleCase(s.id)}${boxTag}${spiceTag}</td>
            <td>${typesTags}</td>
            <td>${movesetCell}</td>
            ${brCell}
            <td style="color:${s.coverageScore > 1.5 ? '#4ade80' : s.coverageScore > 1.0 ? '#60a5fa' : '#fb923c'}">${s.coverageScore.toFixed(2)}</td>
            <td style="color:${pressurePct > 60 ? '#4ade80' : pressurePct > 30 ? '#60a5fa' : '#fb923c'}">${pressurePct}%</td>
            <td style="font-weight:600;">${s.displayScore ?? Math.round(s.finalScore * 30497)}</td>
        </tr>`;
    }
    html += `</tbody></table>`;
    return html;
}

/**
 * Render the Meta Breaker results into #meta-out.
 * Called when the user clicks the "Meta Breaker" button after running analysis.
 */
async function runMetaBreaker() {
    const { key: leagueKey, cpCap } = getSelectedLeagueInfo();
    const outEl = document.getElementById('meta-out');
    if (!outEl) return;

    // Ensure move data and rankings are loaded
    await Promise.all([loadMoves(), loadPokemon()]);
    try { await loadRankings(leagueKey); } catch (e) {}

    // Check if meta.js loaded
    if (typeof POKEMON_TYPES === 'undefined' || typeof TYPE_CHART === 'undefined') {
        outEl.innerHTML = '<p style="color:#f87171;">Meta data not loaded. Ensure meta.js is included.</p>';
        return;
    }

    outEl.innerHTML = '<p style="color:#b4b4b4;">Computing meta-busting teams (running battle simulations — may take a few seconds)...</p>';

    setTimeout(() => {
        const { metaEntries, teams, allScored } = buildMetaBreakerTeams(leagueKey, cpCap);

        if (teams.length === 0) {
            outEl.innerHTML = '<p style="color:#f87171;">No rankings loaded. Run analysis first or check rankings CSV.</p>';
            return;
        }

        // Collect user's box (species from CSV) for highlighting
        const userBox = new Set();
        const csvText = document.getElementById('csv').value.trim();
        if (csvText) {
            const { rows } = parseCalcyIvExport(csvText);
            for (const row of rows) {
                const chain = getEvolutionChain(normalizeId(row.name));
                for (const eid of chain) userBox.add(eid);
            }
        }

        // Meta type frequency
        const typeFreq = {};
        for (const e of metaEntries) {
            for (const t of e.types) typeFreq[t] = (typeFreq[t] || 0) + e.weight;
        }
        const sortedTypes = Object.entries(typeFreq).sort(([,a],[,b]) => b - a);
        const maxFreq = sortedTypes[0]?.[1] || 1;

        let html = `<h3 style="margin:20px 0 10px;color:#e2e8f0;">Meta Type Distribution (Top 30)</h3>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px;">`;
        for (const [type, freq] of sortedTypes) {
            const pct = (freq / maxFreq * 100).toFixed(0);
            html += `<div style="background:#1e293b;border:1px solid #334155;border-radius:6px;padding:4px 10px;font-size:12px;">
                <span class="type-badge type-${type}">${type}</span>
                <div style="width:60px;height:4px;background:#0f172a;border-radius:2px;margin-top:3px;">
                    <div style="width:${pct}%;height:100%;background:${typeColor(type)};border-radius:2px;"></div>
                </div>
            </div>`;
        }
        html += `</div>`;

        // Teams
        html += `<h3 style="margin:20px 0 10px;color:#e2e8f0;">Meta-Busting Teams</h3>`;
        const roles = ['Lead','Safe Swap','Closer'];
        for (let i = 0; i < teams.length; i++) {
            const team = teams[i];

            // Score badge
            const cs = team._chainScore;
            const csColor = cs >= 700 ? '#4ade80' : cs >= 550 ? '#60a5fa' : cs >= 400 ? '#fbbf24' : '#fb923c';
            const csTag = cs != null
                ? `<span style="font-size:11px;color:#64748b;margin-left:8px;">score: <span style="color:${csColor};font-weight:600;">${cs}</span></span>`
                : '';

            // Archetype badge
            const atColor = ARCHETYPE_COLORS[team._archetype] || '#94a3b8';
            const atTag = team._archetype
                ? `<span style="font-size:10px;border:1px solid ${atColor};color:${atColor};padding:1px 7px;border-radius:4px;margin-left:8px;">${team._archetype}</span>`
                : '';

            // Matchup margin bar
            const ms = team._matchupStats;
            const marginBar = ms ? (() => {
                const wins = ms.wins, losses = ms.losses, total = ms.oppCount || 1;
                const ties = total - wins - losses;
                const wmColor  = ms.avgWinMargin  >= 50 ? '#4ade80' : ms.avgWinMargin >= 30 ? '#a3e635' : '#fbbf24';
                const lmColor  = ms.avgLossMargin <= 20 ? '#4ade80' : ms.avgLossMargin <= 40 ? '#fbbf24' : '#f87171';
                const winLabel  = ms.avgWinMargin  > 0 ? ` <span style="color:${wmColor}">+${ms.avgWinMargin}% HP</span>` : '';
                const lossLabel = ms.avgLossMargin > 0 ? ` <span style="color:${lmColor}">${ms.avgLossMargin}% left</span>` : '';
                const hardHoleLabel = ms.hardHoles > 0
                    ? `<span style="color:#f87171;margin-left:8px;">⚠ ${ms.hardHoles} hard hole${ms.hardHoles > 1 ? 's' : ''}</span>`
                    : '';
                return `<div style="font-size:10px;color:#64748b;margin-top:4px;margin-bottom:6px;">` +
                    `vs top-${total} meta: ` +
                    `<span style="color:#4ade80;">W ${wins}${winLabel}</span> · ` +
                    `<span style="color:#fb923c;">L ${losses}${lossLabel}</span>` +
                    (ties > 0 ? ` · <span>T ${ties}</span>` : '') +
                    hardHoleLabel +
                    `</div>`;
            })() : '';

            const threatLine = ms ? renderThreatLine(ms.topKillers) : '';

            html += `<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:12px;">
                <div style="font-weight:600;color:#94a3b8;margin-bottom:4px;">Team ${i+1}${csTag}${atTag}</div>
                ${marginBar}
                ${threatLine}
                <div style="display:flex;gap:12px;flex-wrap:wrap;">`;
            for (let si = 0; si < team.length; si++) {
                const mon = team[si];
                html += renderMonCard(mon, { userBox, role: roles[si], borderColor: '#334155' });
            }
            html += `</div></div>`;
        }

        // Top 20 individual scorers (with battle sim)
        html += renderScorerTable(allScored, 20, userBox, cpCap, metaEntries);

        outEl.innerHTML = html;
    }, 30);
}

// ─── My Box Builder ─────────────────────────────────────────────────────────

/**
 * Build teams of 3 from the user's box only, using meta-optimized movesets.
 * Uses top 100 meta for coverage scoring. Same scoring engine as Meta Breaker
 * but restricted to user's imported Pokémon.
 */
function buildBoxTeams(leagueKey, cpCap) {
    const leagueInfo = getLeagueInfo(leagueKey);
    const isRestricted = leagueInfo.restricted || false;
    const rankMap = rankingsCache[leagueKey] || {};
    const metaIds = Object.entries(rankMap)
        .sort(([,a],[,b]) => a - b)
        .slice(0, 100)
        .map(([id]) => id);

    if (metaIds.length === 0) return { metaEntries: [], metaTeams: [], semiMetaTeams: [], disruptionTeams: [], boxScored: [] };

    const metaEntries = metaIds.map((id, i) => ({
        id,
        types: (POKEMON_TYPES[id]) || ['normal'],
        weight: metaIds.length - i
    }));

    // Top-100 set retained for the isMeta flag used in team categorization
    // (Meta / Semi-Meta / Full Disruption slotting logic). The antimeta
    // VALUE no longer uses this cutoff — it's computed empirically below.
    const top100Meta = new Set(metaIds);
    const minIvPct = getMinIvPct();

    // Anti-meta scoring infrastructure (see computeAntimetaValue above).
    const top15Battlers = metaEntries.slice(0, 15)
        .map(e => getCachedBattler(e.id, cpCap, metaEntries, false))
        .filter(Boolean);
    const antimetaBaseline = computeAntimetaBaseline(cpCap, metaEntries, top15Battlers);

    // Use the species sets cached from the last Analyze run.
    // If a min IV% filter is active, use only species that met it.
    const sourceBox = minIvPct != null ? lastAnalysisBox98 : lastAnalysisBox;
    const userBox = new Set(sourceBox);

    if (userBox.size === 0) {
        const csvText = document.getElementById('csv').value.trim();
        if (!csvText) return { metaEntries, metaTeams: [], semiMetaTeams: [], disruptionTeams: [], boxScored: [] };
        const { rows } = parseCalcyIvExport(csvText);
        for (const row of rows) {
            const chain = getEvolutionChain(normalizeId(row.name));
            for (const eid of chain) userBox.add(eid);
        }
    }

    // Score each box Pokémon — we compute a base score without anti-meta,
    // then store anti-meta separately so each category can apply it differently.
    // userBox entries may carry _shadow suffix; extract base ID for stat lookups.
    const boxScored = [];
    for (const rawId of userBox) {
        const { baseId: speciesId, isShadow } = parseShadowId(rawId);
        const pokemonTypes = POKEMON_TYPES[speciesId];
        if (!pokemonTypes) continue;

        // Only allow Pokémon listed in the rankings CSV for this league.
        // This automatically excludes Mega, unreleased, Palafin-Hero, etc.
        if (!(speciesId in rankMap)) continue;

        const [a, d, s] = POKEMON_STATS[speciesId] || [0,0,0];
        if (calcCp(a, d, s, 0, 0, 0, LEVELS[0]) > cpCap) continue;

        const optimal = pickOptimalMoveset(speciesId, metaEntries);
        if (!optimal) continue;

        const top30 = metaEntries.slice(0, 30);
        const coverage = scoreTypeCoverage(pokemonTypes, optimal.moveTypes, top30);

        const efficiency = Math.max(0, Math.min(1, (optimal.totalMoveScore - 0.8) / 2.2));
        const pressureScore = optimal.pressureScore || 0;

        const isMeta = top100Meta.has(speciesId);

        // Anti-meta value: empirical wins vs top-15 meta over baseline.
        // Stored separately from baseScore so each team category (Meta /
        // Semi-Meta / Full Disruption) can weight it differently.
        const metaRankIdx = rankMap[speciesId];
        const antimetaValue = computeAntimetaValue(
            speciesId, cpCap, metaEntries, top15Battlers, antimetaBaseline,
            isShadow, metaRankIdx != null ? metaRankIdx : null
        );

        // Stat effect bonus
        let statEffectBonus = 0;
        for (const cInfo of [optimal.charged1Info, optimal.charged2Info]) {
            if (cInfo && cInfo.effectValue > 0) statEffectBonus += cInfo.effectValue * 0.15;
        }

        // Base score (no spice, no meta preference — neutral)
        const baseScore = (coverage.totalScore * 0.45)
            + (efficiency * 0.25)
            + (pressureScore * 0.10)
            + statEffectBonus
            + (coverage.offScore > 1.3 ? 0.05 : 0);

        // PvPoke's published per-role scores (lead/switch/closer/attacker).
        // getBestRole accepts the raw _shadow id and falls back to the base
        // form when the cup's CSV doesn't list shadow variants separately.
        const roleInfo = getBestRole(rawId, leagueKey);

        boxScored.push({
            id: rawId,           // may carry _shadow suffix; used for battler cache keys
            baseId: speciesId,   // base form ID for stat/type lookups
            isShadow,
            types: pokemonTypes,
            moveTypes: optimal.moveTypes,
            optimal,
            defScore: coverage.defScore,
            offScore: coverage.offScore,
            coverageScore: coverage.totalScore,
            efficiency,
            pressureScore,
            antimetaValue,
            baseScore,
            finalScore: baseScore + antimetaValue, // default combined for table display
            isMeta,
            metaRank: rankMap[speciesId] ?? null,
            pvpokeRoles: roleInfo ? roleInfo.all : null,
        });
    }

    boxScored.sort((a, b) => b.finalScore - a.finalScore);

    // ── Fuse heuristic + battle-sim scores via Reciprocal Rank Fusion ──
    applyRRF(boxScored, cpCap, metaEntries);

    // ── Energy-momentum pre-computation ──────────────────────────────────
    for (const cand of boxScored) {
        cand.energyMomentum = computeEnergyMomentum(cand.id, cand.isShadow, cpCap, metaEntries);
    }

    // ── Top-threat coverage pre-computation ──────────────────────────────
    // Identify which candidates can beat the #1 and #2 meta threats in a
    // 1s/1s scenario.  Stored as flags so the greedy builder and full scorer
    // can use them without repeating sims.
    const rank1Battler = metaEntries.length >= 1
        ? getCachedBattler(metaEntries[0].id, cpCap, metaEntries, false) : null;
    const rank2Battler = metaEntries.length >= 2
        ? getCachedBattler(metaEntries[1].id, cpCap, metaEntries, false) : null;

    for (const cand of boxScored) {
        const cb = getCachedBattler(cand.id, cpCap, metaEntries, cand.isShadow);
        cand.beatsRank1 = !!(cb && rank1Battler && simulateBattle(cb, rank1Battler, 1, 1).winner === 'a');
        cand.beatsRank2 = !!(cb && rank2Battler && simulateBattle(cb, rank2Battler, 1, 1).winner === 'a');
    }

    // ── Category 1: Meta Teams (best proven picks, no anti-meta) ───────
    // Prefer meta-ranked Pokémon. Score = base + meta preference bonus.
    const metaScoreFn = (cand, slot) => {
        let s = cand.baseScore;
        // Strong preference for ranked/meta Pokémon
        if (cand.isMeta) {
            s += 0.15;
            // Extra bonus for top-50 meta picks
            if (cand.metaRank !== null && cand.metaRank <= 50) s += 0.05;
        } else {
            // Slight penalty for off-meta in meta teams
            s -= 0.05;
        }
        return s;
    };
    const defensiveCores = deriveDefensiveCores(metaEntries);
    const attackPrevalence = computeAttackPrevalence(metaEntries);
    const metaTeams = buildTeamsGreedy(boxScored, 5, metaScoreFn, null, { rank1Battler, rank2Battler, defensiveCores, attackPrevalence });

    // ── Category 2: Semi-Meta (2 meta + 1 breaker) ─────────────────────
    // Slots 0 & 1 prefer meta, slot 2 rewards empirical anti-meta coverage.
    const semiScoreFn = (cand, slot) => {
        let s = cand.baseScore;
        if (slot < 2) {
            // Meta slots: slight meta preference
            if (cand.isMeta) s += 0.08;
        } else {
            // Breaker slot: reward anti-meta wins (Galvantula-style picks
            // that beat top-15 where typical meta can't).
            s += cand.antimetaValue * 1.5;
        }
        return s;
    };
    const semiSlotFilter = (cand, slot, team) => {
        // Slot 2 (breaker) should be off-meta if possible
        if (slot === 2) {
            // Check if there are any off-meta candidates not already on the team
            const offMetaAvailable = boxScored.some(c =>
                !c.isMeta && !team.some(m => m.id === c.id)
            );
            if (offMetaAvailable) return !cand.isMeta;
        }
        return true;
    };
    const semiMetaTeams = buildTeamsGreedy(boxScored, 5, semiScoreFn, semiSlotFilter, { rank1Battler, rank2Battler, defensiveCores, attackPrevalence });

    // ── Category 3: Full Disruption (maximize empirical anti-meta) ──────
    // Boost picks with real anti-meta wins; penalize meta-standard choices
    // SOFTLY (no longer a flat off-meta bonus that rewarded obscurity).
    // A meta pick with great anti-meta wins shouldn't be locked out.
    const disruptionScoreFn = (cand, slot) => {
        let s = cand.baseScore;
        // Heavy anti-meta weight — this is what Full Disruption is about.
        s += cand.antimetaValue * 3.0;
        // Mild penalty for being top-20 meta (these belong in Meta Teams),
        // but no bonus for being off-meta without proven coverage.
        if (cand.isMeta && cand.metaRank != null && cand.metaRank < 20) s -= 0.05;
        // Extra reward for good offensive type coverage
        if (cand.offScore > 1.2) s += 0.06;
        return s;
    };
    const disruptionTeams = buildTeamsGreedy(boxScored, 5, disruptionScoreFn, null, { rank1Battler, rank2Battler, defensiveCores, attackPrevalence });

    // ── Score, classify and sort all teams ───────────────────────────────
    // Uses top-level scoreTeamFull / classifyTeamArchetype so the logic is
    // identical to what Meta Breaker teams receive.  (See engine functions
    // above buildMetaBreakerTeams for the implementation.)
    // NOTE: uses top-level scoreTeamFull / classifyTeamArchetype (shared with Meta Breaker).

    // Annotate and sort each team list by full score (best first)
    for (const teamList of [metaTeams, semiMetaTeams, disruptionTeams]) {
        for (const team of teamList) {
            const { score, stats } = scoreTeamFull(team, cpCap, metaEntries, 30, attackPrevalence, leagueKey);
            team._chainScore = score;
            team._matchupStats = stats;
            team._archetype  = classifyTeamArchetype(team);
        }
        teamList.sort((a, b) => b._chainScore - a._chainScore);
    }

    return { metaEntries, metaTeams, semiMetaTeams, disruptionTeams, boxScored };
}

/**
 * Render the My Box Builder results into #box-out.
 * Auto-runs Analyze in the background if it hasn't been run yet.
 */
async function runBoxBuilder() {
    const { key: leagueKey, cpCap } = getSelectedLeagueInfo();
    const outEl = document.getElementById('box-out');
    if (!outEl) return;

    // Validate CSV input — silently bail if nothing is pasted
    const csvText = document.getElementById('csv').value.trim();
    if (!csvText) return;

    const { rows, err } = parseCalcyIvExport(csvText);
    if (err || !rows.length) return; // invalid CSV — do nothing

    // Ensure meta data is loaded
    if (typeof POKEMON_TYPES === 'undefined' || typeof TYPE_CHART === 'undefined') return;

    await Promise.all([loadMoves(), loadPokemon()]);
    try { await loadRankings(leagueKey); } catch (e) {}

    // If Analyze hasn't been run yet (box sets empty), run it in the background first
    if (lastAnalysisBox.size === 0) {
        outEl.innerHTML = '<p style="color:#b4b4b4;">Analyzing your box first...</p>';
        await run();
    }

    outEl.innerHTML = '<p style="color:#b4b4b4;">Building teams from your box (running battle simulations — may take a few seconds)...</p>';

    setTimeout(() => {
        const { metaEntries, metaTeams, semiMetaTeams, disruptionTeams, boxScored } = buildBoxTeams(leagueKey, cpCap);

        const minIvPctBox = getMinIvPct();
        if (boxScored.length === 0) {
            const hint = minIvPctBox != null
                ? `No Pokémon passed the ${minIvPctBox}%+ IV filter. Try lowering the Min IV% or importing more Pokémon.`
                : 'No eligible box Pokémon found. Click Analyze first to process your CSV.';
            outEl.innerHTML = `<p style="color:#f87171;">${hint}</p>`;
            return;
        }

        let html = `<div style="border-top:2px solid #059669;margin-top:30px;padding-top:20px;">`;
        html += `<h2 style="color:#e2e8f0;margin:0 0 6px;">
            <span style="background:linear-gradient(135deg,#059669,#0891b2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">My Box Builder</span>
        </h2>`;
        const filterNote = minIvPctBox != null ? ` · <span style="color:#4ade80;">${minIvPctBox}%+ IV filter active</span>` : '';
        html += `<p style="color:#64748b;font-size:13px;margin:0 0 16px;">Teams built from <strong style="color:#10b981;">${boxScored.length}</strong> Pokémon in your box · movesets optimised against top 100 meta · bait+nuke structure${filterNote}</p>`;

        const roles = ['Lead','Safe Swap','Closer'];

        // Helper to render a category of teams
        function renderTeamCategory(teams, title, subtitle, borderColor, titleColor) {
            if (teams.length === 0) return '';
            let s = `<h3 style="margin:20px 0 4px;color:${titleColor};">${title}</h3>`;
            s += `<p style="color:#64748b;font-size:12px;margin:0 0 10px;">${subtitle}</p>`;
            for (let i = 0; i < teams.length; i++) {
                const team = teams[i];
                // 3v3 chain score: colour-coded (≥700 = great, ≥550 = ok, <550 = weak)
                const cs = team._chainScore;
                const csColor = cs >= 700 ? '#4ade80' : cs >= 550 ? '#60a5fa' : cs >= 400 ? '#fbbf24' : '#fb923c';
                const csTag = cs != null
                    ? `<span style="font-size:11px;color:#64748b;margin-left:8px;">score: <span style="color:${csColor};font-weight:600;">${cs}</span></span>`
                    : '';
                const atColor = ARCHETYPE_COLORS[team._archetype] || '#94a3b8';
                const atTag = team._archetype
                    ? `<span style="font-size:10px;border:1px solid ${atColor};color:${atColor};padding:1px 7px;border-radius:4px;margin-left:8px;">${team._archetype}</span>`
                    : '';

                // Matchup margin bar
                const ms = team._matchupStats;
                const marginBar = ms ? (() => {
                    const wins = ms.wins, losses = ms.losses, total = ms.oppCount || 1;
                    const ties = total - wins - losses;
                    const winPct   = Math.round(wins   / total * 100);
                    const lossPct  = Math.round(losses / total * 100);
                    // Win-margin colour: higher HP left = greener
                    const wmColor  = ms.avgWinMargin  >= 50 ? '#4ade80' : ms.avgWinMargin >= 30 ? '#a3e635' : '#fbbf24';
                    // Loss-margin colour: lower opp HP = better (closer loss) = greener
                    const lmColor  = ms.avgLossMargin <= 20 ? '#4ade80' : ms.avgLossMargin <= 40 ? '#fbbf24' : '#f87171';
                    const winLabel  = ms.avgWinMargin  > 0 ? ` <span style="color:${wmColor}">+${ms.avgWinMargin}% HP</span>` : '';
                    const lossLabel = ms.avgLossMargin > 0 ? ` <span style="color:${lmColor}">${ms.avgLossMargin}% left</span>` : '';
                    const hardHoleLabel = ms.hardHoles > 0
                        ? `<span style="color:#f87171;margin-left:8px;">⚠ ${ms.hardHoles} hard hole${ms.hardHoles > 1 ? 's' : ''}</span>`
                        : '';
                    return `<div style="font-size:10px;color:#64748b;margin-top:4px;margin-bottom:6px;">` +
                        `vs top-${total} meta: ` +
                        `<span style="color:#4ade80;">W ${wins}${winLabel}</span> · ` +
                        `<span style="color:#fb923c;">L ${losses}${lossLabel}</span>` +
                        (ties > 0 ? ` · <span>T ${ties}</span>` : '') +
                        hardHoleLabel +
                        `</div>`;
                })() : '';

                const threatLine = ms ? renderThreatLine(ms.topKillers) : '';

                s += `<div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;padding:12px;margin-bottom:12px;">
                    <div style="font-weight:600;color:${titleColor};margin-bottom:4px;">Team ${i+1}${csTag}${atTag}</div>
                    ${marginBar}
                    ${threatLine}
                    <div style="display:flex;gap:12px;flex-wrap:wrap;">`;
                for (let si = 0; si < team.length; si++) {
                    s += renderMonCard(team[si], { role: roles[si], borderColor });
                }
                s += `</div></div>`;
            }
            return s;
        }

        // Category 1: Meta Teams
        html += renderTeamCategory(metaTeams,
            '🏆 Meta Teams',
            'Best proven picks from your box — prioritises top-ranked meta Pokémon',
            '#065f46', '#10b981');

        // Category 2: Semi-Meta
        html += renderTeamCategory(semiMetaTeams,
            '⚡ Semi-Meta Teams',
            '2 solid meta picks + 1 off-meta breaker for an unpredictability edge',
            '#1e40af', '#60a5fa');

        // Category 3: Full Disruption
        html += renderTeamCategory(disruptionTeams,
            '🔥 Full Disruption Teams',
            'Maximum anti-meta — picks with empirical wins vs top-15 that typical meta picks miss',
            '#7c2d12', '#fb923c');

        // Top box Pokémon table (with battle sim)
        html += renderScorerTable(boxScored, 30, new Set(), cpCap, metaEntries);
        html += `</div>`;

        outEl.innerHTML = html;
    }, 30);
}

/** Colour for each Pokémon type (for bars and badges). */
function typeColor(type) {
    const colors = {
        normal:'#a8a878',fire:'#f08030',water:'#6890f0',electric:'#f8d030',
        grass:'#78c850',ice:'#98d8d8',fighting:'#c03028',poison:'#a040a0',
        ground:'#e0c068',flying:'#a890f0',psychic:'#f85888',bug:'#a8b820',
        rock:'#b8a038',ghost:'#705898',dragon:'#7038f8',dark:'#705848',
        steel:'#b8b8d0',fairy:'#ee99ac'
    };
    return colors[type] || '#888';
}

