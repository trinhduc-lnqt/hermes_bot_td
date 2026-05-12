import { chromium } from "playwright";

import { config } from "./config.js";

// KPI ???c trực tiếp từ Google Sheet (không cần local API server)
const KPI_SHEET_ID = process.env.KPI_SHEET_ID || "14mLSjz6oU6QLVWi5PeNabRFSKmhAtLB6HZnT0M7T9uo";

const USERNAME_SELECTORS = [
  "#txtuserid",
  "#txtUserId",
  "#username",
  "#userName",
  "#UserName",
  "input[name='UserId']",
  "input[name='username']",
  "input[name='userName']",
  // Hermes currently labels the field as email in the UI, but the real Angular control is username.
  // Keep this before email/text fallbacks so the bot does not wait for a non-existent email control.
  "input[formcontrolname='username']",
  "input[type='email']",
  "input[formcontrolname='email']",
  "input[placeholder*='Email' i]",
  "input[placeholder*='đăng nhập' i]",
  "input[placeholder*='dang nhap' i]",
  "input[type='text']"
];

const PASSWORD_SELECTORS = [
  "#txtpassword",
  "#txtPassword",
  "#password",
  "#Password",
  "input[name='Password']",
  "input[name='password']",
  "input[formcontrolname='password']",
  "input[placeholder*='Mật khẩu' i]",
  "input[placeholder*='Mat khau' i]",
  "input[type='password']"
];

const OTP_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[name*='otp' i]",
  "input[id*='otp' i]",
  "input[formcontrolname*='otp' i]",
  "input[placeholder*='OTP' i]",
  "input[placeholder*='mã' i]",
  "input[placeholder*='ma' i]",
  "input[inputmode='numeric']",
  "input[type='tel']",
  "input[type='number']"
];

const SUBMIT_SELECTORS = [
  "#btnlogin",
  "#btnLogin",
  "button[type='submit']",
  "input[type='submit']",
  "button:has-text('Đăng nhập')",
  "button:has-text('Dang nhap')",
  "button:has-text('Login')",
  "a:has-text('Đăng nhập')",
  "a:has-text('Login')"
];

const OTP_SUBMIT_SELECTORS = [
  "button[type='submit']",
  "input[type='submit']",
  "button:has-text('Xác nhận')",
  "button:has-text('Xac nhan')",
  "button:has-text('Tiếp tục')",
  "button:has-text('Tiep tuc')",
  "button:has-text('Gửi')",
  "button:has-text('Gui')",
  "button:has-text('Đăng nhập')",
  "button:has-text('Login')"
];

const ERROR_SELECTORS = [
  "#lblMessage",
  ".validation-summary-errors",
  ".field-validation-error",
  ".alert-danger",
  ".toast-error",
  ".k-notification-error",
  "text=/sai|không đúng|khong dung|thất bại|that bai|invalid|incorrect/i"
];

let activeHermesSession = null;

async function fillFirstVisible(page, selectors, value, label) {
  await page.waitForSelector("input", { state: "visible", timeout: config.timeoutMs });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      await locator.click({ timeout: 5000 });
      await locator.fill("", { timeout: 5000 });
      await locator.pressSequentially(value, { delay: 20, timeout: 10000 });
      return selector;
    }
    await page.waitForTimeout(250);
  }

  const visibleInputs = await page.locator("input").evaluateAll((inputs) => inputs
    .filter((input) => !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length))
    .map((input) => ({
      type: input.getAttribute("type"),
      id: input.id || "",
      name: input.getAttribute("name") || "",
      formcontrolname: input.getAttribute("formcontrolname") || "",
      placeholder: input.getAttribute("placeholder") || "",
      className: String(input.className || "")
    }))
  ).catch(() => []);

  throw new Error(`Khong tim thay o nhap ${label} tren trang Hermes. Visible inputs: ${JSON.stringify(visibleInputs)}`);
}

async function clickFirstVisible(page, selectors) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      await locator.click({ timeout: 5000 });
      return selector;
    }
    await page.waitForTimeout(250);
  }
  await page.keyboard.press("Enter");
  return "Enter";
}

async function getVisibleOtpInputs(page) {
  const inputs = [];
  const seen = new Set();
  for (const selector of OTP_SELECTORS) {
    const locators = await page.locator(selector).all().catch(() => []);
    for (const locator of locators) {
      const handle = await locator.elementHandle().catch(() => null);
      if (!handle) {
        continue;
      }
      const key = await handle.evaluate((el) => {
        if (!el.dataset.miuOtpKey) {
          el.dataset.miuOtpKey = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        }
        return el.dataset.miuOtpKey;
      }).catch(() => null);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (visible && enabled) {
        inputs.push(locator);
      }
    }
  }
  return inputs;
}

function normalizeHermesOtp(otp) {
  const text = String(otp || "").trim();
  const labeledMatch = text.match(/(?:mã\s*otp|ma\s*otp|otp)\D*(\d{4,8})/i);
  if (labeledMatch) {
    return labeledMatch[1];
  }
  const digitGroups = text.match(/\d{4,8}/g) || [];
  return digitGroups[0] || text.replace(/\s+/g, "");
}

async function fillOtp(page, otp) {
  const normalizedOtp = normalizeHermesOtp(otp);
  const otpInputs = await getVisibleOtpInputs(page);
  if (otpInputs.length === 0) {
    throw new Error("Khong tim thay o nhap OTP tren trang Hermes.");
  }

  if (otpInputs.length > 1 && normalizedOtp.length >= otpInputs.length) {
    for (let index = 0; index < otpInputs.length; index += 1) {
      await otpInputs[index].click();
      await otpInputs[index].fill("");
      await otpInputs[index].pressSequentially(normalizedOtp[index] || "", { delay: 50 });
    }
  } else {
    const input = otpInputs[0];
    await input.click();
    await input.fill("");
    await input.pressSequentially(normalizedOtp, { delay: 50 });
  }

  await page.waitForTimeout(500);
  return otpInputs.length;
}

async function clickOtpSubmit(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const selector of OTP_SUBMIT_SELECTORS) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      const enabled = await locator.isEnabled().catch(() => false);
      if (visible && enabled) {
        await locator.click();
        return selector;
      }
    }
    await page.waitForTimeout(300);
  }
  await page.keyboard.press("Enter");
  return "Enter";
}

async function readFirstText(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const text = await locator.textContent().catch(() => "");
    if (text?.trim()) {
      return text.trim();
    }
  }
  return "";
}

function createApiCapture(page) {
  const apiResponses = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/")) {
      return;
    }
    if (response.request().resourceType() === "fetch" && !/\/api\/request-order\/get|\/api\/user\/(pre-login|get-otp|verify|login)/i.test(url)) {
      return;
    }
    const request = response.request();
    let body = "";
    const contentType = response.headers()["content-type"] || "";
    if ((response.request().resourceType() !== "fetch" && contentType.includes("json")) || /\/api\/user\/(pre-login|get-otp|verify|login)/i.test(url) || /\/api\/support-online\/working-schedule\/list/i.test(url) || /\/api\/request-order\/get/i.test(url) || /\/api\/notify\/get/i.test(url)) {
      body = await response.text().catch(() => "");
    }
    apiResponses.push({
      url,
      method: request.method(),
      status: response.status(),
      requestBody: request.postData() || "",
      body
    });
  });
  return apiResponses;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getApiErrorText(apiResponses, urlPattern) {
  for (const response of [...apiResponses].reverse()) {
    if (!urlPattern.test(response.url)) {
      continue;
    }
    const data = parseJsonSafe(response.body);
    const statusText = String(data?.status || data?.Status || "").toUpperCase();
    const hasExplicitError = Boolean(data?.error || data?.EXCEPTION_MESSAGE || statusText === "FAIL" || statusText === "FAILED" || response.status >= 400);
    if (!hasExplicitError || statusText === "SUCCESS") {
      continue;
    }
    const message = data?.message || data?.error?.message || data?.EXCEPTION_MESSAGE;
    if (message) {
      return String(message).trim();
    }
  }
  return "";
}

async function hasVisibleOtpInput(page) {
  for (const selector of OTP_SELECTORS) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      return true;
    }
  }
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return /\bOTP\b|mã xác thực|ma xac thuc|xác minh|xac minh|verification code/i.test(bodyText);
}

async function waitForHermesOtpInput(page, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasVisibleOtpInput(page)) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

function keepHermesOtpSession({ browser, context, page, username, apiResponses, purpose }) {
  const timer = setTimeout(() => {
    closeActiveHermesSession().catch(() => {});
  }, Math.max(config.hermesOtpTimeoutMs, 60_000));
  activeHermesSession = { browser, context, page, username, timer, apiResponses, purpose };
}
async function isLoggedIn(page) {
  const passwordStillVisible = await page.locator("input[type='password']").first().isVisible().catch(() => false);
  const currentUrl = page.url();
  const stayedOnLogin = currentUrl.includes(config.hermesLoginUrl) || /login|dang-?nhap/i.test(currentUrl);
  return !passwordStillVisible && !stayedOnLogin;
}

async function closeActiveHermesSession() {
  if (!activeHermesSession) {
    return;
  }
  const session = activeHermesSession;
  activeHermesSession = null;
  clearTimeout(session.timer);
  await session.browser.close().catch(() => {});
}

