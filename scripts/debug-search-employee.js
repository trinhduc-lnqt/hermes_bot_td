import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
const reqs=[]; page.on('request', r=>{ if(/employee|manage|search|department|team/i.test(r.url())) reqs.push({method:r.method(),url:r.url(),post:r.postData()}); });
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'networkidle',timeout:60000}); await page.waitForTimeout(3000);
console.log(await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((el,i)=>({i, ph:el.placeholder, val:el.value, cls:el.className, outer:el.outerHTML.slice(0,300)}))));
for (const sel of ['input[placeholder="Search..."]','input:first-of-type']) {
 const loc=page.locator(sel).first(); console.log(sel, await loc.count(), await loc.isVisible().catch(()=>false));
 await loc.click().catch(e=>console.log('click fail',e.message)); await loc.fill('hang.le01').catch(e=>console.log('fill fail',e.message)); await loc.press('Enter').catch(e=>console.log('press fail',e.message)); await page.waitForTimeout(5000);
 console.log('url', page.url()); console.log('reqs', reqs.slice(-10));
 console.log('text contains', (await page.locator('body').innerText()).includes('hang.le01'));
}
await mkdir('data/debug',{recursive:true}); await page.screenshot({path:'data/debug/manage-search-hang.png', fullPage:true}); await writeFile('data/debug/manage-search-hang.html', await page.content(), 'utf8');
await browser.close();
