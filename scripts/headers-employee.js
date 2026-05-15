import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
page.on('request', async r=>{ if(/api\/employee\/get\?page=1$/.test(r.url())) console.log(JSON.stringify({url:r.url(),headers:await r.allHeaders()},null,2)); });
page.on('response', async r=>{ if(/api\/employee\/get\?page=1$/.test(r.url())) console.log('resp',r.status(), (await r.text()).slice(0,200)); });
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'domcontentloaded',timeout:60000}); await page.waitForTimeout(7000); await browser.close();
