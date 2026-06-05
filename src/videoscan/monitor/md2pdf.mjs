// Minimal MD -> PDF via Playwright chromium. Usage: node md2pdf.mjs file.md [more.md...]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mdToHtml, CSS } from "./md2pdf-lib.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
for (const file of process.argv.slice(2)) {
  const md = readFileSync(file, "utf8");
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${mdToHtml(md)}</body>`;
  await page.setContent(html, { waitUntil: "load" });
  const out = resolve(file.replace(/\.md$/i, ".pdf"));
  await page.pdf({ path: out, format: "A4", margin: { top: "18mm", bottom: "18mm", left: "15mm", right: "15mm" }, printBackground: true });
  console.log("wrote", out);
}
await browser.close();
