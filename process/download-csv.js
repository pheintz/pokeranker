const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const downloadPath = path.resolve(__dirname, 'downloads');
  fs.mkdirSync(downloadPath, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  await page.goto('https://pvpoke.com/rankings/all/1500/overall/', {
    waitUntil: 'networkidle2',
  });

  // Intercept the click so the link doesn't navigate — just capture the blob
  const csvBase64 = await page.evaluate(async () => {
    const a = document.querySelector('a.button.download-csv');
    if (!a) throw new Error('Download link not found');

    // If the blob URL isn't set yet, trigger the click to generate it,
    // then wait a tick for the href to populate
    if (!a.href.startsWith('blob:')) {
      a.click();
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!a.href.startsWith('blob:')) throw new Error('Blob URL not generated');

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

  // Get the filename from the link attribute
  const filename = await page.$eval(
    'a.button.download-csv',
    a => a.getAttribute('download') || 'export.csv'
  );

  const filePath = path.join(downloadPath, filename);
  fs.writeFileSync(filePath, Buffer.from(csvBase64, 'base64'));
  console.log('Downloaded:', filePath);

  await browser.close();
})();