export async function validateHermesLogin({ username, password, keepOtpSession = false }) {
  await closeActiveHermesSession();
  if (!config.hermesLoginUrl) {
    return {
      ok: true,
      skipped: true,
      message: "Chua cau hinh HERMES_LOGIN_URL, da luu tai khoan Hermes nhung chua test dang nhap."
    };
  }

  const browser = await chromium.launch({ headless: config.headless, channel: "chrome" }).catch(async () => await chromium.launch({ headless: config.headless }));
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  const apiResponses = createApiCapture(page);

  try {
    await page.goto(config.hermesLoginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
    await page.waitForSelector("input", { state: "visible", timeout: config.timeoutMs });
    await page.waitForTimeout(500);
    await fillFirstVisible(page, USERNAME_SELECTORS, username, "tai khoan");
    await fillFirstVisible(page, PASSWORD_SELECTORS, password, "mat khau");
    await clickFirstVisible(page, SUBMIT_SELECTORS);
    // Hermes keeps polling/analytics requests alive, so networkidle can hang for the full action timeout.
    // The useful login result (error or OTP screen) normally renders within a few seconds.
    await page.waitForTimeout(3000);

    const errorText = await readFirstText(page, ERROR_SELECTORS) || getApiErrorText(apiResponses, /\/api\/user\/pre-login/i);
    if (errorText) {
      return { ok: false, message: `Dang nhap Hermes that bai: ${errorText}` };
    }

    if (await waitForHermesOtpInput(page)) {
      if (!keepOtpSession) {
        return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP." };
      }
      keepHermesOtpSession({ browser, context, page, username, apiResponses, purpose: "validate_login" });
      return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP. Hay gui ma OTP de em xac nhan tiep." };
    }

    if (!(await isLoggedIn(page))) {
      if (await waitForHermesOtpInput(page, 5000)) {
        if (!keepOtpSession) {
          return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP." };
        }
        keepHermesOtpSession({ browser, context, page, username, apiResponses, purpose: "validate_login" });
        return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP. Hay gui ma OTP de em xac nhan tiep." };
      }
      return { ok: false, message: "Hermes van dung o man hinh dang nhap, kha nang sai tai khoan/mat khau." };
    }

    return { ok: true, message: "Dang nhap Hermes OK." };
  } catch (error) {
    return { ok: false, message: error.message || "Khong test duoc dang nhap Hermes." };
  } finally {
    if (!activeHermesSession || activeHermesSession.browser !== browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function submitHermesOtp(otp) {
  if (!activeHermesSession) {
    return { ok: false, expired: true, message: "Khong co phien Hermes nao dang cho OTP hoac phien da het han." };
  }

  const session = activeHermesSession;
  const { page } = session;
  let shouldCloseSession = true;
  let storageState = null;
  try {
    await fillOtp(page, otp);
    await clickOtpSubmit(page);
    
    let errorText = "";
    let isLogged = false;
    let hasOtpInput = true;
    
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      errorText = await readFirstText(page, ERROR_SELECTORS) || getApiErrorText(session.apiResponses || [], /\/api\/user\/(get-otp|verify|login)/i);
      if (errorText) break;
      
      hasOtpInput = await hasVisibleOtpInput(page);
      isLogged = await isLoggedIn(page);
      
      if (isLogged && !hasOtpInput) break;
    }

    if (errorText) {
      shouldCloseSession = false;
      return { ok: false, message: `OTP Hermes that bai: ${errorText}` };
    }

    if (await hasVisibleOtpInput(page)) {
      shouldCloseSession = false;
      return { ok: false, otpRequired: true, message: "Hermes van dang cho OTP. Ma vua nhap co the chua dung hoac chua du." };
    }

    if (!(await isLoggedIn(page))) {
      return { ok: false, message: "Da gui OTP nhung Hermes chua vao duoc trang sau dang nhap." };
    }

    storageState = await session.context.storageState().catch(() => null);
    return { ok: true, message: "Dang nhap Hermes OK sau OTP.", storageState };
  } catch (error) {
    return { ok: false, message: error.message || "Khong xac nhan duoc OTP Hermes.", storageState };
  } finally {
    if (shouldCloseSession) {
      await closeActiveHermesSession();
    }
  }
}

function getHermesBaseUrl() {
  if (config.hermesBaseUrl) {
    return config.hermesBaseUrl;
  }
  if (config.hermesLoginUrl) {
    return new URL(config.hermesLoginUrl).origin;
  }
  return "";
}

export function toHermesLocalDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseHermesLocalDateParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function fromHermesLocalDate(value) {
  const parts = parseHermesLocalDateParts(value);
  if (!parts) {
    return null;
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
}

function hermesLocalDayOfWeek(date) {
  const parts = parseHermesLocalDateParts(toHermesLocalDate(date));
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  return noonUtc.getUTCDay() || 7;
}

function addHermesLocalDays(date, days) {
  const parts = parseHermesLocalDateParts(toHermesLocalDate(date));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
}

function addDays(date, days) {
  return addHermesLocalDays(date, days);
}

export function getWeekRange(date) {
  const localDate = fromHermesLocalDate(toHermesLocalDate(date));
  const day = hermesLocalDayOfWeek(localDate);
  const start = addHermesLocalDays(localDate, 1 - day);
  const end = addHermesLocalDays(start, 6);
  return { start, end };
}

function formatHermesDateTime(date, endOfDay = false) {
  return `${toHermesLocalDate(date)} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function encodeHermesScheduleDateTime(value) {
  return String(value).replace(" ", "%20");
}

function buildScheduleUrl(targetDate, page = 0) {
  const baseUrl = getHermesBaseUrl();
  if (!baseUrl) {
    throw new Error("Chua cau hinh HERMES_BASE_URL/HERMES_LOGIN_URL.");
  }
  const { start, end } = getWeekRange(targetDate);
  const query = [
    `startTime=${encodeHermesScheduleDateTime(formatHermesDateTime(start))}`,
    `endTime=${encodeHermesScheduleDateTime(formatHermesDateTime(end, true))}`,
    "deptCode=HAN_SUPPORT",
    "teamId=5fe9bcb15885324fa7a01a02",
    `page=${Number(page) || 0}`
  ].join("&");
  return `${baseUrl}/api/support-online/working-schedule/list?${query}`;
}

function formatDatePickerRange(date) {
  const { start, end } = getWeekRange(date);
  const format = (value) => {
    const [year, month, day] = toHermesLocalDate(value).split("-");
    return `${day}/${month}/${year}`;
  };
  return `${format(start)} - ${format(end)}`;
}

async function triggerScheduleWeekInUi(page, targetDate) {
  const rangeText = formatDatePickerRange(targetDate);
  const startDay = String(Number(toHermesLocalDate(getWeekRange(targetDate).start).slice(8, 10)));
  const endDay = String(Number(toHermesLocalDate(getWeekRange(targetDate).end).slice(8, 10)));
  const dateInput = page.locator('input.trigger-click, input[matinput]').filter({ hasText: /^$/ }).nth(0);

  try {
    const inputs = page.locator("input");
    const count = await inputs.count();
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const value = await input.inputValue().catch(() => "");
      if (/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/.test(value)) {
        if (value === rangeText) return;
        await input.click({ force: true });
        await page.waitForTimeout(300);
        await page.getByText(startDay, { exact: true }).first().click({ force: true });
        await page.waitForTimeout(300);
        await page.getByText(endDay, { exact: true }).first().click({ force: true });
        await page.waitForTimeout(4000);
        return;
      }
    }
    await dateInput.click({ force: true });
  } catch {
    // If the date picker cannot be driven, the caller will fall back to API/DOM extraction.
  }
}

function buildRequestOrderUrl(id) {
  const baseUrl = getHermesBaseUrl();
  if (!baseUrl) {
    throw new Error("Chua cau hinh HERMES_BASE_URL/HERMES_LOGIN_URL.");
  }
  const params = new URLSearchParams({ id });
  return `${baseUrl}/api/request-order/get?${params.toString()}`;
}

function buildRequestOrderPageUrl(id) {
  const baseUrl = getHermesBaseUrl();
  return baseUrl && id ? `${baseUrl}/request-order/${id}` : "";
}

function mapScheduleType(type) {
  const raw = String(type || "").trim();
  const value = raw.toUpperCase();
  if (["BUSY", "DUTY", "ON_DUTY", "SHIFT", "WORK_SHIFT"].includes(value)) return "Lịch trực";
  if (value === "ONSITE") return "Onsite";
  if (value === "MAINTENANCE") return "Bảo trì";
  if (value === "DEPLOY") return "Triển khai";
  if (value === "DEPLOY_EXTRA") return "Triển khai thêm";
  if (value === "FURTHER_DEPLOY") return "Hỗ trợ tiếp";
  if (value === "LEAVE" || value === "OFF") return "Nghỉ";
  if (/lịch trực|lich truc|trực ca|truc ca|ca trực|ca truc/i.test(raw)) return "Lịch trực";
  if (/onsite/i.test(raw)) return "Onsite";
  if (/triển khai thêm|trien khai them/i.test(raw)) return "Triển khai thêm";
  if (/triển khai|trien khai|deploy/i.test(raw)) return "Triển khai";
  if (/hỗ trợ tiếp|ho tro tiep/i.test(raw)) return "Hỗ trợ tiếp";
  if (/bảo trì|bao tri|maint/i.test(raw)) return "Bảo trì";
  if (/nghỉ|nghi|leave|off/i.test(raw)) return "Nghỉ";
  return "";
}

function parseScheduleResponse(text) {
  const data = parseJsonSafe(text);
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data.data)) {
    return data.data;
  }
  if (Array.isArray(data.items)) {
    return data.items;
  }
  if (Array.isArray(data.result)) {
    return data.result;
  }
  if (Array.isArray(data.data?.data)) {
    return data.data.data;
  }
  if (Array.isArray(data.data?.items)) {
    return data.data.items;
  }
  if (Array.isArray(data.data?.content)) {
    return data.data.content;
  }
  return [];
}

function scheduleResponseMayHaveMorePages(text) {
  const data = parseJsonSafe(text);
  if (!data || typeof data !== "object") return false;
  const roots = [data, data.data, data.result].filter((item) => item && typeof item === "object" && !Array.isArray(item));
  for (const root of roots) {
    if (root.last === false || root.hasNext === true || root.hasMore === true) return true;
    const totalPages = Number(root.totalPages || root.totalPage || root.pages || root.pageCount);
    const page = Number(root.page ?? root.number ?? root.currentPage ?? root.pageIndex ?? 0);
    if (Number.isFinite(totalPages) && totalPages > 0 && Number.isFinite(page) && page + 1 < totalPages) return true;
    const total = Number(root.total || root.totalElements || root.totalRecords || root.totalCount);
    const size = Number(root.size || root.pageSize || root.numPerPage || root.limit || root.perPage);
    if (Number.isFinite(total) && Number.isFinite(size) && size > 0 && Number.isFinite(page) && (page + 1) * size < total) return true;
  }
  return false;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function objectHasDirectScheduleSignal(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  return keys.some((key) => /schedule|working|work|ticket|request|calendar|support|type|status|start|end|date|link|url/.test(key));
}

function valueContainsTargetDate(value, targetDateText) {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return String(value).includes(targetDateText);
  return Object.values(value).some((child) => valueContainsTargetDate(child, targetDateText));
}

function getDirectScheduleDateValues(value) {
  if (!isPlainObject(value)) return [];
  const dateKeys = new Set([
    "starttime",
    "endtime",
    "workingdate",
    "workdate",
    "scheduledate",
    "date"
  ]);
  const values = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined || typeof child === "object") continue;
    if (dateKeys.has(key.toLowerCase())) values.push(String(child));
  }
  return values;
}

function isScheduleItemOnTargetDate(value, targetDateText) {
  return getDirectScheduleDateValues(value).some((item) => isSameHermesDay(item, targetDateText));
}

function hasNestedScheduleCollection(value) {
  if (!isPlainObject(value)) return false;
  return Object.values(value).some((child) => Array.isArray(child) && child.some((item) => isPlainObject(item) && objectHasDirectScheduleSignal(item)));
}

function collectScheduleItems(value, targetDateText, output = [], depth = 0) {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    const directMatches = value.filter((item) => {
      if (!isPlainObject(item) || hasNestedScheduleCollection(item)) return false;
      const text = JSON.stringify(item);
      return isScheduleItemOnTargetDate(item, targetDateText)
        && objectHasDirectScheduleSignal(item)
        && /#\d{5,}|Lịch trực|Lich truc|Nghỉ|Nghi|Đã phân lịch|Da phan lich|Tạm dừng|Tam dung|FABI|iPOS|CRM|ONSITE|DEPLOY|BUSY/i.test(text);
    });
    if (directMatches.length) {
      output.push(...directMatches);
      return output;
    }
    for (const item of value) {
      collectScheduleItems(item, targetDateText, output, depth + 1);
    }
    return output;
  }

  const text = JSON.stringify(value);
  const hasTargetDate = isScheduleItemOnTargetDate(value, targetDateText);
  const hasUsefulScheduleSignal = /#\d{5,}|Lịch trực|Lich truc|Nghỉ|Nghi|Đã phân lịch|Da phan lich|Tạm dừng|Tam dung|FABI|iPOS|CRM|ONSITE|DEPLOY|BUSY/i.test(text);
  if (hasTargetDate && hasUsefulScheduleSignal && objectHasDirectScheduleSignal(value) && !hasNestedScheduleCollection(value)) {
    output.push(value);
    return output;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectScheduleItems(child, targetDateText, output, depth + 1);
    }
  }
  return output;
}

function flattenScheduleText(value) {
  const seen = new Set();
  const parts = [];
  const visit = (item) => {
    if (item === null || item === undefined) {
      return;
    }
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const text = String(item).trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        parts.push(text);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    if (typeof item === "object") {
      for (const child of Object.values(item)) {
        visit(child);
      }
    }
  };
  visit(value);
  return parts;
}

function normalizeHermesPrincipal(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.replace(/@ipos\.vn$/i, "");
}

function makeHermesViewerIdentity(username = "") {
  const principal = normalizeHermesPrincipal(username);
  return {
    username: principal,
    email: principal ? `${principal}@ipos.vn` : "",
    matches(value) {
      const candidate = normalizeHermesPrincipal(value);
      return Boolean(candidate && candidate === principal);
    }
  };
}

function isSameHermesDay(value, targetDateText) {
  return Boolean(value && String(value).slice(0, 10) === targetDateText);
}

function isScheduleEntryForViewer(item, viewer) {
  if (!viewer?.username) return true;
  const order = item?.requestOrder && typeof item.requestOrder === "object" ? item.requestOrder : null;
  const candidates = [
    item?.employeeEmail,
    item?.email,
    item?.username,
    item?.employeeUserName,
    item?.userName,
    item?.owner,
    item?.supporter,
    item?.assignee,
    order?.picSp,
    order?.picSupport,
    order?.picSupporter,
    order?.deploymentContactEmail
  ].filter((value) => value !== null && value !== undefined && String(value).trim() !== "");
  if (!candidates.length) return true;
  return candidates.some((value) => viewer.matches(value));
}

function isClosedStatus(status, rawStatus) {
  const text = `${status || ""} ${rawStatus || ""}`.toLowerCase();
  return /hoàn thành|đã duyệt|đã xử lý|đã hủy|từ chối|triển khai xong|đã xác nhận|completed|reviewed|processed|cancelled|rejected|closed|done|finish|finished|confirmed|qualified/i.test(text);
}

function filterScheduleEntriesForViewer(entries, viewer, targetDateText) {
  return (entries || [])
    .filter((entry) => !targetDateText || entry?.date === targetDateText || isSameHermesDay(entry?.raw?.startTime, targetDateText) || isSameHermesDay(entry?.raw?.endTime, targetDateText))
    .filter((entry) => isScheduleEntryForViewer(entry?.raw || entry, viewer))
    .filter((entry) => !isClosedStatus(entry.status, entry.raw?.spStatus || entry.raw?.requestOrder?.spStatus || entry.raw?.status))
    .map((entry) => ({ ...entry, owner: entry.owner || viewer?.username || "" }));
}

function extractScheduleEntriesFromBody(bodyText, targetDate, viewer = makeHermesViewerIdentity()) {
  const targetDateText = toHermesLocalDate(targetDate);
  const lineItems = [];
  const lines = String(bodyText || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const userIndex = lines.findIndex((line) => viewer.matches(line));
  if (userIndex >= 0) {
    const employeeLinePattern = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*(?:@ipos\.vn)?$/i;
    const block = [];
    for (const line of lines.slice(userIndex + 1)) {
      if (employeeLinePattern.test(line) && !viewer.matches(line)) break;
      block.push(line);
    }
    for (let index = 0; index < block.length; index += 1) {
      const line = block[index];
      if (/^#\d+\b|^Lịch trực$|^Nghỉ$|^Hỗ trợ tiếp$/i.test(line)) {
        const next = block[index + 1] || "";
        if (/^(Đã phân lịch|Tạm dừng|Đã hoàn thành|Chờ lịch)$/i.test(next)) {
          lineItems.push(`${line} — ${next}`);
          index += 1;
        } else {
          lineItems.push(line);
        }
      }
    }
  }

  return lineItems.map((text, index) => {
    const links = collectLinks(text);
    return {
      id: `${targetDateText}-body-${index}`,
      ticket: text.match(/#\d{5,}/)?.[0] || "",
      type: detectScheduleType(text),
      status: text.match(/Đã phân lịch|Tạm dừng|Đã hoàn thành|Chờ lịch|Nghỉ/i)?.[0] || "",
      product: text.replace(/^#\d+\s*-\s*/, "").replace(/\s+—\s+.*$/, ""),
      customer: "",
      owner: viewer.username || "",
      shift: "",
      time: "",
      note: "",
      links,
      link: links[0] || "",
      text,
      date: targetDateText
    };
  });
}

async function extractScheduleEntriesFromDom(page, targetDate, viewer = makeHermesViewerIdentity()) {
  const targetDateText = toHermesLocalDate(targetDate);
  const rawItems = await page.evaluate(({ target, viewerName }) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const headers = [...document.querySelectorAll(".header-wrapper .date-in-week")].map((element) => {
      const rect = element.getBoundingClientRect();
      const text = clean(element.innerText);
      const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
      return { date, left: rect.left, right: rect.right, width: rect.width };
    }).filter((item) => item.date);
    const targetHeader = headers.find((item) => item.date === target);
    if (!targetHeader) {
      return [];
    }

    const rows = [...document.querySelectorAll(".employee-wrapper")];
    const row = rows.find((element) => {
      const text = clean(element.querySelector(".emp-info")?.innerText || element.innerText).toLowerCase();
      return text.split(/\s+/).some((part) => part.replace(/@ipos\.vn$/i, "") === viewerName);
    });
    if (!row) {
      return [];
    }

    const dayWidth = targetHeader.width || (targetHeader.right - targetHeader.left) || 1;
    const absolutize = (href) => {
      if (!href) return "";
      try {
        return new URL(href, window.location.origin).toString();
      } catch {
        return href;
      }
    };
    const items = [...row.querySelectorAll(".grid-stack-item")].map((element) => {
      const rect = element.getBoundingClientRect();
      const content = element.querySelector(".grid-stack-item-content") || element;
      const overlap = Math.max(0, Math.min(rect.right, targetHeader.right) - Math.max(rect.left, targetHeader.left));
      const title = clean(content.getAttribute("title") || element.getAttribute("title") || "");
      const hrefs = [...element.querySelectorAll("a[href]")].map((anchor) => absolutize(anchor.getAttribute("href"))).filter(Boolean);
      const onclickTexts = [element.getAttribute("onclick"), content.getAttribute("onclick")].filter(Boolean).join(" ");
      const detailTexts = [...element.querySelectorAll("p")]
        .map((node) => clean(node.innerText || node.textContent || ""))
        .filter(Boolean);
      return {
        text: clean(element.innerText),
        title,
        hrefs,
        onclickTexts,
        detailTexts,
        className: String(element.className || ""),
        html: element.innerHTML,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        overlap
      };
    });

    return items
      .filter((item) => item.text && item.overlap >= Math.min(20, dayWidth * 0.2))
      .map((item) => ({
        text: item.text,
        title: item.title,
        hrefs: item.hrefs,
        onclickTexts: item.onclickTexts,
        detailTexts: item.detailTexts,
        className: item.className,
        html: item.html
      }));
  }, { target: targetDateText, viewerName: viewer.username }).catch(() => []);

  const parseTimeFromTitle = (title) => {
    const match = String(title || "").match(/Từ\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+đến\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i);
    return match ? `${match[1]} đến ${match[2]}` : "";
  };

  const noteFromTitle = (title) => {
    const source = String(title || "").replace(/\s+/g, " ").trim();
    const labels = ["Ghi chú", "Nội dung", "Lý do", "Mô tả", "Mo ta"];
    const labeledNotes = [];
    for (const label of labels) {
      const regex = new RegExp(`${label}\\s*:\\s*(.*?)(?=\\s+(?:${labels.join("|")}|Trạng thái triển khai|Địa điểm triển khai|Khách hàng|Cửa hàng)\\s*:|$)`, "gi");
      for (const match of source.matchAll(regex)) {
        const value = match[1]?.trim();
        if (value) labeledNotes.push(`${label}: ${value}`);
      }
    }
    if (labeledNotes.length) return Array.from(new Set(labeledNotes)).join(" | ");

    return String(title || "")
      .split(/\s*(?:\n|\|)\s*/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^Từ\s+\d{4}-\d{2}-\d{2}/i.test(line))
      .join(" | ");
  };

  const noteFromItem = (item, title) => {
    const lines = [
      noteFromTitle(title),
      ...((item.detailTexts || []).filter((value) => value && value !== item.text))
    ]
      .flatMap((value) => String(value || "").split(/\s*(?:\n|\|)\s*/))
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^Từ\s+\d{4}-\d{2}-\d{2}/i.test(line));
    return Array.from(new Set(lines)).join(" | ");
  };

  const typeFromClass = (className, text) => {
    if (/type-further-deploy/i.test(className)) return "Hỗ trợ tiếp";
    if (/type-busy/i.test(className)) return "Lịch trực";
    if (/type-onsite/i.test(className)) return "Onsite";
    if (/type-deploy-extra/i.test(className)) return "Triển khai thêm";
    if (/type-deploy/i.test(className)) return "Triển khai";
    if (/type-maintain|type-maintenance/i.test(className)) return "Bảo trì";
    if (/type-leave|type-off|type-absence|type-vacation|type-holiday/i.test(className)) return "Nghỉ";
    return detectScheduleType(text);
  };

  return rawItems.map((item, index) => {
    const text = item.text;
    const ids = Array.from(new Set(`${text}\n${item.title || ""}\n${item.html || ""}`.match(/\b[a-f0-9]{24}\b/gi) || []));
    const links = collectLinks(`${text}\n${item.title || ""}\n${item.html || ""}\n${(item.hrefs || []).join("\n")}`);
    for (const id of ids) {
      const pageUrl = buildRequestOrderPageUrl(id);
      if (pageUrl && !links.includes(pageUrl)) links.push(pageUrl);
    }
    const titleText = item.title || "";
    const type = typeFromClass(item.className, `${text}\n${titleText}`);
    const link = links[0] || "";
    const allLinks = links;
    const note = noteFromItem(item, titleText);
    const richText = [text, note].filter(Boolean).join("\n");
    const status = text.match(/Đã phân lịch|Tạm dừng|Đã hoàn thành|Chờ lịch|Nghỉ|Triển khai xong|Đã xác nhận/i)?.[0]
      || titleText.match(/Trạng thái triển khai:\s*([^|\n]+)/i)?.[1]?.trim()
      || "";
    const product = text
      .replace(/^#\d+\s*-\s*/, "")
      .replace(/\s+(Đã phân lịch|Tạm dừng|Đã hoàn thành|Chờ lịch)$/i, "")
      .trim();
    return {
      id: ids[0] || `${targetDateText}-dom-${index}`,
      ticket: text.match(/#\d{5,}/)?.[0] || "",
      type,
      status,
      product,
      customer: titleText.match(/(?:Khách hàng|Cửa hàng|Địa điểm triển khai):\s*([^|\n]+)/i)?.[1]?.trim() || "",
      owner: viewer.username || "",
      shift: "",
      time: parseTimeFromTitle(titleText),
      note,
      links: allLinks,
      link,
      text: richText,
      date: targetDateText
    };
  });
}

function getFieldValue(item, names) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const normalizedNames = names.map((name) => String(name).toLowerCase());
  const stack = [item];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      const lowerKey = key.toLowerCase();
      if ((normalizedNames.includes(lowerKey) || normalizedNames.some((name) => lowerKey.includes(name))) && value !== null && value !== undefined && typeof value !== "object") {
        return String(value).trim();
      }
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return "";
}

function collectLinks(item) {
  const links = [];
  const seenLinks = new Set();
  const stack = [item];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === null || current === undefined || seen.has(current)) continue;
    if (typeof current === "string") {
      const matches = current.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      for (const link of matches) {
        if (!seenLinks.has(link)) {
          seenLinks.add(link);
          links.push(link);
        }
      }
      continue;
    }
    if (typeof current !== "object") continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      const lowerKey = key.toLowerCase();
      if ((/url|link|href/.test(lowerKey) || lowerKey === "_id" || lowerKey === "id") && typeof value === "string" && value.trim()) {
        let link = value.trim();
        if (/^(?:_id|id)$/i.test(key) && /^[a-f0-9]{24}$/i.test(link)) {
          const pageUrl = buildRequestOrderPageUrl(link);
          link = pageUrl || link;
        } else if (link.startsWith("/")) {
          const baseUrl = getHermesBaseUrl();
          link = baseUrl ? `${baseUrl}${link}` : link;
        }
        if (!seenLinks.has(link)) {
          seenLinks.add(link);
          links.push(link);
        }
      }
      if (value && typeof value === "object") {
        stack.push(value);
      } else if (typeof value === "string") {
        const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        for (const link of matches) {
          if (!seenLinks.has(link)) {
            seenLinks.add(link);
            links.push(link);
          }
        }
      }
    }
  }
  return links;
}

function detectScheduleType(text) {
  const value = String(text || "");
  if (/\b(BUSY|DUTY|ON_DUTY|SHIFT|WORK_SHIFT)\b|lịch trực|lich truc|trực ca|truc ca|ca trực|ca truc/i.test(value)) return "Lịch trực";
  if (/\b(LEAVE|OFF)\b|nghỉ|nghi/i.test(value)) return "Nghỉ";
  if (/\bFURTHER_DEPLOY\b|hỗ trợ tiếp|ho tro tiep/i.test(value)) return "Hỗ trợ tiếp";
  if (/\bONSITE\b|onsite/i.test(value)) return "Onsite";
  if (/\bMAINTENANCE\b|bảo trì|bao tri/i.test(value)) return "Bảo trì";
  if (/\bDEPLOY_EXTRA\b|triển khai thêm|trien khai them/i.test(value)) return "Triển khai thêm";
  if (/\bDEPLOY\b|triển khai|trien khai/i.test(value)) return "Triển khai";
  return "Chưa xác định";
}

function buildScheduleEntry(item, targetDateText, fallbackIndex = 0) {
  const order = item?.requestOrder && typeof item.requestOrder === "object" ? item.requestOrder : null;
  if (order) {
    const requestOrderId = order._id || item.requestOrderId || item.roId || "";
    const scheduleId = item._id || item.id || "";
    const ticket = order.roCode || item.roCode || "";
    const links = collectLinks(item);
    const pageUrl = buildRequestOrderPageUrl(requestOrderId);
    if (pageUrl && !links.includes(pageUrl)) links.unshift(pageUrl);
    const time = [item.startTime || order.deploymentTime, item.endTime || order.estDeployEndTime]
      .filter(Boolean)
      .join(" đến ");
    const product = order.productCode || getFieldValue(item, ["productName", "product", "moduleName", "serviceName", "projectName"]);
    const customer = order.storeAddress || order.deploymentAddress || order.storeName || order.customerName || "";
    const status = mapDeployStatus(order.spStatus) || getFieldValue(item, ["statusName", "status", "scheduleStatus", "ticketStatus"]);
    const owner = String(item.employeeEmail || order.picSp || "").replace(/@ipos\.vn$/i, "");
    const note = order.contractNote || getFieldValue(item, ["note", "description", "content", "reason"]);
    const requestOrderType = getRequestOrderTypeLabel(order);
    const type = requestOrderType || mapScheduleType(item.type || order.type) || detectScheduleType(JSON.stringify(item));
    const text = [
      `#${ticket} - ${product} ${status}`.trim(),
      order.customerName ? `Khách hàng: ${order.customerName}` : "",
      order.storeName ? `Cửa hàng: ${order.storeName}` : "",
      customer ? `Địa điểm: ${customer}` : "",
      note ? `Nội dung: ${note}` : ""
    ].filter(Boolean).join("\n");

    return {
      id: requestOrderId || scheduleId || `${targetDateText}-${fallbackIndex}`,
      scheduleId,
      requestOrderId,
      ticket: ticket ? `#${ticket}` : "",
      type,
      requestOrderType,
      status,
      product,
      customer,
      owner,
      shift: "",
      time,
      note,
      links,
      link: links[0] || "",
      text,
      raw: item,
      date: targetDateText
    };
  }

  const parts = flattenScheduleText(item);
  const cleanParts = parts
    .filter((part) => !/^([a-f0-9]{24}|true|false|null)$/i.test(part))
    .filter((part) => part !== targetDateText);
  const text = cleanParts.join(" | ") || JSON.stringify(item);
  const ticketMatch = text.match(/#\d{5,}/);
  const product = getFieldValue(item, ["productName", "product", "moduleName", "serviceName", "projectName"]);
  const customer = getFieldValue(item, ["customerName", "customer", "storeName", "merchantName", "shopName"]);
  const status = getFieldValue(item, ["statusName", "status", "scheduleStatus", "ticketStatus"])
    || (text.match(/Đã phân lịch|Tạm dừng|Đã hoàn thành|Chờ lịch|Nghỉ/i)?.[0] || "");
  const owner = getFieldValue(item, ["assignee", "assigneeName", "employeeName", "supporter", "supporterName", "username"]);
  const shift = getFieldValue(item, ["shift", "shiftName", "session", "sessionName", "timeName"])
    || (text.match(/\b(Sáng|Chi?u|Tối)\b/i)?.[0] || "");
  const time = getFieldValue(item, ["startTime", "endTime", "fromTime", "toTime", "scheduleTime", "date", "workingDate", "workDate"]);
  const note = getFieldValue(item, ["note", "description", "content", "reason"]);
  const type = mapScheduleType(getFieldValue(item, ["type", "typeName", "scheduleType", "scheduleTypeName", "workType", "workTypeName", "taskType", "taskTypeName"])) || detectScheduleType(text);
  const id = getFieldValue(item, ["_id", "id", "scheduleId"]);
  const links = collectLinks(item);
  if (/^[a-f0-9]{24}$/i.test(id)) {
    const pageUrl = buildRequestOrderPageUrl(id);
    if (pageUrl && !links.includes(pageUrl)) links.push(pageUrl);
  }

  return {
    id: id || `${targetDateText}-${fallbackIndex}`,
    ticket: ticketMatch?.[0] || "",
    type,
    status,
    product,
    customer,
    owner,
    shift,
    time,
    note,
    links,
    link: links[0] || "",
    text,
    raw: item,
    date: targetDateText
  };
}

function normalizeScheduleEntriesFromApi(apiResponses, targetDate, viewer = makeHermesViewerIdentity()) {
  const targetDateText = toHermesLocalDate(targetDate);
  for (const response of [...apiResponses].reverse()) {
    if (!/\/api\/support-online\/working-schedule\/list/i.test(response.url) || !response.body) {
      continue;
    }
    const roots = parseScheduleResponse(response.body);
    const rawItems = collectScheduleItems(roots, targetDateText)
      .filter((item) => isScheduleItemOnTargetDate(item, targetDateText))
      .filter((item) => isScheduleEntryForViewer(item, viewer));
    if (rawItems.length) {
      return rawItems.map((item, index) => buildScheduleEntry(item, targetDateText, index));
    }
  }
  return [];
}

async function createHermesBrowserContext(storageState = null) {
  const browser = await chromium.launch({ headless: config.headless, channel: "chrome" }).catch(async () => await chromium.launch({ headless: config.headless }));
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: 1365, height: 900 },
    ...(storageState ? { storageState } : {})
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  const apiResponses = createApiCapture(page);
  return { browser, context, page, apiResponses };
}

async function loginHermesPage({ username, password, purpose = "work_schedule" }) {
  const { browser, context, page, apiResponses } = await createHermesBrowserContext();

  await page.goto(config.hermesLoginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
  await page.waitForSelector("input", { state: "visible", timeout: config.timeoutMs });
  await page.waitForTimeout(500);
  await fillFirstVisible(page, USERNAME_SELECTORS, username, "tai khoan");
  await fillFirstVisible(page, PASSWORD_SELECTORS, password, "mat khau");
  await clickFirstVisible(page, SUBMIT_SELECTORS);
  await page.waitForTimeout(3000);

  const errorText = await readFirstText(page, ERROR_SELECTORS) || getApiErrorText(apiResponses, /\/api\/user\/pre-login/i);
  if (errorText) {
    await browser.close().catch(() => {});
    return { ok: false, message: `Dang nhap Hermes that bai: ${errorText}` };
  }

  if (await waitForHermesOtpInput(page)) {
    keepHermesOtpSession({ browser, context, page, username, apiResponses, purpose });
    return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP. Hay gui ma OTP de em xac nhan tiep." };
  }

  if (!(await isLoggedIn(page))) {
    if (await waitForHermesOtpInput(page, 5000)) {
      keepHermesOtpSession({ browser, context, page, username, apiResponses, purpose });
      return { ok: false, otpRequired: true, message: "Hermes yeu cau OTP. Hay gui ma OTP de em xac nhan tiep." };
    }
    await browser.close().catch(() => {});
    return { ok: false, message: "Hermes van dung o man hinh dang nhap, kha nang sai tai khoan/mat khau." };
  }

  return { ok: true, browser, context, page, apiResponses };
}

async function readScheduleFromLoggedInPage(page, apiResponses, targetDate, username = "", options = {}) {
  const viewer = makeHermesViewerIdentity(username);
  const scheduleUrl = new URL("/support-working-schedule", config.hermesLoginUrl).toString();
  await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
  await page.waitForTimeout(7000);
  await triggerScheduleWeekInUi(page, targetDate);

  if (await hasVisibleOtpInput(page) || !(await isLoggedIn(page))) {
    return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc bị yêu cầu đăng nhập lại." };
  }

  const targetDateText = toHermesLocalDate(targetDate);
  const buildResult = (entries, resultDateText = targetDateText) => ({
    ok: true,
    targetDate: resultDateText,
    checkedAt: new Date(),
    entries,
    message: entries.length ? "Co lich lam viec." : "Khong co lich lam viec."
  });
  const collectWeekEntries = () => {
    const startDate = getWeekRange(targetDate).start;
    const results = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = getRelativeWorkScheduleDate(offset, startDate);
      const dayText = toHermesLocalDate(day);
      let dayEntries = normalizeScheduleEntriesFromApi(apiResponses, day, viewer);
      dayEntries = filterScheduleEntriesForViewer(dayEntries, viewer, dayText);
      results.push({
        ok: true,
        targetDate: dayText,
        checkedAt: new Date(),
        entries: dayEntries,
        message: dayEntries.length ? "Co lich lam viec." : "Khong co lich lam viec."
      });
    }
    return results;
  };

  if (options.fetchFullWeek) {
    const weekResults = collectWeekEntries();
    if (weekResults.some(r => r.entries.length > 0)) {
      return { ok: true, weekResults };
    }
  }

  let entries = normalizeScheduleEntriesFromApi(apiResponses, targetDate, viewer);
  entries = filterScheduleEntriesForViewer(entries, viewer, targetDateText);
  if (entries.length) return buildResult(entries);

  for (let pageIndex = 0; !entries.length && pageIndex < 5; pageIndex += 1) {
    const apiUrl = buildScheduleUrl(targetDate, pageIndex);
    const fetched = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      return { status: response.status, body: await response.text() };
    }, apiUrl).catch(() => null);
    if (!fetched) break;

    apiResponses.push({ url: apiUrl, method: "GET", status: fetched.status, requestBody: "", body: fetched.body });
    if ([401, 403].includes(fetched.status) || /login|unauthori[sz]ed|otp|forbidden/i.test(fetched.body || "")) {
      return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc API yêu cầu đăng nhập lại." };
    }
    if (!scheduleResponseMayHaveMorePages(fetched.body)) break;
  }

  if (options.fetchFullWeek) {
    return { ok: true, weekResults: collectWeekEntries() };
  }
  if (!entries.length) {
    entries = await extractScheduleEntriesFromDom(page, targetDate, viewer);
    entries = filterScheduleEntriesForViewer(entries, viewer, targetDateText);
  }
  if (!entries.length) {
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const hasCalendarGrid = /T[2-7]|CN/.test(bodyText) && /\d{4}-\d{2}-\d{2}/.test(bodyText) && (viewer.username ? bodyText.toLowerCase().includes(viewer.username) : true);
    if (!hasCalendarGrid) {
      entries = extractScheduleEntriesFromBody(bodyText, targetDate, viewer);
      entries = filterScheduleEntriesForViewer(entries, viewer, targetDateText);
    }
  }

  return buildResult(entries);
}


