import { chromium } from 'playwright';
import { config } from './src/config.js';
import { getAllHermesAccounts } from './src/store.js';

const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
const account = accounts.find((item) => item.hermesSession && item.hermesUsername);
if (!account) throw new Error('Không tìm thấy Hermes session đã lưu.');
const browser = await chromium.launch({ headless: config.headless, channel: 'chrome' }).catch(() => chromium.launch({ headless: config.headless }));
const context = await browser.newContext({ storageState: account.hermesSession, ignoreHTTPSErrors: true, locale: config.locale, timezoneId: config.timezoneId });
const page = await context.newPage();
const events = [];
function push(type, data) {
  events.push({ t: new Date().toISOString(), type, ...data });
  console.log(JSON.stringify(events[events.length - 1]));
}
page.on('websocket', (ws) => {
  push('websocket', { url: ws.url() });
  ws.on('framereceived', (payload) => push('ws:recv', { url: ws.url(), payload: String(payload).slice(0, 300) }));
  ws.on('framesent', (payload) => push('ws:sent', { url: ws.url(), payload: String(payload).slice(0, 300) }));
  ws.on('close', () => push('ws:close', { url: ws.url() }));
});
page.on('request', (req) => {
  const url = req.url();
  if (/notification|notify|signalr|socket|sockjs|eventsource|sse|hub|request-order/i.test(url) || ['websocket','eventsource','fetch','xhr'].includes(req.resourceType())) {
    push('request', { method: req.method(), resourceType: req.resourceType(), url });
  }
});
page.on('response', async (res) => {
  const req = res.request();
  const url = res.url();
  const contentType = res.headers()['content-type'] || '';
  if (/notification|notify|signalr|socket|sockjs|eventsource|sse|hub|request-order/i.test(url) || ['eventsource','fetch','xhr'].includes(req.resourceType())) {
    let body = '';
    if (/json|text|event-stream/i.test(contentType)) body = (await res.text().catch(() => '')).slice(0, 500);
    push('response', { status: res.status(), resourceType: req.resourceType(), contentType, url, body });
  }
});
await page.goto(new URL('/notification', config.hermesBaseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
await page.waitForTimeout(20000);
console.log('SUMMARY=' + JSON.stringify({
  websockets: events.filter(e => e.type === 'websocket').map(e => e.url),
  eventsourceRequests: events.filter(e => e.resourceType === 'eventsource').map(e => e.url),
  likelyRealtime: events.filter(e => /signalr|socket|sockjs|eventsource|sse|hub/i.test(e.url || '')).map(e => ({ type: e.type, url: e.url, resourceType: e.resourceType, status: e.status }))
}, null, 2));
await browser.close();
