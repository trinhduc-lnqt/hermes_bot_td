import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'domcontentloaded',timeout:60000}); await page.waitForTimeout(4000);
const data=await page.evaluate(async ()=>{
 const token = localStorage.getItem('token') || document.cookie.match(/(?:^|; )token=([^;]+)/)?.[1] || '';
 const headers={accept:'application/json, text/plain, */*', authorization: token, server:'LIVE'};
 async function get(url){ const res=await fetch(url,{headers}); const text=await res.text(); let json=null; try{json=JSON.parse(text)}catch{}; return {url,status:res.status,len:text.length,json,text:text.slice(0,300)}; }
 const tests=[];
 for (const url of ['/api/employee/get?page=1&deptCode=HAN_SUPPORT','/api/employee/get?page=1&deptCode=HAN_SUPPORT&numPerPage=200','/api/employee/get?page=1&textSearch=hang.le01','/api/employee/get?page=1&keyword=hang.le01','/api/employee/get?page=1&email=hang.le01@ipos.vn']) tests.push(await get(url));
 return {token: token ? 'yes' : 'no', tests};
});
console.log(JSON.stringify(data,null,2).slice(0,20000));
await browser.close();