function coalesce(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "---";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === "boolean") return value ? "Có" : "Không";
  return String(value);
}

function money(value) {
  if (value === null || value === undefined || value === "") return "---";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${number.toLocaleString("vi-VN")} đ`;
}

function mapRequestOrderType(value) {
  const map = {
    CONTRACT_ONLY: "Hợp đồng (KHÔNG TRIỂN KHAI)",
    CONTRACT_AND_DEPLOY: "Hợp đồng & Triển khai",
    INVOICE_AND_DEPLOY: "Phiếu thu & Triển khai",
    ADJUST: "Phiếu hiệu chỉnh",
    MAINTENANCE: "Phiếu bảo trì",
    EXTRA_DEPLOY: "Phiếu triển khai thêm",
    DEPLOY_EXTRA: "Phiếu triển khai thêm",
    ONSITE: "Phiếu Onsite",
    REMOTE: "Từ xa",
    DEPLOY: "Phiếu triển khai",
    FURTHER_DEPLOY: "Phiếu hỗ trợ tiếp",
    INVOICE: "Phiếu thu",
    CANCEL: "Hủy"
  };
  return map[value] || value || "---";
}

function mapContractType(value) {
  const map = { COMPANY: "Công ty", PERSONAL: "Cá nhân" };
  return map[value] || value || "---";
}

function mapDeployType(value) {
  const map = { TECHNICAL: "Kỹ thuật", ONLINE: "Online", ONSITE: "Onsite" };
  return map[value] || value || "---";
}

function mapRequestOrderStatus(value) {
  const map = {
    PENDING: "Chờ xử lý",
    COMPLETED: "Hoàn thành",
    REVIEWED: "Đã duyệt",
    RECEIVED: "Đã nhận",
    PROCESSED: "Đã xử lý",
    DELOYING: "Đang triển khai",
    DEPLOYING: "Đang triển khai",
    ASSIGNED: "Đã phân lịch",
    CANCELLED: "Đã hủy",
    REJECTED: "Từ chối"
  };
  return map[value] || value || "---";
}

function mapDeployStatus(value) {
  const map = {
    PENDING: "Tạm dừng",
    COMPLETED: "Hoàn thành",
    REVIEWED: "Đã duyệt",
    RECEIVED: "Đã nhận",
    PROCESSED: "Đã xử lý",
    DELOYING: "Đang triển khai",
    DEPLOYING: "Đang triển khai",
    ASSIGNED: "Đã phân lịch",
    CANCELLED: "Đã hủy",
    REJECTED: "Từ chối"
  };
  return map[value] || value || "---";
}

function formatRequestOrderProducts(details = [], devices = []) {
  if (!Array.isArray(details) || !details.length) return ["---"];
  return details.slice(0, 12).map((item, index) => {
    const serial = Array.isArray(devices)
      ? devices.find((device) => device?.SKU && item?.SKU && device.SKU === item.SKU)?.serial
      : "";
    const suffix = [
      item?.serviceCode ? `(${item.serviceCode})` : "",
      item?.SKU ? `SKU: ${item.SKU}` : "",
      serial ? `Serial: ${serial}` : ""
    ].filter(Boolean).join(" | ");
    return `${index + 1}. ${displayValue(item?.serviceName)}${suffix ? ` - ${suffix}` : ""}
   Đơn giá: ${money(coalesce(item?.salePrice, item?.orgPrice))} | SL: ${displayValue(item?.quantity)} ${displayValue(item?.serviceUnit)} | Thành tiền: ${money(item?.amount)}`;
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlValue(value) {
  return escapeHtml(displayValue(value));
}

function htmlMoney(value) {
  return escapeHtml(money(value));
}

function htmlLine(label, value) {
  return `<b>${escapeHtml(label)}:</b> ${htmlValue(value)}`;
}

function splitHermesDateTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (!match) return { date: displayValue(value), time: "---" };
  return { date: match[1], time: match[2] };
}

function normalizeVietnamPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[\s.\-]/g, "");
  if (/^84\d{8,11}$/.test(compact)) {
    return `0${compact.slice(2)}`;
  }
  if (/^\+84\d{8,11}$/.test(compact)) {
    return `0${compact.slice(3)}`;
  }
  return raw;
}

function htmlPhone(value) {
  const text = displayValue(normalizeVietnamPhone(value));
  if (text === "---") return text;
  return `<code>${escapeHtml(text)}</code>`;
}

function htmlLink(label, url) {
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : "Không có";
}

function compactLines(lines) {
  return lines.filter((line) => line !== null && line !== undefined && String(line).trim() !== "").join("\n");
}

function formatRequestOrderProductsHtml(details = [], devices = []) {
  if (!Array.isArray(details) || !details.length) return "---";
  return details.slice(0, 5).map((item, index) => {
    const serial = Array.isArray(devices)
      ? devices.find((device) => device?.SKU && item?.SKU && device.SKU === item.SKU)?.serial
      : "";
    const suffix = [
      item?.serviceCode ? item.serviceCode : "",
      item?.SKU ? `SKU ${item.SKU}` : "",
      serial ? `Serial ${serial}` : ""
    ].filter(Boolean).join(" | ");
    return `• <b>${index + 1}. ${htmlValue(item?.serviceName)}</b>${suffix ? ` (${escapeHtml(suffix)})` : ""}`;
  }).join("\n");
}

function usefulText(value) {
  const text = displayValue(value);
  return text === "---" ? "" : text;
}

function getRequestOrderTypeLabel(order = {}) {
  return usefulText(order?.requestOrderTypeName)
    || usefulText(order?.roTypeName)
    || usefulText(order?.typeName)
    || usefulText(order?.requestTypeName)
    || usefulText(order?.requestOrderType)
    || usefulText(mapRequestOrderType(order?.type));
}

function getScheduleRequestOrderTypeLabel(entry = {}) {
  const order = entry?.raw?.requestOrder || {};
  return usefulText(entry?.requestOrderType)
    || getRequestOrderTypeLabel(order);
}

function buildRequestOrderInfoTitle(label = "") {
  const cleanLabel = usefulText(label);
  return cleanLabel ? `Th\u00F4ng tin ${cleanLabel}` : "Th\u00F4ng tin phi\u1EBFu";
}

function isFullDayRequestOrderType(label = "") {
  return /hợp\s*đồng\s*&\s*triển\s*khai|hop\s*dong\s*&\s*trien\s*khai|phiếu\s*thu\s*&\s*triển\s*khai|phieu\s*thu\s*&\s*trien\s*khai|contract[_\s-]*and[_\s-]*deploy|invoice[_\s-]*and[_\s-]*deploy/i.test(String(label || ""));
}

function cleanDeployStatusLabel(value) {
  const raw = String(value || "").toUpperCase();
  const map = {
    PENDING: "T\u1EA1m d\u1EEBng",
    COMPLETED: "Ho\u00E0n th\u00E0nh",
    REVIEWED: "\u0110\u00E3 duy\u1EC7t",
    RECEIVED: "\u0110\u00E3 nh\u1EADn",
    PROCESSED: "\u0110\u00E3 x\u1EED l\u00FD",
    DELOYING: "\u0110ang tri\u1EC3n khai",
    DEPLOYING: "\u0110ang tri\u1EC3n khai",
    ASSIGNED: "\u0110\u00E3 ph\u00E2n l\u1ECBch",
    CANCELLED: "\u0110\u00E3 h\u1EE7y",
    REJECTED: "T\u1EEB ch\u1ED1i"
  };
  return map[raw] || mapDeployStatus(value);
}
export function formatRequestOrderDetailHtml(order, { checkedAt = new Date() } = {}) {
  const checkedAtText = new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: config.timezoneId
  }).format(checkedAt);
  const deploymentContact = order?.deploymentContact || {};
  const hubInfo = order?.hubInfo || {};
  const hermesUrl = buildRequestOrderPageUrl(order?._id);
  const customerName = usefulText(order?.customerName);
  const storeName = usefulText(order?.storeName || hubInfo?.name);
  const storeId = usefulText(order?.storeId || hubInfo?.storeId);
  const address = usefulText(order?.deploymentAddress || order?.storeAddress || hubInfo?.address || order?.companyFullAddess);
  const contactName = usefulText(deploymentContact?.name || order?.contactName);
  const contactPhone = deploymentContact?.phone || order?.contactPhone;
  const saleName = usefulText(order?.saleName);
  const saleEmail = usefulText(order?.picSale);
  const deployer = usefulText(order?.picSp);
  const leader = usefulText(order?.picSpLdr);
  const note = usefulText(order?.contractNote);
  const deploymentTime = splitHermesDateTime(order?.deploymentTime);
  const requestOrderType = getRequestOrderTypeLabel(order);
  const requestOrderInfoTitle = buildRequestOrderInfoTitle(requestOrderType);
  const storeLine = [storeName, storeId ? `#${storeId}` : ""].filter(Boolean).join(" \u2022 ");
  const scheduleLine = [deploymentTime.date, deploymentTime.time !== "---" ? deploymentTime.time : "", usefulText(order?.deployTechForm)].filter(Boolean).join(" \u2022 ");
  return compactLines([
    `\uD83D\uDC8E <b>PYC #${htmlValue(order?.roCode)}</b>${order?.productCode ? ` \u2014 <b>${htmlValue(order.productCode)}</b>` : ""}`,
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    `\uD83D\uDCC2 <b>Lo\u1EA1i:</b> ${htmlValue(requestOrderType)}`,
    hermesUrl ? `\uD83D\uDD17 ${htmlLink("M\u1EDF phi\u1EBFu tr\u00EAn Hermes", hermesUrl)}` : "",
    `\uD83D\uDD52 <i>C\u1EADp nh\u1EADt: ${htmlValue(checkedAtText)}</i>`,
    "",
    "\uD83D\uDC65 <b>KH\u00C1CH H\u00C0NG</b>",
    customerName ? `\uD83D\uDC64 T\u00EAn: <b>${htmlValue(customerName)}</b>` : "",
    storeLine ? `\uD83C\uDFEA C\u1EEDa h\u00E0ng: <b>${htmlValue(storeLine)}</b>` : "",
    address ? `\uD83D\uDCCD \u0110\u1ECBa ch\u1EC9: <i>${htmlValue(address)}</i>` : "",
    order?.companyId ? `\uD83C\uDD94 Company ID: <code>${htmlValue(order.companyId)}</code>` : "",
    "",
    "\u260E\uFE0F <b>LI\u00CAN H\u1EC6</b>",
    contactName || contactPhone ? `\uD83D\uDC64 Kh\u00E1ch: <b>${htmlValue(contactName || "---")}</b>${contactPhone ? ` \u2022 ${htmlPhone(contactPhone)}` : ""}` : "",
    saleName || saleEmail || order?.salePhone ? `\uD83D\uDCBC Sale: <b>${htmlValue([saleName, saleEmail].filter((value) => usefulText(value)).join(" \u2022 ") || "---")}</b>${order?.salePhone ? ` \u2022 ${htmlPhone(order.salePhone)}` : ""}` : "",
    "",
    `\uD83D\uDEE0\uFE0F <b>${htmlValue(requestOrderInfoTitle.toUpperCase())}</b>`,
    scheduleLine ? `\uD83D\uDCC5 L\u1ECBch: <b>${htmlValue(scheduleLine)}</b>` : "",
    deployer ? `\uD83D\uDC68\u200D\uD83D\uDD27 X\u1EED l\u00FD: <b>${htmlValue(deployer)}</b>` : "",
    leader ? `\uD83D\uDC68\u200D\uD83D\uDCBC Leader: <b>${htmlValue(leader)}</b>` : "",
    order?.spAssignedAt ? `\uD83D\uDCCC Ph\u00E2n l\u1ECBch: ${htmlValue(displayValue(order.spAssignedAt))}${order?.spAssignedBy ? ` \u2022 ${htmlValue(order.spAssignedBy)}` : ""}` : "",
    "",
    "\uD83D\uDCDD <b>N\u1ED8I DUNG C\u00D4NG VI\u1EC6C</b>",
    note ? `<i>${htmlValue(note)}</i>` : "<i>Kh\u00F4ng c\u00F3 ghi ch\u00FA.</i>",
    "",
    "\uD83D\uDCE6 <b>D\u1ECACH V\u1EE4 / THI\u1EBET B\u1ECA</b>",
    formatRequestOrderProductsHtml(order?.details, order?.devices),
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"
  ]);
}


