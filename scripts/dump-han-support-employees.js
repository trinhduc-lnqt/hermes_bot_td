import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";

const outFile = path.resolve("data/han-support-employees.json");
const usersFile = path.resolve("data/hermes-users.json");

function normalizeText(value = "") {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_\s-]+/g, " ").trim();
}

function aliasFromEmail(value = "") {
  return String(value || "").trim().toLowerCase().replace(/@ipos\.vn$/i, "");
}

function findEmail(text = "") {
  return String(text || "").match(/[a-z0-9._%+-]+@ipos\.vn/i)?.[0] || "";
}

function validName(value = "") {
  const text = String(value || "").trim();
  if (!text || /@ipos\.vn/i.test(text)) return false;
  if (/^'?0\d{8,11}$/.test(text.replace(/[\s.-]/g, ""))) return false;
  if (/^[\d\s+().-]+$/.test(text)) return false;
  if (/han\s+support|hcmc\s+support|support\s+online|active|inactive/i.test(text)) return false;
  return /[\p{L}]/u.test(text);
}

function pickDeep(value, keyPatterns) {
  if (!value || typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === "object") continue;
    const normalizedKey = normalizeText(key);
    if (!keyPatterns.some((pattern) => normalizedKey.includes(pattern))) continue;
    const text = String(item ?? "").trim();
    if (text) return text;
  }
  for (const item of Object.values(value)) {
    if (!item || typeof item !== "object") continue;
    const found = pickDeep(item, keyPatterns);
    if (found) return found;
  }
  return "";
}

function flatten(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, output);
    return output;
  }
  if (typeof value !== "object") return output;
  const keys = Object.keys(value);
  if (keys.some((key) => /email|mail|employee|user|dept|department|branch|room|full.?name|name/i.test(key))) output.push(value);
  for (const key of keys) if (/data|items|rows|list|result|records/i.test(key)) flatten(value[key], output);
  return output;
}

function normalizeRecord(item, source) {
  const rawText = JSON.stringify(item || {});
  const email = pickDeep(item, ["email", "mail", "username", "account", "login"]) || findEmail(rawText);
  const name = pickDeep(item, ["full name", "fullname", "display name", "employee name", "staff name", "ho ten", "ten nhan vien", "name"]);
  const department = pickDeep(item, ["dept", "department", "room", "branch", "phong"]);
  const haystack = normalizeText(`${department} ${rawText}`);
  if (!email || !aliasFromEmail(email) || !validName(name)) return null;
  if (!haystack.includes("han support")) return null;
  return { email: email.toLowerCase(), alias: aliasFromEmail(email), name, department, source };
}

async function main() {
  const users = JSON.parse(await readFile(usersFile, "utf8"));
  const record = Object.values(users.users || {}).find((item) => item.hermesSession);
  if (!record) throw new Error("No stored Hermes session found");
  const storageState = JSON.parse(decryptText(config.botSecretKey, record.hermesSession));
  const responses = [];
  const browser = await chromium.launch({ headless: false, channel: "chrome" }).catch(() => chromium.launch({ headless: false }));
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  page.on("response", async (response) => {
    const url = response.url();
    if (!/manage-employee|employee/i.test(url)) return;
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("json")) return;
    responses.push({ url, body: await response.text().catch(() => "") });
  });
  await page.goto("https://hermes.ipos.vn/manage-employee", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000);
  await page.getByText(/lọc|filter/i).first().click().catch(() => {});
  await page.waitForTimeout(500);
  const hanInput = page.locator("input").filter({ hasNotText: /^$/ }).last();
  await page.getByText(/HAN\s*Support|HAN_SUPPORT/i).click().catch(async () => {
    const inputs = await page.locator("input").all();
    for (const input of inputs) {
      await input.fill("HAN Support").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }
  });
  await page.waitForTimeout(3000);

  const domRows = await page.evaluate(() => Array.from(document.querySelectorAll("table tr, .mat-row, [role='row']"))
    .map((row) => Array.from(row.querySelectorAll("th,td,.mat-cell,.mat-header-cell,[role='cell'],[role='columnheader']"))
      .map((cell) => cell.textContent.trim()).filter(Boolean))
    .filter((cells) => cells.length));

  const records = [];
  for (const response of responses) {
    try {
      for (const item of flatten(JSON.parse(response.body))) {
        const record = normalizeRecord(item, "api");
        if (record) records.push(record);
      }
    } catch {}
  }

  const header = domRows.find((cells) => cells.some((cell) => /email|mail|nhân viên|nhan vien|họ tên|ho ten|phòng|phong|department/i.test(cell))) || [];
  const findIndex = (...patterns) => header.findIndex((cell) => patterns.some((pattern) => normalizeText(cell).includes(pattern)));
  const emailIndex = findIndex("email", "mail", "account", "user");
  const nameIndex = findIndex("ho ten", "nhan vien", "employee", "full name", "display name", "name", "ten");
  const departmentIndex = findIndex("phong", "department", "dept", "room", "branch");
  for (const cells of domRows.filter((cells) => cells !== header)) {
    const text = cells.join(" | ");
    const email = (emailIndex >= 0 ? cells[emailIndex] : "") || findEmail(text);
    const name = (nameIndex >= 0 ? cells[nameIndex] : "") || cells.find(validName) || "";
    const department = (departmentIndex >= 0 ? cells[departmentIndex] : "") || "";
    if (email && aliasFromEmail(email) && validName(name) && normalizeText(`${department} ${text}`).includes("han support")) {
      records.push({ email: email.toLowerCase(), alias: aliasFromEmail(email), name, department, source: "dom" });
    }
  }

  const byAlias = new Map();
  for (const item of records) byAlias.set(item.alias, item);
  const employees = [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify({ sourceUrl: "https://hermes.ipos.vn/manage-employee", room: "HAN Support", updatedAt: new Date().toISOString(), count: employees.length, employees }, null, 2), "utf8");
  console.log(JSON.stringify({ count: employees.length, sample: employees.slice(0, 10) }, null, 2));
  await page.waitForTimeout(3000);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
