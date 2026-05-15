import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'domcontentloaded',timeout:45000});
await mkdir('data/debug/assets',{recursive:true});
for (const name of ['main-es2015.js','main-es5.js']) {
 const txt=await (await page.request.get('https://hermes.ipos.vn/'+name)).text();
 await writeFile('data/debug/assets/'+name, txt, 'utf8');
 console.log(name, txt.length);
}
await browser.close();
