import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'networkidle',timeout:60000});
const urls=['/api/team/get-all','/api/department/get-all','/api/employee/get?page=1','/api/employee/get?page=1&search=hang.le01','/api/employee/get?page=1&textSearch=hang.le01','/api/employee/get?page=1&keyword=hang.le01','/api/employee/get?page=1&email=hang.le01@ipos.vn','/api/employee/get?page=1&deptCode=TECHNICAL_HN','/api/employee/get?page=1&deptCode=HAN_SUPPORT'];
const out=await page.evaluate(async (urls)=>{
 const arr=[]; for (const url of urls){ const res=await fetch(url,{headers:{accept:'application/json, text/plain, */*'}}); const text=await res.text(); let json=null; try{json=JSON.parse(text)}catch{}; const list=json?.data?.employees||json?.data||[]; arr.push({url,status:res.status,len:text.length,sample:Array.isArray(list)?list.slice(0,5):list, names:Array.isArray(list)?list.filter(e=>JSON.stringify(e).toLowerCase().includes('hang.le01')).slice(0,5):[]}); } return arr;
}, urls);
console.log(JSON.stringify(out,null,2).slice(0,20000));
await browser.close();
