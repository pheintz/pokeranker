/**
 * Downloads PvPoke data from the public GitHub repository.
 *
 * Rankings (auto-discovered via GitHub API):
 *   Source: https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/rankings/{cup}/overall/rankings-{cp}.json
 *   Output: wwwroot/csv/cp{cp}_{cup}_overall_rankings.csv
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

// ─── Human-readable labels for known cups ────────────────────────────────────
// New cups discovered via API will fall back to a title-cased version of the ID.
const CUP_LABELS = {
  all:                   null,          // handled specially: 1500=Great League, 2500=Ultra League, 10000=Master League
  little:                'Little Cup',
  remix:                 'GL Remix',
  classic:               'Classic GL',
  premier:               'Premier Cup',
  premierultra:          'Premier Ultra',
  premiermaster:         'Premier Master',
  fantasy:               'Fantasy Cup',
  spring:                'Spring Cup',
  jungle:                'Jungle Cup',
  electric:              'Electric Cup',
  retro:                 'Retro Cup',
  maelstrom:             'Maelstrom Cup',
  spellcraft:            'Spellcraft Cup',
  equinox:               'Equinox Cup',
  chrono:                'Chrono Cup',
  bayou:                 'Bayou Cup',
  catch:                 'Catch Cup',
  battlefrontiermaster:  'Battle Frontier Master',
  bfretro:               'Battle Frontier Retro',
  laic2025remix:         'LAIC 2025 Remix',
  littlegeneral:         'Little General Cup',
};

const CP_LABELS = {
  500:   'Little (500)',
  1500:  'Great League',
  2500:  'Ultra League',
  10000: 'Master League',
};

// Cups that restrict the eligible species pool (not just CP-capped open formats)
const RESTRICTED_CUPS = new Set([
  'fantasy', 'spring', 'jungle', 'electric', 'retro', 'maelstrom',
  'spellcraft', 'equinox', 'chrono', 'bayou', 'catch', 'little',
  'classic', 'remix', 'premier', 'premierultra', 'premiermaster',
  'battlefrontiermaster', 'bfretro', 'laic2025remix', 'littlegeneral',
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

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'pokeranker-ci/1.0 (github.com)',
      'Accept':     'application/json',
      ...extraHeaders,
    };
    https.get(url, { headers }, res => {
      if (res.statusCode === 404) return resolve(null);   // missing file → skip
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end',  () => resolve(data));
    }).on('error', reject);
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

function rankingsToCsv(entries) {
  const header = 'speciesId,speciesName,score,attack,defense,hp,statProduct,fastMove,chargedMove1,chargedMove2';
  const rows = entries.map(e => {
    const moveset = e.moveset || [];
    const fast    = (moveset[0] || '').replace(/,/g, '');
    const cm1     = (moveset[1] || '').replace(/,/g, '');
    const cm2     = (moveset[2] || '').replace(/,/g, '');
    const stats   = e.stats || {};
    return [
      e.speciesId || '',
      (e.speciesName || '').replace(/,/g, ''),
      e.score ?? '',
      stats.atk ?? '',
      stats.def ?? '',
      stats.hp  ?? '',
      stats.product ?? '',
      fast, cm1, cm2,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function cupLabel(cupId, cp) {
  if (cupId === 'all') {
    return CP_LABELS[cp] || `CP ${cp}`;
  }
  return (CUP_LABELS[cupId] ?? titleCase(cupId)) + (cp !== 1500 ? ` (${cp})` : '');
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

      // Skip Master League (10000) for non-all cups — too large & rarely used
      if (cp === 10000 && cupId !== 'all') continue;

      const rawUrl  = `${GITHUB_RAW}/${REPO}/${BRANCH}/src/data/rankings/${cupId}/overall/rankings-${cp}.json`;
      const outName = `cp${cp}_${cupId}_overall_rankings.csv`;
      const outPath = path.join(csvOutputPath, outName);

      console.log(`  Fetching: ${cupId}/overall/rankings-${cp}.json`);
      const entries = await fetchJson(rawUrl);
      if (!Array.isArray(entries) || entries.length === 0) {
        console.warn(`  [warn] Empty/invalid data — skipping ${outName}`);
        skipped++;
        continue;
      }

      const csv = rankingsToCsv(entries);
      fs.writeFileSync(outPath, csv, 'utf8');
      console.log(`    Saved ${entries.length} entries → ${outName}`);
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

  // Sort: open formats first (all GL, all UL), then restricted cups alphabetically
  indexEntries.sort((a, b) => {
    const aOpen = !a.restricted, bOpen = !b.restricted;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (a.cp !== b.cp) return a.cp - b.cp;
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
