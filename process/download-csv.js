/**
 * Downloads PvPoke rankings JSON directly (no browser needed) and converts
 * to CSV format expected by the webapp: rows ordered by rank, first column = speciesId.
 *
 * Source: https://pvpoke.com/data/rankings/all/overall/rankings-{cp}.json
 * Output: wwwroot/csv/cp{cp}_all_overall_rankings.csv
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const LEAGUES = [
  { cp: 1500, outFile: 'cp1500_all_overall_rankings.csv' },
  { cp: 2500, outFile: 'cp2500_all_overall_rankings.csv' },
];

const downloadPath = path.resolve(__dirname, 'downloads');
fs.mkdirSync(downloadPath, { recursive: true });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function rankingsToCsv(entries) {
  // Header matches existing CSV format; speciesId must be first column
  const header = 'speciesId,speciesName,score,attack,defense,hp,statProduct,fastMove,chargedMove1,chargedMove2';

  const rows = entries.map(e => {
    const moveset = e.moveset || [];
    const fast  = (moveset[0] || '').replace(/,/g, '');
    const cm1   = (moveset[1] || '').replace(/,/g, '');
    const cm2   = (moveset[2] || '').replace(/,/g, '');
    const stats = e.stats || {};
    return [
      e.speciesId || '',
      (e.speciesName || '').replace(/,/g, ''),
      e.score ?? '',
      stats.atk ?? '',
      stats.def ?? '',
      stats.hp  ?? '',
      stats.product ?? '',
      fast,
      cm1,
      cm2,
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

async function downloadLeague(league) {
  const url = `https://pvpoke.com/data/rankings/all/overall/rankings-${league.cp}.json`;
  console.log(`Fetching: ${url}`);

  const entries = await fetchJson(url);

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Empty or invalid rankings data for CP ${league.cp}`);
  }

  console.log(`  Received ${entries.length} entries`);

  const csv = rankingsToCsv(entries);
  const outPath = path.join(downloadPath, league.outFile);
  fs.writeFileSync(outPath, csv, 'utf8');
  console.log(`  Saved: ${outPath}`);
}

(async () => {
  for (const league of LEAGUES) {
    await downloadLeague(league);
  }
  console.log('\nAll downloads complete.');
})();
