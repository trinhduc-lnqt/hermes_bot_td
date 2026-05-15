import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";

const users = JSON.parse(await readFile("data/hermes-users.json", "utf8"));
const user = Object.values(users.users || {}).find((item) => item.hermesSession);
const storageState = JSON.parse(decryptText(config.botSecretKey, user.hermesSession));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState });
const page = await context.newPage();

const apiEmployees = [];
page.on("response", async (response) => {
  if (!/\/api\/employee\/get/i.test(response.url())) return;
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    const list = json?.data?.employees || [];
    for (const item of list) apiEmployees.push(item);
  } catch {}
});

function alias(value = "") { return String(value).trim().toLowerCase().replace(/@ipos\.vn$/i, ""); }
function emailFrom(text = "") { return String(text).match(/[a-z0-9._%+-]+@ipos\.vn/i)?.[0] || ""; }
function cleanName(value = "") { return String(value || "").replace(/^\d{8,15}/, "").trim(); }
function validName(value = "") { return /[\p{L}]/u.test(value) && !/@ipos\.vn|support|active|inactive|đang làm|không/i.test(value); }
async function rows() {
  return await page.evaluate(() => Array.from(document.querySelectorAll("table tr, .mat-row, [role='row']"))
    .map((row) => Array.from(row.querySelectorAll("th,td,.mat-cell,.mat-header-cell,[role='cell'],[role='columnheader']"))
      .map((cell) => cell.textContent.trim()).filter(Boolean))
    .filter((cells) => cells.length));
}

await page.goto("https://hermes.ipos.vn/report-kpi-support", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(5000);
const kpiRows = await rows();
const aliases = [...new Set(kpiRows.flat().map(emailFrom).filter(Boolean).map(alias))];
if (!aliases.length) {
  const text = await page.locator("body").innerText().catch(() => "");
  for (const match of text.matchAll(/[a-z0-9._%+-]+@ipos\.vn/ig)) aliases.push(alias(match[0]));
}
console.log("aliases", aliases);

await page.goto("https://hermes.ipos.vn/manage-employee", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);
const results = [];
for (const itemAlias of aliases) {
  apiEmployees.length = 0;
  const input = page.locator('input[placeholder="Search..."]').first();
  await input.fill(itemAlias);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const currentRows = await rows();
  let found = apiEmployees.find((e) => alias(e.email) === itemAlias || alias(e.username) === itemAlias);
  let name = found?.name || found?.fullName || "";
  let email = found?.email || `${itemAlias}@ipos.vn`;
  let department = found?.deptCode || found?.department || "";
  if (!name) {
    for (const cells of currentRows) {
      const text = cells.join(" | ");
      if (!new RegExp(itemAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) continue;
      email = emailFrom(text) || email;
      const nameCell = cells.map(cleanName).find(validName);
      if (nameCell) name = nameCell;
      department = cells.find((cell) => /HAN|SUPPORT|TECHNICAL|HCM/i.test(cell)) || department;
      break;
    }
  }
  results.push({ alias: itemAlias, email: String(email).toLowerCase(), name: cleanName(name), department, source: "manage-employee-search" });
  console.log(itemAlias, "=>", cleanName(name), email, department);
}
const employees = results.filter((item) => item.name);
await mkdir("data", { recursive: true });
await writeFile("data/han-support-employees.json", JSON.stringify({ sourceUrl: "https://hermes.ipos.vn/manage-employee", sourceMode: "search KPI aliases", updatedAt: new Date().toISOString(), count: employees.length, employees }, null, 2), "utf8");
console.log("WROTE", employees.length);
await browser.close();
