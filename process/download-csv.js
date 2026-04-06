const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const LEAGUES = [
  { cpCap: 1500, url: 'https://pvpoke.com/rankings/all/1500/overall/', outFile: 'cp1500_all_overall_rankings.csv' },
  { cpCap: 2500, url: 'https://pvpoke.com/rankings/all/2500/overall/', outFile: 'cp2500_all_overall_rankings.csv' },
];

const downloadPath = path.resolve(__dirname, 'downloads');
fs.mkdirSync(downloadPath, { recursive: true });

/**
 * Download the rankings CSV from a PvPoke rankings page.
 * PvPoke generates a blob URL on the download button after rankings render.
 * We wait up to 10s for the button to appear and the blob to be set.
 */
async function downloadLeague(page, league) {
  console.log(`\nFetching: ${league.url}`);
  await page.goto(league.url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for the download button to appear (rankings must finish rendering)
  try {
    await page.waitForSelector('a.button.download-csv', { timeout: 10000 });
  } catch {
    throw new Error(`Download button not found on ${league.url}`);
  }

  // Click to generate the blob URL if it hasn't been set yet, then wait
  const csvBase64 = await page.evaluate(async () => {
    const a = document.querySelector('a.button.download-csv');
    if (!a) throw new Error('Download link not found');

    if (!a.href.startsWith('blob:')) {
      a.click();
      // Wait up to 5s for blob URL to populate
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (a.href.startsWith('blob:')) break;
      }
    }

    if (!a.href.startsWith('blob:')) throw new Error('Blob URL not generated after waiting');

    const res = await fetch(a.href);
    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();

    let binary = '';
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  });

  // Always save with the canonical filename the webapp expects
  const filePath = path.join(downloadPath, league.outFile);
  fs.writeFileSync(filePath, Buffer.from(csvBase64, 'base64'));
  console.log(`Saved: ${filePath}`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    for (const league of LEAGUES) {
      await downloadLeague(page, league);
    }

    console.log('\nAll downloads complete.');
  } finally {
    await browser.close();
  }
})();
