import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users=JSON.parse(await readFile('data/hermes-users.json','utf8')); const u=Object.values(users.users).find(x=>x.hermesSession); const storageState=JSON.parse(decryptText(config.botSecretKey,u.hermesSession));
const browser=await chromium.launch({headless:true}); const context=await browser.newContext({storageState}); const page=await context.newPage();
await page.goto('https://hermes.ipos.vn/manage-employee',{waitUntil:'domcontentloaded',timeout:60000}); await page.waitForTimeout(3000);
const employees=await page.evaluate(async ()=>{
 const token = localStorage.getItem('token') || document.cookie.match(/(?:^|; )token=([^;]+)/)?.[1] || '';
 const headers={accept:'application/json, text/plain, */*', authorization: token, server:'LIVE'};
 const all=[]; let pageNo=1; let totalPage=1;
 do {
   const res=await fetch(`/api/employee/get?page=${pageNo}&deptCode=HAN_SUPPORT`,{headers});
   const json=await res.json();
   const data=json.data || {}; totalPage=data.totalPage || 1;
   all.push(...(data.employees || [])); pageNo += 1;
 } while (pageNo <= totalPage);
 return all;
});
function alias(email=''){return String(email).toLowerCase().replace(/@ipos\.vn$/i,'');}
const mapped=employees.filter(e=>e.email&&e.name&&/@ipos\.vn$/i.test(e.email)&&!/^(support|otp|asm|test)/i.test(alias(e.email))).map(e=>({email:e.email.toLowerCase(),alias:alias(e.email),name:e.name,code:e.code||'',department:e.deptCode||'',teamId:e.teamId||'',level:e.level||'',role:e.role||'',status:e.status||'',updatedTime:e.updatedTime||''})).sort((a,b)=>a.alias.localeCompare(b.alias));
await mkdir('data',{recursive:true});
await writeFile('data/han-support-employees.json', JSON.stringify({sourceUrl:'https://hermes.ipos.vn/manage-employee', apiUrl:'/api/employee/get?page={n}&deptCode=HAN_SUPPORT', updatedAt:new Date().toISOString(), count:mapped.length, employees:mapped}, null, 2), 'utf8');
console.log(JSON.stringify({raw:employees.length,count:mapped.length,sample:mapped.slice(0,30)},null,2));
await browser.close();
