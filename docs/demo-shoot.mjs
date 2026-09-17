// Renders every frame of demo-frames.html in Chromium. See README > Running it.
//   node docs/demo-shoot.mjs docs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.argv[2] ?? "docs");
mkdirSync(`${dir}/frames`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 400 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(`${dir}/demo-frames.html`).href);

const total = await page.evaluate(() => window.__n);
for (let i = 0; i < total; i++) {
  await page.evaluate((n) => window.render(n), i);
  await page.screenshot({ path: `${dir}/frames/${String(i).padStart(4, "0")}.png` });
}
console.log(`${total} frames -> ${dir}/frames`);
await browser.close();