export function formatRequestOrderDetail(order, { checkedAt = new Date() } = {}) {
  const checkedAtText = new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: config.timezoneId
  }).format(checkedAt);
  const deploymentContact = order?.deploymentContact || {};
  const hubInfo = order?.hubInfo || {};
  const lines = [
    `📋 Chi tiết PYC #${displayValue(order?.roCode)}`,
    `Kiểm tra lúc: ${checkedAtText}`,
    `Link Hermes: ${buildRequestOrderPageUrl(order?._id) || "Không có"}`,
    "",
    `Mã hợp đồng: ${displayValue(order?.contractCode)}`,
    `Mã đơn 3rd Party: ${displayValue(order?.thirdPartyOrderCode)}`,
    `Loại PYC: ${getRequestOrderTypeLabel(order)}`,
    `Loại HĐ?: ${mapContractType(order?.contractType)}`,
    `Sản phẩm: ${displayValue(order?.productCode)}`,
    "",
    "THÔNG TIN PYC",
    `Sale phụ trách: ${[order?.saleName, order?.picSale, order?.salePhone].filter(Boolean).join(" | ") || "---"}`,
    `Leader phụ trách: ${displayValue(order?.picLeader)}`,
    `Tên KH: ${displayValue(order?.customerName)}`,
    `Company ID: ${displayValue(order?.companyId)}`,
    `Mã cửa hàng: ${displayValue(order?.storeId)}`,
    `Tên cửa hàng: ${displayValue(order?.storeName || hubInfo?.name)}`,
    `Ngày tạo: ${displayValue(order?.createdTime)}`,
    `Trạng thái: ${mapRequestOrderStatus(order?.status)} ${displayValue(order?.updatedTime)}`,
    `Trạng thái SA: ${mapRequestOrderStatus(order?.adminStatus)} ${displayValue(order?.adminCompletedAt)}`,
    `Trạng thái Kho: ${mapRequestOrderStatus(order?.warehouseStatus)} ${displayValue(order?.warehouseCompletedAt || order?.warehouseProcessedAt || order?.warehouseReceivedAt)}`,
    `Trạng thái Leader: ${mapRequestOrderStatus(order?.partnerStatus)} ${displayValue(order?.partnerReviewedAt)}`,
    `Trạng thái triển khai: ${mapDeployStatus(order?.spStatus)}`,
    "",
    "THÔNG TIN DỊCH VỤ, SẢN PHẨM",
    ...formatRequestOrderProducts(order?.details, order?.devices),
    `Tổng tiền thu: ${money(order?.amount)}`,
    `Đã thanh toán: ${money(order?.paymentAmount)}`,
    `Còn lại: ${money(order?.remainAmount)}`,
    "",
    "THÔNG TIN GIAO NHẬN",
    `Nhận tại: ${displayValue(order?.pickUpAt)}`,
    `Tên người nhận: ${displayValue(order?.pickUpContactName)}`,
    `SDT người nhận: ${displayValue(order?.pickUpContactPhone)}`,
    `Địa chỉ nhận: ${displayValue(order?.pickUpAddress)}`,
    `Dự kiến nhận hàng: ${displayValue(order?.deploymentTime)}`,
    `Phương thức thanh toán: ${displayValue(order?.deploymentSaleForm)}`,
    "",
    "THÔNG TIN TRIỂN KHAI",
    `Loại triển khai: ${displayValue(order?.deployTechForm)}`,
    `Bộ phận nhận: ${mapDeployType(order?.deploymentType)}`,
    `Người liên hệ triển khai: ${displayValue(deploymentContact?.name || order?.contactName)}`,
    `S?T liên hệ triển khai: ${displayValue(deploymentContact?.phone || order?.contactPhone)}`,
    `Team triển khai: ${displayValue(order?.picSpTeam)}`,
    `Leader triển khai: ${displayValue(order?.picSpLdr)}`,
    `Phân lịch: ${displayValue(order?.spAssignedAt)}`,
    `Người phân lịch: ${displayValue(order?.spAssignedBy)}`,
    `Người triển khai: ${displayValue(order?.picSp)}`,
    `Dự kiến triển khai: ${displayValue(order?.deploymentTime)}`,
    `Bắt đầu triển khai: ${displayValue(order?.spDeloyStartAt)}`,
    `Triển khai xong: ${displayValue(order?.spCompletedAt)}`,
    `Trạng thái triển khai: ${mapDeployStatus(order?.spStatus)}`,
    `Thương hiệu: ${displayValue(order?.brandName)} (${displayValue(order?.brandId)})`,
    `Cửa hàng: ${displayValue(order?.storeName || hubInfo?.name)} (${displayValue(order?.storeId || hubInfo?.storeId)})`,
    `Tỉnh/Thành phố: ${displayValue(order?.city)}`,
    `Kho xuất thiết bị: ${displayValue(order?.picWarehouseTeamId)}`,
    `Ghi chú triển khai: ${displayValue(order?.contractNote)}`,
    `Nội dung triển khai: Điểm gốc: ${displayValue(order?.point)} | Tổng điểm: ${displayValue(order?.point)}`,
    "",
    "THÔNG TIN HỢP ĐỒNG/PHIẾU THU",
    `Gửi lại quy định mua hàng: ${displayValue(order?.resendEContract === 1 ? "Có" : order?.resendEContract)}`,
    `In hợp đồng giấy: ${displayValue(order?.isEContract === 1 ? "Không" : "Có")}`,
    `Tên công ty: ${displayValue(order?.contactCompany || order?.customerName)}`,
    `Địa chỉ Cty: ${displayValue(order?.companyFullAddess)}`,
    `Mã số thuế: ${displayValue(order?.companyTaxCode)}`,
    `Email thuế: ${displayValue(order?.companyTaxEmail)}`,
    `Đại diện: ${displayValue(order?.contactName)}`,
    `Chức vụ: ${displayValue(order?.contactTitle)}`,
    `SDT người đại diện: ${displayValue(order?.contactPhone)}`,
    `Địa điểm triển khai: ${displayValue(order?.deploymentAddress || order?.storeAddress || hubInfo?.address)}`,
    `Nguồn tạo: ${displayValue(order?.creatorSource === "INTERNAL" ? "Nội bộ" : order?.creatorSource)}`,
    `Role tạo: ${displayValue(order?.creatorType === "SALE" ? "Sale" : order?.creatorType)}`
  ];
  return lines.join("\n");
}

