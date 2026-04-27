/**
 * Downloads PvPoke data from the public GitHub repository.
 *
 * 1500-only mode: Pokeranker is a Great League / 1500 CP analyzer. We only
 * fetch rankings-1500.json from each cup. Little Cup (500), Ultra (2500),
 * and Master (10000) are intentionally out of scope. Restricted 1500 cups
 * (Fantasy, Spellcraft, Bayou, Catch, etc.) ARE included — they're 1500 CP
 * with species restrictions.
 *
 * Rankings (auto-discovered via GitHub API):
 *   Source: https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/rankings/{cup}/{category}/rankings-1500.json
 *           where {category} ∈ { overall, leads, switches, closers, attackers }
 *   Output: wwwroot/csv/cp1500_{cup}_overall_rankings.csv
 *           One CSV per cup, with overall ordering and per-role score columns
 *           (leadScore, switchScore, closerScore, attackerScore) joined on speciesId.
 *
 * Gamemaster (moves + pokemon movesets):
 *   Source: https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster/moves.json
 *           https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster/pokemon.json
 *   Output: wwwroot/data/moves.json
 *           wwwroot/data/pokemon.json
 *
 * index.json is auto-generated from all successfully downloaded rankings.
 *
 * The app loads these JSON files at runtime; no rebuild needed after update.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── 1500-only mode ──────────────────────────────────────────────────────────
// Pokeranker is a Great League / 1500-CP-cap analyzer. We don't pull rankings
// for Little Cup (500), Ultra (2500), or Master (10000). Restricted 1500 cups
// (Fantasy, Spellcraft, Catch, etc.) are kept — they're 1500 with species
// restrictions, which is exactly what we want.
const TARGET_CP = 1500;

// ─── Human-readable labels for known cups ────────────────────────────────────
// New cups discovered via API will fall back to a title-cased version of the ID.
const CUP_LABELS = {
  all:           null,                 // 'all' at 1500 CP → "Great League"
  remix:         'GL Remix',
  classic:       'Classic GL',
  premier:       'Premier Cup',
  fantasy:       'Fantasy Cup',
  spring:        'Spring Cup',
  jungle:        'Jungle Cup',
  electric:      'Electric Cup',
  retro:         'Retro Cup',
  maelstrom:     'Maelstrom Cup',
  spellcraft:    'Spellcraft Cup',
  equinox:       'Equinox Cup',
  chrono:        'Chrono Cup',
  bayou:         'Bayou Cup',
  catch:         'Catch Cup',
  laic2025remix: 'LAIC 2025 Remix',
  naic2026:      'NAIC 2026',
};

const CP_LABELS = {
  1500: 'Great League',
};

// Cups that restrict the eligible species pool (not just CP-capped open formats).
// All entries here are 1500 CP — non-1500 cups have been removed.
const RESTRICTED_CUPS = new Set([
  'fantasy', 'spring', 'jungle', 'electric', 'retro', 'maelstrom',
  'spellcraft', 'equinox', 'chrono', 'bayou', 'catch',
  'classic', 'remix', 'premier', 'laic2025remix', 'naic2026',
]);

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const REPO       = 'pvpoke/pvpoke';
const BRANCH     = 'master';

const downloadPath   = path.resolve(__dirname, 'downloads');
const dataOutputPath = path.resolve(__dirname, '..', 'wwwroot', 'data');
const csvOutputPath  = path.resolve(__dirname, '..', 'wwwroot', 'csv');
fs.mkdirSync(downloadPath,   { recursive: true });
fs.mkdirSync(dataOutputPath, { recursive: true });
fs.mkdirSync(csvOutputPath,  { recursive: true });

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const HTTP_TIMEOUT_MS = 15000;

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'pokeranker-ci/1.0 (github.com)',
      'Accept':     'application/json',
      ...extraHeaders,
    };
    const req = https.get(url, { headers, timeout: HTTP_TIMEOUT_MS }, res => {
      // Drain non-2xx responses so the socket can be reused/closed.
      // Skipping this leaks sockets and eventually stalls the entire script
      // when many 404s pile up against the keep-alive pool.
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end',  () => resolve(data));
    });
    // node's `timeout` event fires but does NOT abort the request — we have to.
    req.on('timeout', () => req.destroy(new Error(`timeout after ${HTTP_TIMEOUT_MS}ms for ${url}`)));
    req.on('error', reject);
  });
}

async function fetchJson(url, extraHeaders = {}) {
  const text = await httpGet(url, extraHeaders);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`JSON parse failed for ${url}: ${e.message}`); }
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

const GH_HEADERS = { 'Authorization': process.env.GITHUB_TOKEN ? `token ${process.env.GITHUB_TOKEN}` : undefined };

async function listDir(repoPath) {
  const url = `${GITHUB_API}/repos/${REPO}/contents/${repoPath}?ref=${BRANCH}`;
  const entries = await fetchJson(url, GH_HEADERS);
  if (!Array.isArray(entries)) {
    console.warn(`  [warn] GitHub API returned non-array for ${repoPath}`);
    return [];
  }
  return entries;
}

// ─── Rankings downloader ──────────────────────────────────────────────────────

// PvPoke publishes per-role rankings as siblings of overall/. Same filename
// pattern (rankings-{cp}.json), same entry shape, but `score` is role-specific.
const ROLE_CATEGORIES = ['leads', 'switches', 'closers', 'attackers'];

async function fetchRoleRankings(cupId, cp) {
  const fetches = ROLE_CATEGORIES.map(async role => {
    const url  = `${GITHUB_RAW}/${REPO}/${BRANCH}/src/data/rankings/${cupId}/${role}/rankings-${cp}.json`;
    const data = await fetchJson(url);
    return [role, Array.isArray(data) ? data : []];
  });
  return Object.fromEntries(await Promise.all(fetches));
}

function rankingsToCsv({ overall, leads, switches, closers, attackers }) {
  const scoreById = role => new Map(role.map(e => [e.speciesId, e.score]));
  const leadScore     = scoreById(leads);
  const switchScore   = scoreById(switches);
  const closerScore   = scoreById(closers);
  const attackerScore = scoreById(attackers);

  // Pack PvPoke's per-Pokemon matchups/counters arrays into single CSV cells
  // as semicolon-separated `opponentId:rating` pairs. PvPoke speciesIds never
  // contain `:` or `;` so the encoding is unambiguous. We cap at the first 8
  // entries — PvPoke usually publishes 5–10 and the long tail is low-signal.
  const TOP_N = 8;
  const packMatchupList = list => (list || []).slice(0, TOP_N)
    .map(m => `${m.opponent || ''}:${Math.round(m.rating || 0)}`)
    .filter(s => !s.startsWith(':'))
    .join(';');

  const header = 'speciesId,speciesName,score,attack,defense,hp,statProduct,fastMove,chargedMove1,chargedMove2,leadScore,switchScore,closerScore,attackerScore,topMatchups,topCounters';
  const rows = overall.map(e => {
    const moveset = e.moveset || [];
    const fast    = (moveset[0] || '').replace(/,/g, '');
    const cm1     = (moveset[1] || '').replace(/,/g, '');
    const cm2     = (moveset[2] || '').replace(/,/g, '');
    const stats   = e.stats || {};
    const id      = e.speciesId || '';
    return [
      id,
      (e.speciesName || '').replace(/,/g, ''),
      e.score ?? '',
      stats.atk ?? '',
      stats.def ?? '',
      stats.hp  ?? '',
      stats.product ?? '',
      fast, cm1, cm2,
      leadScore.get(id)     ?? '',
      switchScore.get(id)   ?? '',
      closerScore.get(id)   ?? '',
      attackerScore.get(id) ?? '',
      packMatchupList(e.matchups),
      packMatchupList(e.counters),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function cupLabel(cupId /* cp param kept for API parity, but always 1500 here */) {
  if (cupId === 'all') return CP_LABELS[TARGET_CP] || 'Great League';
  return CUP_LABELS[cupId] ?? titleCase(cupId);
}

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function downloadAllRankings() {
  console.log('Discovering ranking cups via GitHub API…');
  const cupDirs = await listDir(`src/data/rankings`);
  if (!cupDirs.length) throw new Error('Could not list rankings directories');

  const indexEntries = [];
  let downloaded = 0, skipped = 0;

  for (const cupDir of cupDirs) {
    if (cupDir.type !== 'dir') continue;
    const cupId = cupDir.name;

    // List the overall/ subdirectory to find which CP files exist
    const overallFiles = await listDir(`src/data/rankings/${cupId}/overall`);
    if (!overallFiles.length) {
      console.log(`  [skip] ${cupId}: no overall/ files`);
      skipped++;
      continue;
    }

    const rankingFiles = overallFiles.filter(f => f.name.match(/^rankings-\d+\.json$/));
    if (!rankingFiles.length) {
      console.log(`  [skip] ${cupId}: no rankings-{cp}.json found`);
      skipped++;
      continue;
    }

    for (const file of rankingFiles) {
      const cp = parseInt(file.name.match(/rankings-(\d+)\.json/)[1], 10);

      // 1500-only mode: skip every other CP cap. The app is a Great League
      // analyzer; Little Cup, Ultra, and Master are out of scope.
      if (cp !== TARGET_CP) continue;

      const rawUrl  = `${GITHUB_RAW}/${REPO}/${BRANCH}/src/data/rankings/${cupId}/overall/rankings-${cp}.json`;
      const outName = `cp${cp}_${cupId}_overall_rankings.csv`;
      const outPath = path.join(csvOutputPath, outName);

      console.log(`  Fetching: ${cupId}/{overall,leads,switches,closers,attackers}/rankings-${cp}.json`);
      const overall = await fetchJson(rawUrl);
      if (!Array.isArray(overall) || overall.length === 0) {
        console.warn(`  [warn] Empty/invalid data — skipping ${outName}`);
        skipped++;
        continue;
      }

      const roleData = await fetchRoleRankings(cupId, cp);
      const missingRoles = ROLE_CATEGORIES.filter(r => roleData[r].length === 0);
      if (missingRoles.length) {
        console.warn(`  [warn] ${cupId}/cp${cp}: missing role files [${missingRoles.join(', ')}] — those columns will be blank`);
      }

      const csv = rankingsToCsv({ overall, ...roleData });
      fs.writeFileSync(outPath, csv, 'utf8');
      console.log(`    Saved ${overall.length} entries → ${outName}`);
      downloaded++;

      indexEntries.push({
        file:       outName,
        label:      cupLabel(cupId, cp),
        cp,
        cup:        cupId,
        restricted: RESTRICTED_CUPS.has(cupId),
      });
    }
  }

  // Sort: open Great League first, then restricted 1500 cups alphabetically.
  indexEntries.sort((a, b) => {
    const aOpen = !a.restricted, bOpen = !b.restricted;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return a.cup.localeCompare(b.cup);
  });

  // Write auto-generated index.json
  const indexPath = path.join(csvOutputPath, 'index.json');
  // Strip internal fields (cp, cup) that the app doesn't need
  const indexOut = indexEntries.map(({ file, label, restricted }) =>
    restricted ? { file, label, restricted: true } : { file, label }
  );
  fs.writeFileSync(indexPath, JSON.stringify(indexOut, null, 2), 'utf8');
  console.log(`\nWrote index.json with ${indexOut.length} entries`);
  console.log(`Rankings: ${downloaded} downloaded, ${skipped} skipped`);

  return indexEntries;
}

