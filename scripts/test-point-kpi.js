import { getHermesKpiSupportRealtime } from "../src/hermesClient.js";
import { getHermesAccount } from "../src/store.js";
import { config } from "../src/config.js";
const account = await getHermesAccount({ secret: config.botSecretKey, chatId: "1182254896" });
const result = await getHermesKpiSupportRealtime({ username: account.hermesUsername, password: account.hermesPassword, storageState: account.hermesSession });
console.log(JSON.stringify({ ok: result.ok, message: result.message, count: result.items?.length, sample: result.items?.slice(0, 20).map(i => ({ support: i.support, supportName: i.supportName, total: i.pointTotal })) }, null, 2));
