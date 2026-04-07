import puppeteer from 'puppeteer';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, 'temporary screenshots');

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';

// Auto-increment screenshot number
const existing = readdirSync(DIR).filter(f => f.startsWith('screenshot-'));
const nums = existing.map(f => parseInt(f.match(/screenshot-(\d+)/)?.[1] || '0', 10));
const next = nums.length ? Math.max(...nums) + 1 : 1;
const filename = label ? `screenshot-${next}-${label}.png` : `screenshot-${next}.png`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });
const clipArg = process.argv[4];
if (clipArg === 'top') {
  await page.screenshot({ path: join(DIR, filename), clip: { x: 0, y: 0, width: 1440, height: 900 } });
} else if (clipArg && clipArg.includes(',')) {
  const [y, h] = clipArg.split(',').map(Number);
  await page.screenshot({ path: join(DIR, filename), clip: { x: 0, y, width: 1440, height: h } });
} else {
  await page.screenshot({ path: join(DIR, filename), fullPage: true });
}
await browser.close();

console.log(`Saved: ${join(DIR, filename)}`);