// ─── Gamemaster downloader ────────────────────────────────────────────────────

const GAMEMASTER_FILES = [
  {
    url:     `${GITHUB_RAW}/${REPO}/${BRANCH}/src/data/gamemaster/moves.json`,
    outFile: 'moves.json',
    validate(data) {
      if (!Array.isArray(data) || data.length < 50)
        throw new Error(`moves.json looks wrong — expected array of 50+ moves`);
    },
  },
  {
    url:     `${GITHUB_RAW}/${REPO}/${BRANCH}/src/data/gamemaster/pokemon.json`,
    outFile: 'pokemon.json',
    validate(data) {
      if (!Array.isArray(data) || data.length < 100)
        throw new Error(`pokemon.json looks wrong — expected array of 100+ pokemon`);
    },
  },
];

async function downloadGamemasterFile({ url, outFile, validate }) {
  console.log(`Fetching: ${url}`);
  const data = await fetchJson(url);
  if (!data) throw new Error(`Could not fetch ${url}`);
  validate(data);
  const outPath = path.join(dataOutputPath, outFile);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Saved ${Array.isArray(data) ? data.length + ' entries' : ''}: ${outFile}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Rankings ===');
  const indexEntries = await downloadAllRankings();

  console.log('\n=== Gamemaster ===');
  for (const gm of GAMEMASTER_FILES) {
    await downloadGamemasterFile(gm);
  }

  console.log('\nAll downloads complete.');
  console.log(`Formats available: ${indexEntries.map(e => e.label).join(', ')}`);
})();
