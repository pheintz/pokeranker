// ─── Rankings ────────────────────────────────────────────────────────────────
// Rankings are loaded lazily from local CSV files (one per league CP cap).
// Each CSV lists Pokémon in meta-rank order; we build a map of speciesId → rank index.

const rankingsCache   = {};   // cpCap → { speciesId: zeroBasedRankIndex }
const rankingsLoading = {};   // cpCap → Promise (prevents duplicate fetches)

async function loadRankings(cpCap) {
    if (rankingsCache[cpCap]) return rankingsCache[cpCap];
    if (rankingsLoading[cpCap]) return rankingsLoading[cpCap];

    rankingsLoading[cpCap] = (async () => {
        const url = `./csv/cp${cpCap}_all_overall_rankings.csv`;
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

        // speciesId is almost always the first column; search as fallback
        let idCol = headers.indexOf('specieid');
        if (idCol < 0) idCol = headers.indexOf('speciesid');
        if (idCol < 0) idCol = headers.findIndex(h => h.includes('species') || h.includes('id') || h === 'mon');
        if (idCol < 0) idCol = 0;

        const rankMap = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
            const id = cols[idCol];
            if (id) rankMap[id.toLowerCase()] = i - 1; // zero-based rank index
        }

        rankingsCache[cpCap] = rankMap;
        return rankMap;
    })();

    return rankingsLoading[cpCap];
}

function setRankStatusDisplay(state, message) {
    const el = document.getElementById('rank-status');
    el.className = `rank-status rank-${state}`;
    el.textContent = message;
}

async function onLeagueChange() {
    const cpCap = +document.getElementById('league').value;
    if (rankingsCache[cpCap]) return; // already loaded
    setRankStatusDisplay('loading', 'Loading rankings…');
    try {
        await loadRankings(cpCap);
        setRankStatusDisplay('ok', 'Rankings loaded ✓');
    } catch (err) {
        setRankStatusDisplay('err', 'Rankings unavailable');
        console.warn('Could not load rankings:', err);
    }
}

