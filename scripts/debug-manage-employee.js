import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users = JSON.parse(await readFile("data/hermes-users.json", "utf8"));
const item = Object.values(users.users || {}).find((x) => x.hermesSession);
const storageState = JSON.parse(decryptText(config.botSecretKey, item.hermesSession));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState });
const page = await context.newPage();
const responses = [];
page.on("response", async (response) => {
  const url = response.url();
  if (!/employee|manage|department|branch|room|user/i.test(url)) return;
  responses.push({ url, status: response.status(), contentType: response.headers()["content-type"] || "", body: await response.text().catch(() => "") });
});
await page.goto("https://hermes.ipos.vn/manage-employee", { waitUntil: "networkidle", timeout: 60000 }).catch(async (e) => console.error("goto", e.message));
await page.waitForTimeout(8000);
const snapshot = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body.innerText.slice(0, 20000),
  rows: Array.from(document.querySelectorAll("table tr, .mat-row, [role='row']")).map((row) => Array.from(row.querySelectorAll("th,td,.mat-cell,.mat-header-cell,[role='cell'],[role='columnheader']")).map((cell) => cell.textContent.trim()).filter(Boolean)).filter((x) => x.length).slice(0, 80),
  inputs: Array.from(document.querySelectorAll("input, select, textarea")).map((el) => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, value: el.value, aria: el.getAttribute("aria-label") })),
  buttons: Array.from(document.querySelectorAll("button, [role='button']")).map((el) => el.textContent.trim()).filter(Boolean).slice(0, 80)
}));
await mkdir("data/debug", { recursive: true });
await writeFile("data/debug/manage-employee-snapshot.json", JSON.stringify({ snapshot, responses: responses.map((r) => ({ ...r, body: r.body.slice(0, 5000) })) }, null, 2), "utf8");
console.log(JSON.stringify({ url: snapshot.url, title: snapshot.title, rows: snapshot.rows.length, inputs: snapshot.inputs, buttons: snapshot.buttons.slice(0,20), responses: responses.map(r => ({url:r.url,status:r.status,ct:r.contentType,len:r.body.length})).slice(-20) }, null, 2));
await browser.close();