function isRequestOrderScheduleEntry(entry) {
  const text = `${entry?.type || ""}\n${entry?.ticket || ""}\n${entry?.product || ""}\n${entry?.status || ""}\n${entry?.text || ""}`;
  if (entry?.requestOrderId || entry?.raw?.requestOrder || entry?.raw?.requestOrderId || entry?.raw?.roId || entry?.raw?.roCode) return true;
  if (/#\d{5,}/.test(text)) return true;
  return /onsite|triển khai|trien khai|deploy|hỗ trợ tiếp|ho tro tiep|further/i.test(text);
}

function extractRequestOrderIdFromEntry(entry) {
  if (!isRequestOrderScheduleEntry(entry)) return "";
  const values = [
    entry?.requestOrderId,
    entry?.raw?.requestOrder?._id,
    entry?.raw?.requestOrderId,
    entry?.raw?.roId,
    entry?.roId,
    entry?.orderId,
    ...(entry?.links || []),
    entry?.link,
    entry?.text
  ].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/[a-f0-9]{24}/i);
    if (match) return match[0];
  }
  return "";
}

export function parseWorkScheduleDateInput(text, now = new Date()) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw || /^(hôm nay|hom nay|today|nay)$/i.test(raw)) {
    return fromHermesLocalDate(toHermesLocalDate(now));
  }
  if (/^(mai|ngày mai|ngay mai|tomorrow)$/i.test(raw)) {
    return addDays(fromHermesLocalDate(toHermesLocalDate(now)), 1);
  }
  const slash = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?$/);
  if (slash) {
    const day = slash[1].padStart(2, "0");
    const month = slash[2].padStart(2, "0");
    const year = slash[3] || new Intl.DateTimeFormat("en", { timeZone: config.timezoneId, year: "numeric" }).format(now);
    return fromHermesLocalDate(`${year}-${month}-${day}`);
  }
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return fromHermesLocalDate(`${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`);
  }
  return null;
}

