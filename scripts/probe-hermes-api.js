import { readFile } from "node:fs/promises";
import { request } from "playwright";
import { config } from "../src/config.js";
import { decryptText } from "../src/crypto.js";
const users = JSON.parse(await readFile("data/hermes-users.json", "utf8"));
const user = Object.values(users.users || {}).find((item) => item.hermesSession);
const storageState = JSON.parse(decryptText(config.botSecretKey, user.hermesSession));
const api = await request.newContext({ baseURL: "https://hermes.ipos.vn", storageState, extraHTTPHeaders: { accept: "application/json, text/plain, */*", referer: "https://hermes.ipos.vn/manage-employee", "user-agent": "Mozilla/5.0" } });
for (const url of ["/api/department/get-all", "/api/team/get-all", "/api/team/get", "/api/employee/get?page=1"]) {
 const res = await api.get(url); const txt = await res.text(); console.log('\nURL',url,'status',res.status(),'len',txt.length,'start',txt.slice(0,200));
 try { const json=JSON.parse(txt); const arr=json.data?.teams||json.data||json.data?.employees||[]; if(Array.isArray(arr)) console.log(arr.filter(x => /han|support|technical/i.test(JSON.stringify(x))).slice(0,30)); } catch(e){}
}
await api.dispose();