// Pre-load the default league on page open
(async () => {
    try {
        await loadRankings(1500);
        setRankStatusDisplay('ok', 'Rankings loaded ✓');
    } catch (err) {
        setRankStatusDisplay('err', 'Rankings unavailable — meta sorting disabled');
        console.warn('Could not load GL rankings:', err);
    }
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

/** Look up base stats [attack, defense, stamina] for a species.
 *  Falls back to the base form (before the first underscore) if the
 *  exact key isn't found — covers minor form variants. */
function lookupStats(speciesId) {
    return POKEMON_STATS[speciesId] || POKEMON_STATS[speciesId.split('_')[0]] || null;
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
    const cpCap       = +document.getElementById('league').value;
    const allowXl     = document.getElementById('xl').checked;
    const highestEvo  = document.getElementById('dedup').checked;
    const only98pct   = document.getElementById('f98').checked;
    const maxLevelIdx = LEVELS.indexOf(allowXl ? 50 : 40);
    const outputEl    = document.getElementById('out');

    if (!csvText) {
        outputEl.innerHTML = '<p style="color:#555;font-size:13px;">Paste your CalcyIV export first.</p>';
        return;
    }

    const { rows, err } = parseCalcyIvExport(csvText);
    if (err) {
        outputEl.innerHTML = `<p style="color:#f87171;font-size:13px;">${err}</p>`;
        return;
    }
    if (!rows.length) {
        outputEl.innerHTML = '<p style="color:#555;">No valid rows.</p>';
        return;
    }

    // Load meta rankings for the selected league
    let rankMap = {};
    try {
        rankMap = await loadRankings(cpCap);
        setRankStatusDisplay('ok', 'Rankings loaded ✓');
    } catch (err) {
        setRankStatusDisplay('err', `Rankings unavailable — ${err.message}`);
        console.error('Rankings load failed:', err);
    }

    outputEl.innerHTML = `<p style="color:#555;font-size:13px;">Computing ranks for ${rows.length} Pokémon…</p>`;

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

            // ── Resolve the STA IV ──────────────────────────────────────────
            // CalcyIV's ØHP IV is a floored average and may be ambiguous when
            // two adjacent STA IVs produce the same in-game HP. We solve it
            // exactly from (baseSta, HP, level) when those fields are present.
            let staIv            = row.staIv;   // fallback: CalcyIV estimate
            let staIvIsExact     = false;
            let staIvCandidates  = null;         // set when HP is ambiguous

            if (row.level != null && row.hp != null && CPM[row.level]) {
                const validStaIvs = findValidStaIvs(baseStats[2], row.hp, row.level);
                if (validStaIvs) {
                    staIv        = validStaIvs[0];
                    staIvIsExact = true;
                    if (validStaIvs.length > 1) staIvCandidates = validStaIvs;
                }
            }

            // ── Walk the evolution chain ────────────────────────────────────
            const evoChain       = getEvolutionChain(speciesId);
            const eligibleIds    = new Set();
            const candidates     = [];

            for (const evoId of evoChain) {
                const evoStats = lookupStats(evoId);
                if (!evoStats) continue;
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
                let rankResult, staIvRange = null, displayStaIv = staIv;

                if (staIvCandidates) {
                    // Ambiguous STA IV: compute for all candidates, pick the best stat product
                    const results = staIvCandidates.map(iv =>
                        computeRankResult(evoAtk, evoDef, evoSta, row.atkIv, row.defIv, iv, cpCap, maxLevelIdx, row.shadow)
                    );
                    const bestIdx = results.reduce((best, r, i) => r.statProduct > results[best].statProduct ? i : best, 0);
                    rankResult    = results[bestIdx];
                    displayStaIv  = staIvCandidates[bestIdx];

                    const allMaxCps = results.map(r => r.maxCp);
                    staIvRange = {
                        staIvMin: staIvCandidates[0],
                        staIvMax: staIvCandidates[staIvCandidates.length - 1],
                        cpMin:    Math.min(...allMaxCps),
                        cpMax:    Math.max(...allMaxCps),
                    };
                } else {
                    rankResult = computeRankResult(evoAtk, evoDef, evoSta, row.atkIv, row.defIv, staIv, cpCap, maxLevelIdx, row.shadow);
                }

                if (!grouped.has(evoId)) grouped.set(evoId, []);
                grouped.get(evoId).push({ row, staIv: displayStaIv, staIvIsExact, rankResult, isSelf, overCap, staIvRange });
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
        lastAnalysisBox = new Set();
        lastAnalysisBox98 = new Set();
        let totalCount = 0, count95pct = 0, count98pct = 0, rank1Count = 0;
        for (const { evoId, entries } of sortedGroups) {
            lastAnalysisBox.add(evoId);
            for (const entry of entries) {
                totalCount++;
                if (entry.rankResult.pct >= 95) count95pct++;
                if (entry.rankResult.pct >= 98) {
                    count98pct++;
                    lastAnalysisBox98.add(evoId);
                }
                if (entry.rankResult.rank === 1) rank1Count++;
            }
        }

        // ── Build HTML ────────────────────────────────────────────────────
        let html = `
            <div class="cards">
                <div class="card"><div class="card-label">Species groups</div><div class="card-value">${sortedGroups.length}</div></div>
                <div class="card"><div class="card-label">Total entries</div><div class="card-value">${totalCount}</div></div>
                <div class="card"><div class="card-label">98%+ quality</div><div class="card-value">${count98pct}</div></div>
                <div class="card"><div class="card-label">95%+ quality</div><div class="card-value">${count95pct}</div></div>
                <div class="card"><div class="card-label">Rank 1 IVs</div><div class="card-value">${rank1Count}</div></div>
            </div>`;

        for (const { evoId, entries, metaRank } of sortedGroups) {
            // Apply 98% filter
            const visibleEntries = only98pct ? entries.filter(e => e.rankResult.pct >= 98) : entries;
            if (!visibleEntries.length) continue;

            const isMetaRanked = metaRank < Infinity;
            const metaLabel = isMetaRanked
                ? `<span class="meta-rank">Meta #${metaRank + 1}</span>`
                : `<span class="meta-unranked">Unranked</span>`;
            const bestBadge = rankBadge(visibleEntries[0].rankResult.rank);
            const candidateWord = visibleEntries.length === 1 ? 'candidate' : 'candidates';

            html += `
                <div class="group">
                    <div class="group-header">
                        <span class="group-name">${toTitleCase(evoId)}</span>
                        ${metaLabel}
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

            for (const { row, staIv, staIvIsExact, rankResult, isSelf, overCap, staIvRange } of visibleEntries) {
                const { rank, statProduct, pct, optLevel, maxCp } = rankResult;

                const shadowTag  = row.shadow  ? '<span class="tag-shadow">shadow</span>'  : '';
                const evoTag     = !isSelf      ? '<span class="tag-evo">evo</span>'        : '';
                const overCapTag = overCap
                    ? '<span class="tag-overcap" title="Already over GL cap at scanned level — GL rank shown for IV planning">over cap</span>'
                    : '';
                const approxTag  = staIvIsExact ? '' : '<span class="approx" title="HP IV estimated from avg">~</span>';
                const nicknameTag = row.nickname ? ` <span class="nickname">(${row.nickname})</span>` : '';

                // When STA IV is ambiguous, show a range in both the IV and Max CP cells
                const isStaIvAmbiguous = staIvRange && staIvRange.staIvMin !== staIvRange.staIvMax;
                const ivCellContent = isStaIvAmbiguous
                    ? `${row.atkIv}/${row.defIv}/<span title="STA IV ambiguous: both ${staIvRange.staIvMin} and ${staIvRange.staIvMax} match in-game HP">${staIvRange.staIvMin}–${staIvRange.staIvMax}</span>`
                    : `${row.atkIv}/${row.defIv}/${staIv}${approxTag}`;
                const cpCellContent = isStaIvAmbiguous && staIvRange.cpMin !== staIvRange.cpMax
                    ? `<span title="CP range due to ambiguous STA IV (${staIvRange.staIvMin}–${staIvRange.staIvMax})">${staIvRange.cpMin}–${staIvRange.cpMax}</span>`
                    : maxCp;

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
                    </table>
                </div>`;
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
 * Returns a composite score weighting EPT (energy generation) and DPT (damage).
 * Competitive baseline: 3 DPT / 3 EPT. Counter (4 DPT / 3.5 EPT) is the gold standard.
 */
function scoreFastMove(moveId, pokemonTypes) {
    const fm = FAST_MOVES[moveId];
    if (!fm) return { id: moveId, score: 0, ept: 0, dpt: 0, type: 'normal', stab: false };
    const ept = fm.nrg / fm.turns;
    const dpt = fm.pow / fm.turns;
    const stab = pokemonTypes.includes(fm.type);
    const effectiveDpt = dpt * (stab ? STAB_MULT : 1);
    // EPT weighted 60%, DPT 40% — energy generation is king in PvP
    // but DPT matters for farm-down scenarios and closing without charged moves
    const score = ept * 0.6 + effectiveDpt * 0.4;
    return { id: moveId, score, ept, dpt, effectiveDpt, type: fm.type, stab, turns: fm.turns };
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

    // Determine role: bait (<=40 energy), closer/nuke (>=55), mid-range
    let role = 'mid';
    if (cm.nrg <= 40) role = 'bait';
    else if (cm.nrg >= 55) role = 'nuke';

    // Special effect value (stat buffs/debuffs)
    let effectValue = 0;
    const eff = typeof MOVE_EFFECTS !== 'undefined' ? MOVE_EFFECTS[moveId] : null;
    if (eff) {
        // Self buffs are very valuable (Power-Up Punch = game-changing)
        if (eff.selfBuff) {
            const [atkBuff, defBuff] = eff.selfBuff;
            effectValue += (atkBuff * 0.4 + defBuff * 0.25) * eff.chance;
        }
        // Self debuffs are a cost (Close Combat, Superpower)
        if (eff.selfDebuff) {
            const [atkDeb, defDeb] = eff.selfDebuff;
            effectValue += (atkDeb * 0.15 + defDeb * 0.15) * eff.chance; // negative values = penalty
        }
        // Opponent debuffs are valuable (Icy Wind, Acid Spray)
        if (eff.oppDebuff) {
            const [atkDeb, defDeb] = eff.oppDebuff;
            effectValue += (Math.abs(atkDeb) * 0.3 + Math.abs(defDeb) * 0.3) * eff.chance;
        }
    }

    // Composite: DPE weighted by role + effect value
    // Bait moves: value cheapness (low energy) more than raw damage
    // Nukes: value raw damage output
    let score;
    if (role === 'bait') {
        score = effectiveDpe * 0.5 + (1 - cm.nrg / 80) * 0.8 + effectValue * 0.6;
    } else if (role === 'nuke') {
        score = effectiveDpe * 0.8 + (cm.pow / 150) * 0.4 + effectValue * 0.3;
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

    // Score all fast moves
    const fastScored = moveset.fast.map(fid => scoreFastMove(fid, pokemonTypes)).filter(f => f.score > 0);
    if (fastScored.length === 0) return null;

    // Score all charged moves
    const chargedScored = moveset.charged.map(cid => scoreChargedMove(cid, pokemonTypes)).filter(c => c.score > 0);
    if (chargedScored.length === 0) return null;

    // Meta offensive scoring function
    function metaOffScore(moveTypeSet) {
        if (!metaEntries || metaEntries.length === 0) return 1.0;
        let offSum = 0, wSum = 0;
        for (const { types: oppTypes, weight } of metaEntries) {
            let bestMult = 0;
            for (const mt of moveTypeSet) {
                const mult = typeEffectiveness(mt, oppTypes[0], oppTypes[1] || null);
                if (mult > bestMult) bestMult = mult;
            }
            offSum += bestMult * weight;
            wSum += weight;
        }
        return wSum > 0 ? offSum / wSum : 1.0;
    }

    let bestCombo = null, bestScore = -Infinity;

    for (const fast of fastScored) {
        for (let i = 0; i < chargedScored.length; i++) {
            for (let j = i; j < chargedScored.length; j++) {
                const c1 = chargedScored[i], c2 = chargedScored[j];

                // ── Bait + Nuke structure bonus ──
                // Reward having one cheap move and one heavy hitter
                let structureBonus = 0;
                const cheapest = Math.min(c1.nrg, c2.nrg);
                const costliest = Math.max(c1.nrg, c2.nrg);
                const hasBait = cheapest <= 40;
                const hasNuke = costliest >= 50;
                if (hasBait && hasNuke && i !== j) {
                    structureBonus = 0.3; // strong bait+nuke structure
                    // Extra bonus for big energy gap (more baiting potential)
                    structureBonus += Math.min(0.15, (costliest - cheapest) / 200);
                } else if (i !== j) {
                    structureBonus = 0.1; // two charged moves always better than one
                }

                // ── Type coverage diversity bonus ──
                const moveTypeSet = new Set([fast.type, c1.type, c2.type]);
                let coverageBonus = 0;
                if (i !== j && c1.type !== c2.type) coverageBonus += 0.2; // different charged types
                if (fast.type !== c1.type && fast.type !== c2.type) coverageBonus += 0.1; // fast adds coverage

                // ── Meta SE coverage ──
                const metaOff = metaOffScore(moveTypeSet);

                // ── Shield pressure: turns to first charged move ──
                const turnsToCharge = cheapest / fast.ept;
                const pressureScore = Math.max(0, Math.min(1, (18 - turnsToCharge) / 14));

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

/**
 * Get the move types from a Pokémon's optimal moveset (1 fast + up to 2 charged).
 * Falls back to STAB types if no curated moveset exists.
 */
function getMoveTypes(speciesId) {
    const optimal = pickOptimalMoveset(speciesId, null);
    if (optimal) return optimal.moveTypes;
    const pokemonTypes = typeof POKEMON_TYPES !== 'undefined' ? POKEMON_TYPES[speciesId] : null;
    return pokemonTypes ? [...pokemonTypes] : [];
}

/**
 * Compute a composite efficiency score (0–1) for a Pokémon.
 * Considers: best fast move quality, bait potential, charged move damage output.
 */
function moveEfficiencyScore(speciesId) {
    const optimal = pickOptimalMoveset(speciesId, null);
    if (!optimal) return 0.5;
    // Normalise: totalMoveScore typically ranges from ~1.0 (bad) to ~3.0 (elite)
    return Math.max(0, Math.min(1, (optimal.totalMoveScore - 0.8) / 2.2));
}

/**
 * Legacy wrapper — returns the optimal moveset in the format the UI expects.
 */
function getOptimalMoveset(speciesId) {
    return pickOptimalMoveset(speciesId, null);
}

// ─── Mini Battle Simulator ──────────────────────────────────────────────────
// Simulates turn-by-turn 1v1 PvP battles using real Pokemon GO mechanics.
// Used to produce a "Battle Rating" that combines stats + movesets into one number.

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
                        hp:  Math.floor((bSta + s) * cpm),
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

/**
 * Compute PvP damage for one attack.
 * @param {number} power      Move power
 * @param {number} atkStat    Attacker's effective attack
 * @param {number} defStat    Defender's effective defense
 * @param {number} stab       1.2 if STAB, else 1.0
 * @param {number} eff        Type effectiveness multiplier
 * @returns {number} Damage dealt (minimum 1)
 */
function pvpDamage(power, atkStat, defStat, stab, eff) {
    return Math.floor(0.5 * power * (atkStat / defStat) * stab * eff) + 1;
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
 * @returns {{ winner: 'a'|'b'|'tie', aHpLeft: number, bHpLeft: number, aHpPct: number, bHpPct: number }}
 */
function simulateBattle(a, b, shieldsA, shieldsB, seed) {
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

    function applyMoveEffects(moveId, userIsA) {
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
        if (fx.oppDebuff) {
            if (userIsA) { bAtkStage = clampStage(bAtkStage + fx.oppDebuff[0]); bDefStage = clampStage(bDefStage + fx.oppDebuff[1]); }
            else         { aAtkStage = clampStage(aAtkStage + fx.oppDebuff[0]); aDefStage = clampStage(aDefStage + fx.oppDebuff[1]); }
        }
    }

    // ── Dynamic damage (recomputed each use to reflect current stat stages) ──
    function pvpDmg(pow, atkBase, atkStage, defBase, defStage, stab, eff) {
        return Math.floor(0.5 * pow * (atkBase * stageMult(atkStage)) / (defBase * stageMult(defStage)) * stab * eff) + 1;
    }
    function aFastDmg() { return pvpDmg(a.fast.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.fast.type, a.types), calcEff(a.fast.type, b.types)); }
    function bFastDmg() { return pvpDmg(b.fast.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.fast.type, b.types), calcEff(b.fast.type, a.types)); }
    function aC1Dmg()   { return pvpDmg(a.charged1.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.charged1.type, a.types), calcEff(a.charged1.type, b.types)); }
    function aC2Dmg()   { return a.charged2 ? pvpDmg(a.charged2.pow, a.atk, aAtkStage, b.def, bDefStage, calcStab(a.charged2.type, a.types), calcEff(a.charged2.type, b.types)) : 0; }
    function bC1Dmg()   { return pvpDmg(b.charged1.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.charged1.type, b.types), calcEff(b.charged1.type, a.types)); }
    function bC2Dmg()   { return b.charged2 ? pvpDmg(b.charged2.pow, b.atk, bAtkStage, a.def, aDefStage, calcStab(b.charged2.type, b.types), calcEff(b.charged2.type, a.types)) : 0; }

    // ── Stochastic charged move AI ───────────────────────────────────────────
    // Returns { dmg, nrg, id } — damage snapshotted at decision time with current stages.
    // Strategy: guarantee KO when possible, 75% bait when shields up, 85% nuke when shields down.
    // Nuke = higher effective DPE (damage per energy) move; bait = lower effective DPE.
    // When only the bait is affordable but the nuke is within 20 energy, wait for the nuke.
    function pickChargedMove(energy, c1, c1Dmg, c2, c2Dmg, oppHp, oppShields) {
        const have1 = energy >= c1.nrg;
        const have2 = c2 && energy >= c2.nrg;
        if (!have1 && !have2) return null;

        // Identify nuke (higher effective DPE) vs bait (lower effective DPE).
        const c1IsNuke = !c2 || (c1Dmg / c1.nrg >= c2Dmg / c2.nrg);
        const nuke = c1IsNuke ? { dmg: c1Dmg, nrg: c1.nrg, id: c1.id }
                              : { dmg: c2Dmg, nrg: c2.nrg, id: c2.id };
        const bait = c1IsNuke ? (c2 ? { dmg: c2Dmg, nrg: c2.nrg, id: c2.id } : nuke)
                              : { dmg: c1Dmg, nrg: c1.nrg, id: c1.id };
        const haveNuke = c1IsNuke ? have1 : have2;
        const haveBait = c1IsNuke ? (c2 ? have2 : have1) : have1;

        // Only bait affordable: fire bait to waste opponent's shield when shields are up.
        // When opponent has no shields, wait for nuke if it's close (≤20 energy away).
        if (haveBait && !haveNuke) {
            const nukeNrg = c1IsNuke ? c1.nrg : c2.nrg;
            if (oppShields === 0 && nukeNrg - energy <= 20) return null; // wait for nuke
            return bait; // fire bait to pressure shields (or nuke is too far away)
        }
        // Only nuke affordable (or single-move): fire it.
        if (haveNuke && !haveBait) return nuke;

        // Both ready: guarantee KO when possible, then stochastic bait/nuke.
        if (oppShields === 0 && nuke.dmg >= oppHp) return nuke;
        if (oppShields === 0 && bait.dmg >= oppHp) return bait;
        return oppShields > 0 ? (rand() < 0.75 ? bait : nuke)
                              : (rand() < 0.85 ? nuke : bait);
    }

    let aHp = a.hp, bHp = b.hp;
    let aEnergy = 0, bEnergy = 0;
    let aShields = shieldsA, bShields = shieldsB;
    let aTurnCd = 0, bTurnCd = 0;

    for (let turn = 0; turn < 500; turn++) {
        if (aHp <= 0 || bHp <= 0) break;

        // ── Attacker charged move ────────────────────────────────────────────
        if (aTurnCd === 0) {
            const pick = pickChargedMove(aEnergy, a.charged1, aC1Dmg(), a.charged2, aC2Dmg(), bHp, bShields);
            if (pick) {
                aEnergy -= pick.nrg;
                applyMoveEffects(pick.id, true); // stat effects fire even when shielded
                if (bShields > 0) { bShields--; bHp -= 1; }
                else { bHp -= pick.dmg; }
            } else {
                aTurnCd = a.fast.turns;
            }
        }

        // ── Defender charged move ────────────────────────────────────────────
        if (bTurnCd === 0) {
            const pick = pickChargedMove(bEnergy, b.charged1, bC1Dmg(), b.charged2, bC2Dmg(), aHp, aShields);
            if (pick) {
                bEnergy -= pick.nrg;
                applyMoveEffects(pick.id, false);
                if (aShields > 0) { aShields--; aHp -= 1; }
                else { aHp -= pick.dmg; }
            } else {
                bTurnCd = b.fast.turns;
            }
        }

        // ── Fast move completions ────────────────────────────────────────────
        if (aTurnCd > 0) {
            aTurnCd--;
            if (aTurnCd === 0) {
                bHp -= aFastDmg();
                aEnergy = Math.min(100, aEnergy + a.fast.nrg);
            }
        }
        if (bTurnCd > 0) {
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
    return { winner, aHpLeft: aHp, bHpLeft: bHp, aHpPct: aHp / a.hp, bHpPct: bHp / b.hp };
}

/**
 * Build a battle-ready Pokemon object for the simulator from a speciesId.
 * Uses rank-1 IVs at the given CP cap and optimal moveset vs meta.
 * @returns {object|null} { speciesId, atk, def, hp, types, fast, charged1, charged2 }
 */
function buildBattler(speciesId, cpCap, metaEntries) {
    const stats = getRank1Stats(speciesId, cpCap);
    if (!stats) return null;

    const types = POKEMON_TYPES[speciesId] || ['normal'];
    const optimal = pickOptimalMoveset(speciesId, metaEntries || null);

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

    return {
        speciesId, types,
        atk: stats.atk, def: stats.def, hp: stats.hp,
        fast, charged1, charged2
    };
}

// Cache for battler objects
const battlerCache = {};
function getCachedBattler(speciesId, cpCap, metaEntries) {
    const key = speciesId + '|' + cpCap;
    if (!battlerCache[key]) battlerCache[key] = buildBattler(speciesId, cpCap, metaEntries);
    return battlerCache[key];
}

/**
 * Compute a battle rating for a Pokemon by simulating 1v1s against top N meta.
 * Runs multi-shield scenarios (0s, 1s, 2s) weighted 20%/60%/20% by real-game prevalence.
 *
 * @param {string} speciesId
 * @param {number} cpCap
 * @param {Array} metaEntries  Array of { id, types, weight }
 * @param {number} topN        Number of meta opponents to sim against (default 50)
 * @returns {{ battleRating: number, wins: number, losses: number, ties: number, total: number }|null}
 */
function computeBattleRating(speciesId, cpCap, metaEntries, topN) {
    topN = topN || 50;
    const attacker = getCachedBattler(speciesId, cpCap, metaEntries);
    if (!attacker) return null;

    const opponents = metaEntries.slice(0, topN);
    let totalScore = 0, wins = 0, losses = 0, ties = 0, simCount = 0;

    // Multi-shield scenarios weighted by real-game prevalence
    const shieldScenarios = [
        { sA: 0, sB: 0, weight: 0.20 },   // no shields (lead gets caught, swap scenarios)
        { sA: 1, sB: 1, weight: 0.60 },   // 1-shield (most common mid-game state)
        { sA: 2, sB: 2, weight: 0.20 },   // 2-shield (opening lead matchup)
    ];

    for (const opp of opponents) {
        if (opp.id === speciesId) continue; // skip mirror
        const defender = getCachedBattler(opp.id, cpCap, metaEntries);
        if (!defender) continue;

        simCount++;
        let matchupScore = 0;
        let matchupWin = false, matchupLoss = false;

        for (const sc of shieldScenarios) {
            const result = simulateBattle(attacker, defender, sc.sA, sc.sB);

            let scScore;
            if (result.winner === 'a') {
                scScore = 0.5 + (result.aHpPct * 0.5);
            } else if (result.winner === 'tie') {
                scScore = 0.5;
            } else {
                scScore = (1 - result.bHpPct) * 0.5;
            }
            matchupScore += scScore * sc.weight;
        }

        totalScore += matchupScore;
        // Classify overall matchup result based on blended score
        if (matchupScore >= 0.55) wins++;
        else if (matchupScore <= 0.45) losses++;
        else ties++;
    }

    if (simCount === 0) return null;

    // Battle rating: 0–1000 scale
    const battleRating = Math.round((totalScore / simCount) * 1000);

    return { battleRating, wins, losses, ties, total: simCount };
}

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

    // 1. Compute battle ratings for every entry
    for (const entry of scored) {
        if (entry.battleRating == null) {
            const br = computeBattleRating(entry.id, cpCap, metaEntries, 50);
            entry.battleRating  = br ? br.battleRating  : null;
            entry.battleWins    = br ? br.wins           : null;
            entry.battleLosses  = br ? br.losses         : null;
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
 *   - Anti-meta / spice bonus: off-meta picks get a familiarity advantage
 *   - Shield pressure: fast energy generation for bait potential
 * Team building uses role-aware greedy coverage with ABB detection.
 */
function buildMetaBreakerTeams(cpCap) {
    const rankMap = rankingsCache[cpCap] || {};
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

    // Top 100 meta set for spice calculation
    const top100Meta = new Set(
        Object.entries(rankMap).sort(([,a],[,b]) => a - b).slice(0, 100).map(([id]) => id)
    );

    // Score every Pokémon in the DB
    const allScored = [];
    for (const speciesId of Object.keys(POKEMON_STATS)) {
        const pokemonTypes = typeof POKEMON_TYPES !== 'undefined' ? POKEMON_TYPES[speciesId] : null;
        if (!pokemonTypes) continue;

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

        // ── Anti-meta / spice bonus ──
        // Pokemon outside top 100 get a bonus representing the "unpredictability tax":
        // opponents don't know their move counts, can't predict charge timing, misplay shields
        let spiceBonus = 0;
        if (!top100Meta.has(speciesId)) {
            spiceBonus = 0.08; // base surprise factor
            // Even bigger bonus if they have a curated moveset (viable spice, not meme)
            if (optimal && optimal.totalMoveScore > 1.5) spiceBonus += 0.05;
        }

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
            + spiceBonus                                           // anti-meta surprise value
            + statEffectBonus                                      // stat buff/debuff utility
            + (coverage.offScore > 1.3 ? 0.05 : 0);              // SE coverage jackpot

        allScored.push({
            id: speciesId,
            types: pokemonTypes,
            moveTypes,
            defScore: coverage.defScore,
            offScore: coverage.offScore,
            coverageScore: coverage.totalScore,
            efficiency,
            pressureScore,
            spiceBonus,
            finalScore,
            metaRank: rankMap[speciesId] ?? null,
            optimal,
        });
    }

    allScored.sort((a, b) => b.finalScore - a.finalScore);

    // ── Fuse heuristic + battle-sim scores via Reciprocal Rank Fusion ──
    // Computes battle ratings for all candidates and re-sorts using RRF.
    applyRRF(allScored, cpCap, metaEntries);

    // ── Team building: role-aware greedy with ABB detection ──
    const teams = [];
    const usedAsLead = new Set();
    const seenTeamKeys = new Set();
    const maxAttempts = 20; // try extra iterations to fill 5 distinct teams

    for (let t = 0; t < maxAttempts && teams.length < 5; t++) {
        const team = [];
        const teamTypes = new Set();
        const teamWeaknesses = [];
        const teamDefTypes = []; // track defensive types on team

        for (let slot = 0; slot < 3; slot++) {
            let bestPick = null, bestVal = -Infinity;

            for (const cand of allScored) {
                if (team.some(m => m.id === cand.id)) continue;
                if (slot === 0 && usedAsLead.has(cand.id)) continue;

                let val = cand.finalScore;

                // ── Offensive novelty: bonus for new type coverage ──
                let novelty = 0;
                for (const mt of cand.moveTypes) {
                    if (!teamTypes.has(mt)) novelty += 0.12;
                }
                val += novelty;

                // ── Defensive synergy: bonus for resisting team weaknesses ──
                let shoreUp = 0;
                for (const weakType of teamWeaknesses) {
                    const mult = typeEffectiveness(weakType, cand.types[0], cand.types[1] || null);
                    if (mult < 1) shoreUp += 0.15 * (1 - mult);
                }
                val += shoreUp;

                // ── Shared weakness penalty: avoid stacking same vulnerability ──
                let sharedWeakPenalty = 0;
                for (const tType of TYPES_LIST) {
                    const mult = typeEffectiveness(tType, cand.types[0], cand.types[1] || null);
                    if (mult > 1.0) {
                        // Count how many existing team members are also weak to this
                        let alreadyWeak = 0;
                        for (const tm of team) {
                            const tmMult = typeEffectiveness(tType, tm.types[0], tm.types[1] || null);
                            if (tmMult > 1.0) alreadyWeak++;
                        }
                        if (alreadyWeak > 0) sharedWeakPenalty += 0.12 * alreadyWeak;
                    }
                }
                val -= sharedWeakPenalty;

                // ── Role bonus: slot 0=lead (balanced), slot 1=safe swap (flexible), slot 2=closer (nuke power) ──
                if (slot === 0 && cand.pressureScore > 0.5) val += 0.05;  // leads want fast pressure
                if (slot === 2 && cand.optimal && cand.optimal.charged1Info) {
                    // Closers want high damage nukes
                    const nukeInfo = cand.optimal.charged2Info || cand.optimal.charged1Info;
                    if (nukeInfo && nukeInfo.pow >= 80) val += 0.05;
                }

                if (val > bestVal) { bestVal = val; bestPick = cand; }
            }

            if (bestPick) {
                team.push(bestPick);
                if (slot === 0) usedAsLead.add(bestPick.id);
                for (const mt of bestPick.moveTypes) teamTypes.add(mt);
                teamDefTypes.push(...bestPick.types);
                for (const tType of TYPES_LIST) {
                    const mult = typeEffectiveness(tType, bestPick.types[0], bestPick.types[1] || null);
                    if (mult > 1.0) teamWeaknesses.push(tType);
                }
            }
        }

        if (team.length === 3) {
            const teamKey = team.map(m => m.id).sort().join('|');
            if (!seenTeamKeys.has(teamKey)) {
                seenTeamKeys.add(teamKey);
                teams.push(team);
            }
        }
    }

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
    const spiceVal = mon.spiceBonus || mon.spiceValue || 0;
    const spiceTag = (spiceVal > 0)
        ? ' <span style="background:#d946ef;color:#fff;padding:0 4px;border-radius:3px;font-size:8px;">SPICE</span>'
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

    return `<div style="flex:1;min-width:200px;background:#0f172a;border:1px solid ${borderColor};border-radius:6px;padding:10px;">
        ${roleTag}
        <div style="font-weight:600;color:#e2e8f0;font-size:14px;">${toTitleCase(mon.id)}${boxTag}${metaTag}${spiceTag}</div>
        <div style="margin:4px 0;">${typesTags}</div>
        <div style="font-size:11px;color:#94a3b8;">
            Coverage: <span style="color:${mon.coverageScore > 1.5 ? '#4ade80' : mon.coverageScore > 1.0 ? '#60a5fa' : '#f87171'}">${mon.coverageScore.toFixed(2)}</span> ·
            Pressure: <span style="color:${pressurePct > 60 ? '#4ade80' : pressurePct > 30 ? '#60a5fa' : '#f87171'}">${pressurePct}%</span> ·
            Score: <span style="font-weight:600;">${mon.displayScore ?? Math.round(mon.finalScore * 30497)}</span>
        </div>
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
            const br = computeBattleRating(allScored[i].id, cpCap, metaEntries, 50);
            if (br) battleRatings[allScored[i].id] = br;
        }
    }
    const hasBR = Object.keys(battleRatings).length > 0;

    html += `<table style="width:100%;"><thead><tr>
        <th>#</th><th>Pokémon</th><th>Types</th><th>Moveset</th>${hasBR ? '<th title="1v1 battle sim vs top 50 meta (0s/1s/2s weighted 20/60/20)">Battle</th>' : ''}<th>Coverage</th><th>Pressure</th><th title="Reciprocal Rank Fusion of heuristic + battle sim (0–1000 scale)">RRF Score</th>
    </tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
        const s = allScored[i];
        const inBox = (userBox || new Set()).has(s.id);
        const boxTag = inBox ? ' <span style="background:#22c55e;color:#000;padding:0 4px;border-radius:3px;font-size:9px;">IN BOX</span>' : '';
        const spiceVal = s.spiceBonus || s.spiceValue || 0;
        const spiceTag = (spiceVal > 0) ? ' <span style="background:#d946ef;color:#fff;padding:0 3px;border-radius:2px;font-size:8px;">SPICE</span>' : '';
        const typesTags = s.types.map(t => `<span class="type-badge type-${t}" style="font-size:10px;">${t}</span>`).join(' ');

        let movesetCell = '<span style="color:#555;">STAB only</span>';
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
                brCell = `<td style="color:#555;">—</td>`;
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
    const cpCap = +document.getElementById('league').value;
    const outEl = document.getElementById('meta-out');
    if (!outEl) return;

    // Ensure rankings loaded
    try { await loadRankings(cpCap); } catch (e) {}

    // Check if meta.js loaded
    if (typeof POKEMON_TYPES === 'undefined' || typeof TYPE_CHART === 'undefined') {
        outEl.innerHTML = '<p style="color:#f87171;">Meta data not loaded. Ensure meta.js is included.</p>';
        return;
    }

    outEl.innerHTML = '<p style="color:#555;">Computing meta-busting teams (running battle simulations — may take a few seconds)...</p>';

    setTimeout(() => {
        const { metaEntries, teams, allScored } = buildMetaBreakerTeams(cpCap);

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
            html += `<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:12px;">
                <div style="font-weight:600;color:#94a3b8;margin-bottom:8px;">Team ${i+1}</div>
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
function buildBoxTeams(cpCap) {
    const rankMap = rankingsCache[cpCap] || {};
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

    const top100Meta = new Set(metaIds);
    const only98pct = document.getElementById('f98').checked;

    // Use the species sets cached from the last Analyze run.
    const sourceBox = only98pct ? lastAnalysisBox98 : lastAnalysisBox;
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

    // Score each box Pokémon — we compute a base score without spice,
    // then store spice separately so each category can apply it differently.
    const boxScored = [];
    for (const speciesId of userBox) {
        const pokemonTypes = POKEMON_TYPES[speciesId];
        if (!pokemonTypes) continue;

        const [a, d, s] = POKEMON_STATS[speciesId] || [0,0,0];
        if (calcCp(a, d, s, 0, 0, 0, LEVELS[0]) > cpCap) continue;

        const optimal = pickOptimalMoveset(speciesId, metaEntries);
        if (!optimal) continue;

        const top30 = metaEntries.slice(0, 30);
        const coverage = scoreTypeCoverage(pokemonTypes, optimal.moveTypes, top30);

        const efficiency = Math.max(0, Math.min(1, (optimal.totalMoveScore - 0.8) / 2.2));
        const pressureScore = optimal.pressureScore || 0;

        const isMeta = top100Meta.has(speciesId);

        // Spice value (stored but not baked into finalScore)
        let spiceValue = 0;
        if (!isMeta) {
            spiceValue = 0.08;
            if (optimal.totalMoveScore > 1.5) spiceValue += 0.05;
        }

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

        boxScored.push({
            id: speciesId,
            types: pokemonTypes,
            moveTypes: optimal.moveTypes,
            optimal,
            defScore: coverage.defScore,
            offScore: coverage.offScore,
            coverageScore: coverage.totalScore,
            efficiency,
            pressureScore,
            spiceValue,
            baseScore,
            finalScore: baseScore + spiceValue, // default combined for table display
            isMeta,
            metaRank: rankMap[speciesId] ?? null,
        });
    }

    boxScored.sort((a, b) => b.finalScore - a.finalScore);

    // ── Fuse heuristic + battle-sim scores via Reciprocal Rank Fusion ──
    applyRRF(boxScored, cpCap, metaEntries);

    // ── Shared team-building helper ──────────────────────────────────────
    function buildTeamsGreedy(candidates, count, scoreFn, slotFilter) {
        const teams = [];
        const usedAsLead = new Set();
        const seenTeamKeys = new Set(); // prevent duplicate teams in any slot order
        const maxAttempts = count * 4;  // try extra iterations to fill quota

        for (let t = 0; t < maxAttempts && teams.length < count; t++) {
            const team = [];
            const teamTypes = new Set();
            const teamWeaknesses = [];

            for (let slot = 0; slot < 3; slot++) {
                // Optional per-slot candidate filtering (for semi-meta)
                const pool = slotFilter ? candidates.filter(c => slotFilter(c, slot, team)) : candidates;

                let bestPick = null, bestVal = -Infinity;

                for (const cand of pool) {
                    if (team.some(m => m.id === cand.id)) continue;
                    if (slot === 0 && usedAsLead.has(cand.id)) continue;

                    let val = scoreFn(cand, slot);

                    // Offensive novelty
                    let novelty = 0;
                    for (const mt of cand.moveTypes) {
                        if (!teamTypes.has(mt)) novelty += 0.12;
                    }
                    val += novelty;

                    // Defensive synergy
                    let shoreUp = 0;
                    for (const weakType of teamWeaknesses) {
                        const mult = typeEffectiveness(weakType, cand.types[0], cand.types[1] || null);
                        if (mult < 1) shoreUp += 0.15 * (1 - mult);
                    }
                    val += shoreUp;

                    // Shared weakness penalty
                    let sharedWeakPenalty = 0;
                    for (const tType of TYPES_LIST) {
                        const mult = typeEffectiveness(tType, cand.types[0], cand.types[1] || null);
                        if (mult > 1.0) {
                            let alreadyWeak = 0;
                            for (const tm of team) {
                                if (typeEffectiveness(tType, tm.types[0], tm.types[1] || null) > 1.0) alreadyWeak++;
                            }
                            if (alreadyWeak > 0) sharedWeakPenalty += 0.12 * alreadyWeak;
                        }
                    }
                    val -= sharedWeakPenalty;

                    // Role bonuses
                    if (slot === 0 && cand.pressureScore > 0.5) val += 0.05;
                    if (slot === 2 && cand.optimal && cand.optimal.charged2Info) {
                        if (cand.optimal.charged2Info.pow >= 80) val += 0.05;
                    }

                    if (val > bestVal) { bestVal = val; bestPick = cand; }
                }

                if (bestPick) {
                    team.push(bestPick);
                    if (slot === 0) usedAsLead.add(bestPick.id);
                    for (const mt of bestPick.moveTypes) teamTypes.add(mt);
                    for (const tType of TYPES_LIST) {
                        const mult = typeEffectiveness(tType, bestPick.types[0], bestPick.types[1] || null);
                        if (mult > 1.0) teamWeaknesses.push(tType);
                    }
                }
            }

            if (team.length === 3) {
                // Deduplicate: sorted IDs form a canonical key regardless of slot order
                const teamKey = team.map(m => m.id).sort().join('|');
                if (!seenTeamKeys.has(teamKey)) {
                    seenTeamKeys.add(teamKey);
                    teams.push(team);
                }
            }
        }
        return teams;
    }

    // ── Category 1: Meta Teams (best proven picks, no spice) ────────────
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
    const metaTeams = buildTeamsGreedy(boxScored, 5, metaScoreFn, null);

    // ── Category 2: Semi-Meta (2 meta + 1 breaker) ─────────────────────
    // Slots 0 & 1 prefer meta, slot 2 must be off-meta.
    const semiScoreFn = (cand, slot) => {
        let s = cand.baseScore;
        if (slot < 2) {
            // Meta slots: slight meta preference
            if (cand.isMeta) s += 0.08;
        } else {
            // Breaker slot: reward spice + anti-meta coverage
            s += cand.spiceValue * 1.5;
            if (!cand.isMeta) s += 0.06;
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
    const semiMetaTeams = buildTeamsGreedy(boxScored, 5, semiScoreFn, semiSlotFilter);

    // ── Category 3: Full Disruption (maximize anti-meta spice) ──────────
    // Boost spice picks, penalize meta-standard choices.
    const disruptionScoreFn = (cand, slot) => {
        let s = cand.baseScore;
        // Heavy spice bonus
        s += cand.spiceValue * 2.0;
        if (!cand.isMeta) {
            s += 0.10; // flat off-meta bonus
            // Extra reward for good coverage from unexpected picks
            if (cand.offScore > 1.2) s += 0.06;
        } else {
            // Discourage meta picks in disruption teams
            s -= 0.10;
        }
        return s;
    };
    const disruptionTeams = buildTeamsGreedy(boxScored, 5, disruptionScoreFn, null);

    return { metaEntries, metaTeams, semiMetaTeams, disruptionTeams, boxScored };
}

/**
 * Render the My Box Builder results into #box-out.
 * Auto-runs Analyze in the background if it hasn't been run yet.
 */
async function runBoxBuilder() {
    const cpCap = +document.getElementById('league').value;
    const outEl = document.getElementById('box-out');
    if (!outEl) return;

    // Validate CSV input — silently bail if nothing is pasted
    const csvText = document.getElementById('csv').value.trim();
    if (!csvText) return;

    const { rows, err } = parseCalcyIvExport(csvText);
    if (err || !rows.length) return; // invalid CSV — do nothing

    // Ensure meta data is loaded
    if (typeof POKEMON_TYPES === 'undefined' || typeof TYPE_CHART === 'undefined') return;

    try { await loadRankings(cpCap); } catch (e) {}

    // If Analyze hasn't been run yet (box sets empty), run it in the background first
    if (lastAnalysisBox.size === 0) {
        outEl.innerHTML = '<p style="color:#555;">Analyzing your box first...</p>';
        await run();
    }

    outEl.innerHTML = '<p style="color:#555;">Building teams from your box (running battle simulations — may take a few seconds)...</p>';

    setTimeout(() => {
        const { metaEntries, metaTeams, semiMetaTeams, disruptionTeams, boxScored } = buildBoxTeams(cpCap);

        if (boxScored.length === 0) {
            const f98 = document.getElementById('f98').checked;
            const hint = f98
                ? 'No Pokémon passed the 98%+ IV filter. Try unchecking "98%+ only" or importing more Pokémon.'
                : 'No eligible box Pokémon found. Click Analyze first to process your CSV.';
            outEl.innerHTML = `<p style="color:#f87171;">${hint}</p>`;
            return;
        }

        let html = `<div style="border-top:2px solid #059669;margin-top:30px;padding-top:20px;">`;
        html += `<h2 style="color:#e2e8f0;margin:0 0 6px;">
            <span style="background:linear-gradient(135deg,#059669,#0891b2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">My Box Builder</span>
        </h2>`;
        const filterNote = document.getElementById('f98').checked ? ' · <span style="color:#4ade80;">98%+ IV filter active</span>' : '';
        html += `<p style="color:#64748b;font-size:13px;margin:0 0 16px;">Teams built from <strong style="color:#10b981;">${boxScored.length}</strong> Pokémon in your box · movesets optimised against top 100 meta · bait+nuke structure${filterNote}</p>`;

        const roles = ['Lead','Safe Swap','Closer'];

        // Helper to render a category of teams
        function renderTeamCategory(teams, title, subtitle, borderColor, titleColor) {
            if (teams.length === 0) return '';
            let s = `<h3 style="margin:20px 0 4px;color:${titleColor};">${title}</h3>`;
            s += `<p style="color:#64748b;font-size:12px;margin:0 0 10px;">${subtitle}</p>`;
            for (let i = 0; i < teams.length; i++) {
                const team = teams[i];
                s += `<div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;padding:12px;margin-bottom:12px;">
                    <div style="font-weight:600;color:${titleColor};margin-bottom:8px;">Team ${i+1}</div>
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
            'Maximum spice — unexpected picks with strong coverage to catch opponents off-guard',
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