export function getRelativeWorkScheduleDate(offsetDays = 0, now = new Date()) {
  return addDays(fromHermesLocalDate(toHermesLocalDate(now)), offsetDays);
}

function scheduleDetailValue(value, fallback = "Không có") {
  const text = displayValue(value);
  return text === "---" ? fallback : text;
}

function getScheduleNoteText(entry = {}) {
  const note = usefulText(entry?.note);
  if (note) return note;
  const content = usefulText(getFieldValue(entry?.raw, ["note", "description", "content", "reason", "remark", "remarks", "memo"]));
  if (content) return content;
  return usefulText(entry?.text) || "Không có ghi chú.";
}

function getWorkScheduleTypeLabel(entry = {}) {
  return getScheduleRequestOrderTypeLabel(entry) || entry?.type || "L\u1ECBch l\u00E0m vi\u1EC7c";
}

function getWorkScheduleTypeWithProductLabel(entry = {}) {
  const type = getWorkScheduleTypeLabel(entry);
  const product = usefulText(entry?.product);
  if (!product || String(type).toLowerCase().includes(product.toLowerCase())) {
    return type;
  }
  return `${type} (${product})`;
}

export function formatWorkScheduleNoteOnlyDetail(entry, result = {}) {
  const target = fromHermesLocalDate(entry?.date || result.targetDate);
  const targetLabel = new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: config.timezoneId
  }).format(target || new Date());
  const ticket = formatScheduleTicketHtml(entry);
  const lines = [
    `\uD83D\uDCDD <b>${htmlValue(getWorkScheduleTypeWithProductLabel(entry))}</b>${ticket ? ` - ${ticket}` : ""}`,
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    `\uD83D\uDCC5 <b>Ng\u00E0y:</b> ${htmlValue(targetLabel)}`,
    `\uD83D\uDD50 <b>Ca:</b> ${htmlValue(getScheduleShiftLabel(entry) || "Ch\u01B0a x\u00E1c \u0111\u1ECBnh")}`,
    entry?.time ? `\u23F0 <b>Th\u1EDDi gian:</b> ${htmlValue(entry.time)}` : "",
    entry?.product ? `\uD83D\uDCE6 <b>D\u1ECBch v\u1EE5:</b> ${htmlValue(entry.product)}` : "",
    entry?.customer ? `\uD83C\uDFEA <b>Kh\u00E1ch/C\u1EEDa h\u00E0ng:</b> ${htmlValue(entry.customer)}` : "",
    entry?.owner ? `\uD83D\uDC64 <b>Ph\u1EE5 tr\u00E1ch:</b> ${htmlValue(entry.owner)}` : "",
    "",
    "\uD83D\uDCCC <b>GHI CH\u00DA</b>",
    `<i>${htmlValue(getScheduleNoteText(entry))}</i>`
  ].filter(Boolean);
  return compactLines(lines);
}


export function formatWorkScheduleDetail(entry, result = {}) {
  return formatWorkScheduleNoteOnlyDetail(entry, result);
}


export function getWorkScheduleTypeIcon(type = "") {
  const text = String(type || "").toLowerCase();
  if (/tr\u1EF1c|truc|busy/.test(text)) return "\uD83D\uDCDE";
  if (/onsite/.test(text)) return "\uD83D\uDCCD";
  if (/tri\u1EC3n khai th\u00EAm|trien khai them/.test(text)) return "\u2795";
  if (/tri\u1EC3n khai|trien khai|deploy/.test(text)) return "\uD83D\uDE80";
  if (/h\u1ED7 tr\u1EE3 ti\u1EBFp|ho tro tiep|further/.test(text)) return "\uD83D\uDD01";
  if (/b\u1EA3o tr\u00EC|bao tri|maint/.test(text)) return "\uD83D\uDEE0\uFE0F";
  if (/ngh\u1EC9|nghi|leave|off/.test(text)) return "\uD83C\uDFD6\uFE0F";
  return "\uD83D\uDCCC";
}


function getScheduleTimeRangeHours(entry = {}) {
  const candidates = [
    [entry?.raw?.startTime, entry?.raw?.endTime],
    [entry?.raw?.requestOrder?.deploymentTime, entry?.raw?.requestOrder?.estDeployEndTime]
  ];
  for (const [start, end] of candidates) {
    const startHour = extractHourFromText(start);
    const endHour = extractHourFromText(end);
    if (startHour !== null || endHour !== null) return { startHour, endHour };
  }

  const source = [entry?.time, entry?.text].filter(Boolean).join("\n");
  const matches = [...String(source).matchAll(/(?:\d{4}-\d{2}-\d{2}[ T])?(\d{1,2}):(\d{2})(?::\d{2})?/g)]
    .map((match) => Number(match[1]))
    .filter((hour) => Number.isFinite(hour));
  if (!matches.length) return { startHour: null, endHour: null };
  return { startHour: matches[0], endHour: matches[1] ?? null };
}

function extractHourFromText(value) {
  const match = String(value || "").match(/(?:\d{4}-\d{2}-\d{2}[ T])?(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : null;
}

export function getScheduleShiftLabel(entry = {}) {
  const explicitShift = String(entry?.shift || "").trim();
  if (/c\u1EA3 ng\u00E0y|ca ng\u00E0y|ca ngay|all day/i.test(explicitShift)) return "c\u1EA3 ng\u00E0y";
  if (/s\u00E1ng|sang/i.test(explicitShift)) return "ca s\u00E1ng";
  if (/chi\u1EC1u|chieu/i.test(explicitShift)) return "ca chi\u1EC1u";
  const { startHour, endHour } = getScheduleTimeRangeHours(entry);
  const requestOrderType = getScheduleRequestOrderTypeLabel(entry);
  if (requestOrderType && isFullDayRequestOrderType(requestOrderType)) return "c\u1EA3 ng\u00E0y";
  if (startHour === null && endHour === null) return requestOrderType ? "c\u1EA3 ng\u00E0y" : "kh\u00E1c";
  if (requestOrderType) return (startHour ?? 0) < 12 ? "ca s\u00E1ng" : "ca chi\u1EC1u";
  if ((startHour ?? 0) < 12 && endHour !== null && endHour < 12) return "ca s\u00E1ng";
  if ((startHour ?? 0) >= 12 && (endHour === null || endHour >= 12)) return "ca chi\u1EC1u";
  if ((startHour ?? 0) < 12 && (endHour === null || endHour >= 12)) return "c\u1EA3 ng\u00E0y";
  return "ca chi\u1EC1u";
}

export function sortWorkScheduleEntries(entries = []) {
  const rank = (entry = {}) => {
    const label = getScheduleShiftLabel(entry).toLowerCase();
    if (/c\u1EA3 ng\u00E0y|all day/.test(label)) return 0;
    if (/s\u00E1ng/.test(label)) return 1;
    if (/chi\u1EC1u/.test(label)) return 2;
    return 3;
  };
  return [...(entries || [])].sort((a, b) => rank(a) - rank(b));
}

function getScheduleTicketLabel(entry = {}) {
  const directTicket = String(entry?.ticket || "").trim();
  if (/^#\d{5,}$/.test(directTicket)) return directTicket;
  const values = [entry?.roCode, entry?.raw?.roCode, entry?.raw?.requestOrder?.roCode, entry?.text]
    .filter(Boolean)
    .map((value) => String(value));
  for (const value of values) {
    const match = value.match(/#?\d{5,}/);
    if (match) return match[0].startsWith("#") ? match[0] : `#${match[0]}`;
  }
  return "";
}

function formatScheduleTicketHtml(entry = {}) {
  const label = getScheduleTicketLabel(entry);
  if (!label) return "";
  const pageUrl = getRequestOrderPageUrlFromScheduleEntry(entry);
  return pageUrl ? htmlLink(label, pageUrl) : htmlValue(label);
}

export function formatWorkScheduleSummaryLine(entry) {
  const main = getWorkScheduleTypeWithProductLabel(entry) || "Ch\u01B0a x\u00E1c \u0111\u1ECBnh";
  const shift = getScheduleShiftLabel(entry);
  const parts = [main, entry?.ticket, shift].filter(Boolean);
  return parts.join(" - ");
}

function formatWorkScheduleSummaryHtml(entry) {
  const main = htmlValue(getWorkScheduleTypeWithProductLabel(entry) || "Ch\u01B0a x\u00E1c \u0111\u1ECBnh");
  const ticket = formatScheduleTicketHtml(entry);
  const customer = entry?.customer ? htmlValue(entry.customer) : "";
  return [ticket, main, customer].filter(Boolean).join(" - ");
}

export function formatWorkScheduleResult(result) {
  const checkedAt = new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: config.timezoneId
  }).format(result.checkedAt || new Date());
  const target = fromHermesLocalDate(result.targetDate);
  const targetLabel = new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: config.timezoneId
  }).format(target || new Date());
  const lines = [`\uD83D\uDCC5 <b>L\u1ECBch ng\u00E0y ${htmlValue(targetLabel)}</b>`, `\u23F1 <i>${htmlValue(checkedAt)}</i>`, ""];
  if (!result.entries?.length) {
    lines.push("\uD83D\uDCEC Kh\u00F4ng c\u00F3 l\u1ECBch h\u1ED7 tr\u1EE3.");
    return lines.join("\n");
  }
  const groups = [
    { icon: "\uD83D\uDDD3\uFE0F", title: "C\u1EA2 NG\u00C0Y", items: [] },
    { icon: "\u2600\uFE0F", title: "CA S\u00C1NG", items: [] },
    { icon: "\uD83C\uDF24\uFE0F", title: "CA CHI\u1EC0U", items: [] },
    { icon: "\uD83D\uDCCC", title: "KH\u00C1C", items: [] }
  ];
  for (const entry of sortWorkScheduleEntries(result.entries).slice(0, 20)) {
    const shift = getScheduleShiftLabel(entry).toLowerCase();
    if (/c\u1EA3 ng\u00E0y|all day/.test(shift)) groups[0].items.push(entry);
    else if (/s\u00E1ng/.test(shift)) groups[1].items.push(entry);
    else if (/chi\u1EC1u/.test(shift)) groups[2].items.push(entry);
    else groups[3].items.push(entry);
  }
  lines.push(`\uD83D\uDCCC <b>${htmlValue(result.entries.length)} l\u1ECBch</b>`);
  lines.push("<i>B\u1EA5m tr\u1EF1c ti\u1EBFp m\u00E3 #phi\u1EBFu \u0111\u1EC3 m\u1EDF nhanh chi ti\u1EBFt phi\u1EBFu.</i>");
  let index = 1;
  for (const group of groups) {
    if (!group.items.length) continue;
    lines.push("");
    lines.push(`${group.icon} <b>${group.title}</b>`);
    for (const entry of group.items) {
      lines.push(`${index}. ${formatWorkScheduleSummaryHtml(entry)}`);
      index += 1;
    }
  }
  if (result.entries.length > 20) {
    lines.push("");
    lines.push(`\u2022 ... v\u00E0 ${htmlValue(result.entries.length - 20)} l\u1ECBch n\u1EEFa`);
  }
  lines.push("");
  lines.push("<i>Ch\u1ECDn n\u00FAt b\u00EAn d\u01B0\u1EDBi \u0111\u1EC3 xem ghi ch\u00FA/chi ti\u1EBFt t\u1EEBng l\u1ECBch.</i>");
  return lines.join("\n");
}


async function fetchRequestOrderFromLoggedInPage(page, requestOrderId, apiResponses = []) {
  const detailPageUrl = buildRequestOrderPageUrl(requestOrderId);
  if (detailPageUrl) {
    await page.goto(detailPageUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(3000);
  const capturedResponse = [...(apiResponses || [])].reverse().find((response) => /\/api\/request-order\/get/i.test(response.url) && response.url.includes(requestOrderId) && response.body);
  if (capturedResponse) {
    const parsed = parseJsonSafe(capturedResponse.body);
    const order = parsed?.data || parsed;
    if (order && typeof order === "object" && order.roCode) {
      return { ok: true, order, checkedAt: new Date(), requestOrderId, raw: parsed };
    }
  }

  const url = buildRequestOrderUrl(requestOrderId);
  const fetched = await page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl, { credentials: "include" });
    return { status: response.status, body: await response.text() };
  }, url).catch((error) => ({ status: 0, body: error.message || "" }));
  if ([401, 403].includes(fetched.status) || /login|unauthori[sz]ed|otp|forbidden/i.test(fetched.body || "")) {
    return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc API yêu cầu đăng nhập lại." };
  }
  const parsed = parseJsonSafe(fetched.body);
  const order = parsed?.data || parsed;
  if (!order || typeof order !== "object" || !order.roCode) {
    return { ok: false, message: `Không lấy được chi tiết PYC từ Hermes. HTTP ${fetched.status}.` };
  }
  return { ok: true, order, checkedAt: new Date(), requestOrderId, raw: parsed };
}

