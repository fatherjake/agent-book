// Example / smoke test for /opt/frugal/task/pw-node:
//   /opt/frugal/task/pw-node /opt/frugal/task/pw-screenshot.js [url] [out.png]
// Opens the app (default http://127.0.0.1:3000/, i.e. `/opt/frugal/task/app start`), saves a
// full-page screenshot (default /tmp/home.png) and prints the page title.
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:3000/';
const out = process.argv[3] || '/tmp/home.png';
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.screenshot({ path: out, fullPage: true });
    console.log(JSON.stringify({ url: page.url(), status: res && res.status(), title: await page.title(), screenshot: out }));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