export async function getRequestOrderDetailById({ username, password, requestOrderId, storageState = null }) {
  if (!requestOrderId) {
    return { ok: false, message: "Không có request-order id để lấy chi tiết." };
  }
  if (storageState) {
    const session = await createHermesBrowserContext(storageState);
    try {
      await session.page.goto(new URL("/support-working-schedule", config.hermesLoginUrl).toString(), { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (!(await hasVisibleOtpInput(session.page)) && await isLoggedIn(session.page)) {
        const result = await fetchRequestOrderFromLoggedInPage(session.page, requestOrderId, session.apiResponses);
        return { ...result, reusedSession: true, storageState: result.ok ? await session.context.storageState().catch(() => storageState) : storageState };
      }
      return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc bị yêu cầu đăng nhập lại." };
    } finally {
      await session.browser.close().catch(() => {});
    }
  }

  const login = await loginHermesPage({ username, password, purpose: "work_schedule" });
  if (!login.ok) {
    return { ...login, sessionExpired: login.otpRequired };
  }
  try {
    const result = await fetchRequestOrderFromLoggedInPage(login.page, requestOrderId, login.apiResponses);
    return { ...result, storageState: result.ok ? await login.context.storageState().catch(() => null) : null };
  } finally {
    await login.browser.close().catch(() => {});
  }
}

export async function startDeployRequestOrderById({ username, password, requestOrderId, storageState = null }) {
  if (!requestOrderId) {
    return { ok: false, message: "Không có request-order id để bắt đầu triển khai." };
  }

  const runWithSession = async (session, currentStorageState = null) => {
    const detail = await fetchRequestOrderFromLoggedInPage(session.page, requestOrderId, session.apiResponses || []);
    if (!detail?.ok || !detail?.order?._id) {
      return {
        ok: false,
        message: detail?.message || "Không lấy được chi tiết PYC trước khi bắt đầu triển khai.",
        sessionExpired: Boolean(detail?.sessionExpired),
        storageState: currentStorageState
      };
    }

    const order = detail.order;
    if (order.spStatus === "DELOY_DONE" || order.spStatus === "REVIEWED") {
      return {
        ok: false,
        message: `PYC đã ở trạng thái ${order.spStatus}, không thể bắt đầu triển khai nữa.`,
        order,
        checkedAt: new Date(),
        storageState: currentStorageState
      };
    }

    if (order.spStatus !== "DELOYING") {
      const apiUrl = new URL("/api/request-order/update-status", config.hermesLoginUrl).toString();
      const response = await session.page.evaluate(async ({ url, body }) => {
        const res = await fetch(url, {
          method: "PUT",
          credentials: "include",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
        return {
          status: res.status,
          body: await res.text()
        };
      }, {
        url: apiUrl,
        body: {
          _id: order._id,
          spStatus: "DELOYING"
        }
      }).catch((error) => ({ status: 0, body: error.message || "" }));

      if ([401, 403].includes(response.status) || /login|unauthori[sz]ed|otp|forbidden/i.test(response.body || "")) {
        return {
          ok: false,
          sessionExpired: true,
          message: "Phiên Hermes đã hết hạn hoặc API yêu cầu đăng nhập lại.",
          storageState: currentStorageState
        };
      }

      const parsed = parseJsonSafe(response.body);
      const success = response.status >= 200 && response.status < 300 && !(parsed && parsed.error);
      if (!success) {
        return {
          ok: false,
          message: parsed?.message || parsed?.error_description || parsed?.error || `Hermes update-status lỗi HTTP ${response.status}.`,
          responseStatus: response.status,
          responseBody: response.body,
          order,
          storageState: currentStorageState
        };
      }
    }

    const refreshed = await fetchRequestOrderFromLoggedInPage(session.page, requestOrderId, session.apiResponses || []);
    return {
      ...refreshed,
      ok: Boolean(refreshed?.ok),
      message: refreshed?.ok
        ? (order.spStatus === "DELOYING" ? "PYC đã ở trạng thái đang triển khai." : "Đã bắt đầu triển khai PYC trên Hermes.")
        : (refreshed?.message || "Đã gọi API bắt đầu triển khai nhưng không đọc lại được chi tiết PYC."),
      storageState: await session.context.storageState().catch(() => currentStorageState)
    };
  };

  if (storageState) {
    const session = await createHermesBrowserContext(storageState);
    try {
      await session.page.goto(new URL("/support-working-schedule", config.hermesLoginUrl).toString(), { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (!(await hasVisibleOtpInput(session.page)) && await isLoggedIn(session.page)) {
        return await runWithSession(session, storageState);
      }
      return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc bị yêu cầu đăng nhập lại." };
    } finally {
      await session.browser.close().catch(() => {});
    }
  }

  const login = await loginHermesPage({ username, password });
  if (!login.ok) {
    return { ...login, sessionExpired: login.otpRequired };
  }
  try {
    return await runWithSession(login, null);
  } finally {
    await login.browser.close().catch(() => {});
  }
}

export function getRequestOrderIdFromScheduleEntry(entry) {
  return extractRequestOrderIdFromEntry(entry);
}

export function getRequestOrderPageUrlFromScheduleEntry(entry) {
  const requestOrderId = extractRequestOrderIdFromEntry(entry);
  return requestOrderId ? buildRequestOrderPageUrl(requestOrderId) : "";
}

function parseGvizResponse(text) {
  const match = String(text || "").match(/google\.visualization\.Query\.setResponse\((.*)\);?\s*$/s);
  if (!match) throw new Error("Google Sheet tr? d? li?u kh?ng ??ng ??nh d?ng gviz.");
  return JSON.parse(match[1]);
}

function kpiCell(row, index) { return row?.c?.[index] || null; }
function kpiText(row, index) { const cell = kpiCell(row, index); return String(cell?.v ?? cell?.f ?? "").trim(); }
function kpiNumber(row, index) {
  const cell = kpiCell(row, index);
  const raw = cell?.v ?? cell?.f ?? 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const normalized = String(raw || "").replace(/%/g, "").replace(/,/g, "").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return String(raw).includes("%") ? parsed / 100 : parsed;
}

function normalizeKpiRow(row) {
  const support = kpiText(row, 0);
  if (!support || !/@/.test(support)) return null;
  return {
    support, level: kpiNumber(row, 1), deployPos: kpiNumber(row, 2), deployFabi: kpiNumber(row, 3), deployCrm: kpiNumber(row, 4),
    deployBk: kpiNumber(row, 5), deployCall: kpiNumber(row, 6), deployWo: kpiNumber(row, 7), deployO2o: kpiNumber(row, 8),
    deployHub: kpiNumber(row, 9), deployHddt: kpiNumber(row, 10), deployFoodHub: kpiNumber(row, 11), deployExtra: kpiNumber(row, 12),
    onsiteTx: kpiNumber(row, 13), onsiteNt: kpiNumber(row, 14), maintenance: kpiNumber(row, 15), supportCount: kpiNumber(row, 16),
    rateAiAvg: kpiNumber(row, 17), kpiBonus: kpiNumber(row, 18), kpiOt: kpiNumber(row, 19), kpiDeployTarget: kpiNumber(row, 20),
    kpiHotlineTarget: kpiNumber(row, 21), kpiDeployAchieved: kpiNumber(row, 22), kpiHotlineAchieved: kpiNumber(row, 23),
    deployPct: kpiNumber(row, 24), hotlinePct: kpiNumber(row, 25), missFactor: kpiNumber(row, 26), rateFactor: kpiNumber(row, 27),
    kpiSum: kpiNumber(row, 28), pointDeploy: kpiNumber(row, 29), pointSupport: kpiNumber(row, 30), pointActual: kpiNumber(row, 31),
    pointBonus: kpiNumber(row, 32), pointSalary: kpiNumber(row, 33)
  };
}

async function fetchKpiSheet(month) {
  const url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(KPI_SHEET_ID) + "/gviz/tq?tqx=out:json&sheet=" + encodeURIComponent(month);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheet KPI l?i HTTP ${response.status}`);
  const parsed = parseGvizResponse(text);
  if (parsed.status !== "ok") throw new Error(parsed.errors?.[0]?.detailed_message || `Kh?ng t?i ???c sheet ${month}`);
  return parsed.table || { rows: [], cols: [] };
}

export async function getKpiSummary() {
  try {
    const months = Array.from({ length: 12 }, (_, index) => `2026_${String(index + 1).padStart(2, "0")}`);
    const monthly = [];
    for (const month of months) {
      const table = await fetchKpiSheet(month);
      const records = (table.rows || []).map(normalizeKpiRow).filter(Boolean);
      if (!records.length) continue;
      const teamRows = records.slice(0, 13);
      const teamTotalPointSalary = teamRows.reduce((sum, row) => sum + Number(row.pointSalary || 0), 0);
      monthly.push({ month, records, teamTotalPointSalary });
    }
    return { ok: true, months: monthly.map((item) => item.month), monthly, yearlyRanking: [] };
  } catch (error) {
    return { ok: false, message: `Kh?ng t?i ???c KPI Google Sheet: ${error.message}` };
  }
}

export async function getWorkScheduleByDay({ username, password, date = new Date(), storageState = null, fetchFullWeek = false }) {
  if (!config.hermesLoginUrl) {
    return { ok: false, message: "Chua cau hinh HERMES_LOGIN_URL." };
  }

  if (storageState) {
    const session = await createHermesBrowserContext(storageState);
    try {
      const result = await readScheduleFromLoggedInPage(session.page, session.apiResponses, date, username, { fetchFullWeek });
      if (result.ok) {
        return {
          ...result,
          reusedSession: true,
          storageState: await session.context.storageState().catch(() => storageState)
        };
      }
      if (!result.sessionExpired) {
        return result;
      }
    } catch (error) {
      // Stored cookies can be stale/corrupt. Fall through to full login below.
    } finally {
      await session.browser.close().catch(() => {});
    }
  }

  const login = await loginHermesPage({ username, password });
  if (!login.ok) {
    return { ...login, sessionExpired: Boolean(storageState) || login.otpRequired };
  }

  try {
    const result = await readScheduleFromLoggedInPage(login.page, login.apiResponses, date, username, { fetchFullWeek });
    return {
      ...result,
      storageState: result.ok ? await login.context.storageState().catch(() => null) : null
    };
  } catch (error) {
    return { ok: false, message: error.message || "Khong lay duoc lich lam viec Hermes." };
  } finally {
    await login.browser.close().catch(() => {});
  }
}

export async function submitHermesOtpAndGetWorkSchedule(otp, date = new Date()) {
  if (!activeHermesSession) {
    return { ok: false, expired: true, message: "Khong co phien Hermes nao dang cho OTP hoac phien da het han." };
  }

  const session = activeHermesSession;
  const { page } = session;
  let currentStorageState = null;
  let shouldCloseSession = true;
  try {
    await fillOtp(page, otp);
    await clickOtpSubmit(page);
    
    let errorText = "";
    let isLogged = false;
    let hasOtpInput = true;
    
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      errorText = await readFirstText(page, ERROR_SELECTORS) || getApiErrorText(session.apiResponses || [], /\/api\/user\/(get-otp|verify|login)/i);
      if (errorText) break;
      
      hasOtpInput = await hasVisibleOtpInput(page);
      isLogged = await isLoggedIn(page);
      
      if (isLogged && !hasOtpInput) break;
    }

    if (errorText) {
      shouldCloseSession = false;
      return { ok: false, message: `OTP Hermes that bai: ${errorText}` };
    }

    if (await hasVisibleOtpInput(page)) {
      shouldCloseSession = false;
      return { ok: false, otpRequired: true, message: "Hermes van dang cho OTP. Ma vua nhap co the chua dung hoac chua du." };
    }

    if (!(await isLoggedIn(page))) {
      return { ok: false, message: "Da gui OTP nhung Hermes chua vao duoc trang sau dang nhap." };
    }

    currentStorageState = await session.context.storageState().catch(() => null);

    const result = await readScheduleFromLoggedInPage(page, session.apiResponses || [], date, session.username);
    return {
      ...result,
      storageState: await session.context.storageState().catch(() => currentStorageState)
    };
  } catch (error) {
    return { ok: false, message: error.message || "Khong xac nhan duoc OTP Hermes.", storageState: currentStorageState };
  } finally {
    if (shouldCloseSession) {
      await closeActiveHermesSession();
    }
  }
}

async function submitOtpForActiveHermesSession(otp) {
  if (!activeHermesSession) {
    return { ok: false, expired: true, message: "Khong co phien Hermes nao dang cho OTP hoac phien da het han." };
  }

  const session = activeHermesSession;
  const { page } = session;
  let storageState = null;
  try {
    await fillOtp(page, otp);
    await clickOtpSubmit(page);
    
    let errorText = "";
    let isLogged = false;
    let hasOtpInput = true;
    
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      errorText = await readFirstText(page, ERROR_SELECTORS) || getApiErrorText(session.apiResponses || [], /\/api\/user\/(get-otp|verify|login)/i);
      if (errorText) break;
      
      hasOtpInput = await hasVisibleOtpInput(page);
      isLogged = await isLoggedIn(page);
      
      if (isLogged && !hasOtpInput) break;
    }

    if (errorText) {
      return { ok: false, message: `OTP Hermes that bai: ${errorText}` };
    }

    if (await hasVisibleOtpInput(page)) {
      return { ok: false, otpRequired: true, message: "Hermes van dang cho OTP. Ma vua nhap co the chua dung hoac chua du." };
    }

    if (!(await isLoggedIn(page))) {
      return { ok: false, message: "Da gui OTP nhung Hermes chua vao duoc trang sau dang nhap." };
    }

    storageState = await session.context.storageState().catch(() => null);
    return { ok: true, session, storageState };
  } catch (error) {
    return { ok: false, message: error.message || "Khong xac nhan duoc OTP Hermes.", storageState };
  }
}

export async function cancelHermesOtpSession() {
  await closeActiveHermesSession();
}

async function readRoomRevenueFromPage(page, context, month = null) {
  const revenueMonthLabel = /^\d{4}_\d{2}$/.test(String(month || ""))
    ? `${Number(String(month).slice(5, 7))}/${String(month).slice(0, 4)}`
    : "";
  const url = "https://hermes.ipos.vn/report-commission-sale";

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});

  const isLoginPage = page.url().includes("/login") || await page.locator("input[type='password']").isVisible().catch(() => false);
  if (isLoginPage || await hasVisibleOtpInput(page)) {
    return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc cần đăng nhập lại để lấy KPI." };
  }

  await page.waitForTimeout(3000);

  const supportResponsePromise = page.waitForResponse(
    response => /get-monthly-sale-commission/i.test(response.url()) && /type=SUPPORT/i.test(response.url()),
    { timeout: 15000 }
  ).catch(() => null);

  await page.getByText("Lọc").first().click().catch(() => {});
  await page.waitForTimeout(500);
  const groupSelect = page.locator("mat-select").first();
  if (await groupSelect.isVisible().catch(() => false)) {
    await groupSelect.click().catch(() => {});
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: /^Support$/ }).click().catch(async () => {
      await page.locator("mat-option").filter({ hasText: "Support" }).first().click().catch(() => {});
    });
    await page.waitForTimeout(500);
    if (revenueMonthLabel) {
      const [targetMonthText, targetYearText] = revenueMonthLabel.split("/");
      const targetMonth = Number(targetMonthText);
      const targetYear = Number(targetYearText);
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "July", "Aug", "Sep", "Oct", "Nov", "Dec"];
      await page.locator(".mat-dialog-container input").first().click().catch(() => {});
      await page.waitForTimeout(300);
      for (let i = 0; i < 8; i++) {
        const calendarText = await page.locator("body").innerText().catch(() => "");
        const yearMatch = calendarText.match(/keyboard_arrow_left\s*(\d{4})\s*keyboard_arrow_right/);
        const currentYear = yearMatch ? Number(yearMatch[1]) : targetYear;
        if (currentYear === targetYear) break;
        const buttonSelector = currentYear > targetYear ? ".mat-calendar-previous-button" : ".mat-calendar-next-button";
        await page.locator(buttonSelector).click().catch(() => {});
        await page.waitForTimeout(250);
      }
      await page.evaluate((monthName) => {
        const candidates = [...document.querySelectorAll(".mat-dialog-container *")]
          .filter(el => (el.innerText || el.textContent || "").trim() === monthName);
        const target = candidates.find(el => el.offsetParent !== null) || candidates[0];
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }, monthNames[targetMonth - 1]).catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.getByText("Tìm kiếm").last().click().catch(() => {});
    await supportResponsePromise;
    await page.waitForTimeout(2500);
  }

  const result = await page.evaluate(() => {
    const targetEmail = "support.hn@ipos.vn";
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const moneyValue = (value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text && text !== "-" ? text : "";
    };
    const headers = Array.from(document.querySelectorAll("th")).map(th => th.innerText.trim());
    const rows = Array.from(document.querySelectorAll("tr"))
      .map(row => Array.from(row.querySelectorAll("td")).map(td => td.innerText.trim()))
      .filter(cells => cells.length);

    if (!headers.length || !rows.length) {
      return { ok: false, message: "Không tìm thấy bảng doanh thu trên Hermes." };
    }

    const findHeader = (...patterns) => headers.findIndex((header) => {
      const text = normalize(header);
      return patterns.some((pattern) => text.includes(pattern));
    });

    const revenueIndexes = [
      findHeader("hh tiêu chuẩn"),
      findHeader("hh theo kpi"),
      findHeader("thực nhận"),
      findHeader("dt tính hh")
    ].filter(index => index >= 0);

    const supportRow = rows.find(cells => normalize(cells.join(" ")).includes(targetEmail));
    if (supportRow) {
      for (const index of revenueIndexes) {
        const value = moneyValue(supportRow[index]);
        if (value) return { ok: true, value, source: targetEmail };
      }
    }

    const totalRow = rows.find(cells => normalize(cells[0]).includes("tổng cộng"));
    if (totalRow) {
      for (const index of revenueIndexes) {
        const value = moneyValue(totalRow[index]);
        if (value) return { ok: true, value, source: "TỔNG CỘNG" };
      }
    }

    return { ok: false, message: "Không tìm thấy doanh thu nhóm Support trên Hermes." };
  });

  return { ...result, storageState: await context.storageState().catch(() => null) };
}

export async function submitHermesOtpAndGetRoomRevenue(otp, month = null) {
  const verified = await submitOtpForActiveHermesSession(otp);
  if (!verified.ok) {
    if (!verified.otpRequired) await closeActiveHermesSession();
    return verified;
  }
  try {
    const result = await readRoomRevenueFromPage(verified.session.page, verified.session.context, month);
    return { ...result, storageState: result.storageState || verified.storageState };
  } catch (error) {
    return { ok: false, message: `Lỗi lấy doanh thu sau OTP: ${error.message}`, storageState: verified.storageState };
  } finally {
    await closeActiveHermesSession();
  }
}

export async function getHermesRoomRevenue({ username, password, storageState = null, month = null }) {
  let session = null;
  let login = null;
  try {
    if (storageState) {
      session = await createHermesBrowserContext(storageState);
      const result = await readRoomRevenueFromPage(session.page, session.context, month);
      if (result.ok || !result.sessionExpired) return result;
      await session.browser.close().catch(() => {});
      session = null;
    }

    login = await loginHermesPage({ username, password, purpose: "kpi_room_revenue" });
    if (!login.ok) {
      return {
        ...login,
        sessionExpired: Boolean(storageState) || login.otpRequired,
        message: login.message || "Kh?ng th? ??ng nh?p Hermes ?? l?y doanh thu."
      };
    }

    return await readRoomRevenueFromPage(login.page, login.context, month);
  } catch (error) {
    return { ok: false, message: `L?i l?y doanh thu: ${error.message}` };
  } finally {
    if (session) await session.browser.close().catch(() => {});
    if (login?.browser && (!activeHermesSession || activeHermesSession.browser !== login.browser)) {
      await login.browser.close().catch(() => {});
    }
  }
}

export async function validateStoredSession(storageState) {
  const session = await createHermesBrowserContext(storageState);
  try {
    const homeUrl = config.hermesLoginUrl.replace(/\/login$/i, "/");
    await session.page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
    const loggedIn = await isLoggedIn(session.page);
    return { ok: loggedIn };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    await session.browser.close().catch(() => {});
  }
}



function normalizeNotificationItem(item = {}, fallbackIndex = 0) {
  const rawText = [
    item.title,
    item.name,
    item.message,
    item.content,
    item.description,
    item.body,
    item.text,
    item.statusName,
    item.status,
    item.createdAt,
    item.updatedAt
  ].filter(Boolean).join(" | ");
  const hrefStr = String(item.path || item.link || item.url || "");
  const requestOrderId = item.requestOrderId || item.requestOrder?._id || item.roId || item.orderId || item.idRequestOrder || hrefStr.match(/[a-f0-9]{24}/i)?.[0] || String(rawText).match(/[a-f0-9]{24}/i)?.[0] || "";
  const ticketCode = item.roCode || item.code || item.requestCode || item.requestOrder?.code || item.ticketCode || String(rawText).match(/#?\d{4,}|PYC[-_\s]?\d+/i)?.[0] || "";
  const status = item.statusName || item.statusText || item.status || item.type || item.requestOrder?.statusName || item.requestOrder?.status || "Có cập nhật";
  const title = item.title || item.name || "Thông báo Hermes";
  const message = item.message || item.content || item.description || item.body || item.text || rawText || title;
  const time = item.createdTime || item.createdAt || item.updatedTime || item.updatedAt || item.time || item.notifyAt || "";
  const link = item.path || item.link || item.url || buildRequestOrderPageUrl(requestOrderId) || (requestOrderId ? buildRequestOrderPageUrl(requestOrderId) : "");
  const notificationId = item._id || item.id || item.notificationId || "";
  const key = notificationId || [requestOrderId || ticketCode || fallbackIndex, status, time || message].filter(Boolean).join("|");
  return {
    key,
    notificationId,
    requestOrderId,
    ticketCode,
    status,
    title,
    message,
    time,
    link,
    raw: item
  };
}

function flattenNotificationItems(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenNotificationItems(item, output);
    return output;
  }
  if (typeof value !== "object") return output;
  const keys = Object.keys(value);
  const hasNotificationShape = keys.some((key) => /title|message|content|description|status|requestOrder|notify|notification/i.test(key));
  if (hasNotificationShape) output.push(value);
  for (const key of keys) {
    if (/data|items|rows|list|notifications|result/i.test(key)) flattenNotificationItems(value[key], output);
  }
  return output;
}

async function readNotificationsFromLoggedInPage(page, apiResponses) {
  const notificationUrl = new URL("/notification", config.hermesLoginUrl).toString();
  await page.goto(notificationUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
  await page.waitForTimeout(4000);

  if (await hasVisibleOtpInput(page) || !(await isLoggedIn(page))) {
    return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc bị yêu cầu đăng nhập lại." };
  }

  const apiItems = [];
  const directNotify = await page.evaluate(async () => {
    const response = await fetch("/api/notify/get?page=1&limit=20", { credentials: "include" });
    return { status: response.status, body: await response.text() };
  }).catch(() => null);
  if (directNotify?.body) {
    apiResponses.push({ url: "/api/notify/get?page=1&limit=20", method: "GET", status: directNotify.status, requestBody: "", body: directNotify.body });
  }
  for (const response of apiResponses) {
    if (!/notification|notify|request-order/i.test(response.url || "")) continue;
    try {
      const parsed = JSON.parse(response.body || "null");
      flattenNotificationItems(parsed, apiItems);
    } catch {}
  }

  const domItems = await page.evaluate(() => {
    const selectors = [
      ".notification-item",
      ".notify-item",
      "[class*='notification'] li",
      "[class*='notify'] li",
      "tbody tr",
      ".k-listview-item",
      ".ant-list-item"
    ];
    const seen = new Set();
    const rows = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const href = element.querySelector("a[href]")?.href || "";
        rows.push({ title: "Thông báo Hermes", message: text, link: href });
      }
    }
    if (!rows.length) {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      if (bodyText) rows.push({ title: "Thông báo Hermes", message: bodyText.slice(0, 800) });
    }
    return rows.slice(0, 20);
  }).catch(() => []);

  const items = [...apiItems, ...domItems]
    .map((item, index) => normalizeNotificationItem(item, index))
    .filter((item) => /trạng thái|status|phiếu|yêu cầu|request|PYC|#|duyệt|hoàn thành|hủy|đóng|mở|cập nhật/i.test(`${item.title} ${item.message} ${item.status}`));

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    unique.push(item);
  }

  unique.sort((a, b) => Number(Boolean(b.requestOrderId || b.link)) - Number(Boolean(a.requestOrderId || a.link)));
  return { ok: true, checkedAt: new Date(), notifications: unique.slice(0, 20) };
}

export async function getHermesNotifications({ username, password, storageState = null }) {
  if (storageState) {
    const session = await createHermesBrowserContext(storageState);
    try {
      await session.page.goto(new URL("/support-working-schedule", config.hermesLoginUrl).toString(), { waitUntil: "domcontentloaded", timeout: config.timeoutMs }).catch(() => {});
      await session.page.waitForTimeout(1500);
      if (!(await hasVisibleOtpInput(session.page)) && await isLoggedIn(session.page)) {
        const result = await readNotificationsFromLoggedInPage(session.page, session.apiResponses);
        return { ...result, reusedSession: true, storageState: result.ok ? await session.context.storageState().catch(() => storageState) : storageState };
      }
      return { ok: false, sessionExpired: true, message: "Phiên Hermes đã hết hạn hoặc bị yêu cầu đăng nhập lại." };
    } finally {
      await session.browser.close().catch(() => {});
    }
  }

  const login = await loginHermesPage({ username, password });
  if (!login.ok) return { ...login, sessionExpired: login.otpRequired };
  try {
    const result = await readNotificationsFromLoggedInPage(login.page, login.apiResponses);
    return { ...result, storageState: result.ok ? await login.context.storageState().catch(() => null) : null };
  } finally {
    await login.browser.close().catch(() => {});
  }
}




