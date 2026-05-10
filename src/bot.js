import net from "node:net";
import { Markup, Telegraf } from "telegraf";

import { getAllowedTelegramIds, isAuthorizedTelegramId } from "./access.js";
import { assertBotConfig, config } from "./config.js";
import {
  cancelHermesOtpSession,
  formatRequestOrderDetailHtml,
  formatWorkScheduleNoteOnlyDetail,
  formatWorkScheduleResult,
  formatWorkScheduleSummaryLine,
  getRelativeWorkScheduleDate,
  getRequestOrderDetailById,
  getRequestOrderIdFromScheduleEntry,
  getRequestOrderPageUrlFromScheduleEntry,
  getScheduleShiftLabel,
  getWeekRange,
  getWorkScheduleByDay,
  getKpiSummary,
  getHermesRoomRevenue,
  getHermesNotifications,
  parseWorkScheduleDateInput,
  sortWorkScheduleEntries,
  submitHermesOtp,
  submitHermesOtpAndGetRoomRevenue,
  submitHermesOtpAndGetWorkSchedule,
  toHermesLocalDate,
  validateHermesLogin,
  validateStoredSession
} from "./hermesClient.js";
import {
  clearHermesSession,
  deleteHermesAccount,
  getHermesAccount,
  getAllHermesAccounts,
  saveHermesAccount,
  saveHermesSession,
  updateHermesNotificationState
} from "./store.js";
import { formatUpdateResult, updateFromGitHub } from "./updater.js";

assertBotConfig();

const bot = new Telegraf(config.telegramToken);
const pendingActions = new Map();
const workScheduleCache = new Map();
const lastBotMessageByChat = new Map();
const startedAt = new Date();
let instanceLockServer = null;
let queue = Promise.resolve();
const sentDutyReminderKeys = new Set();
const sentDashboardReminderKeys = new Set();

const telegramCommands = [
  { command: "start", description: "Má»Ÿ menu Hermes" },
  { command: "today", description: "Xem tá»•ng há»£p hÃ´m nay" },
  { command: "lich", description: "Xem lá»‹ch lÃ m viá»‡c" },
  { command: "truc", description: "Xem lá»‹ch trá»±c tá»« Google Sheet" },
  { command: "kpi", description: "Xem KPI thÃ¡ng vÃ  nÄƒm" },
  { command: "sethermes", description: "LÆ°u tÃ i khoáº£n Hermes" },
  { command: "deletehermes", description: "XÃ³a tÃ i khoáº£n Hermes" },
  { command: "clearhermes", description: "XÃ³a session Hermes Ä‘á»ƒ test OTP" },
  { command: "id", description: "Xem Telegram ID" },
  { command: "update", description: "Cap nhat bot tu GitHub" },
  { command: "testauto", description: "Test tÃ­nh nÄƒng thÃ´ng bÃ¡o tá»± Ä‘á»™ng" },
  { command: "cancel", description: "Há»§y thao tÃ¡c Ä‘ang Ä‘á»£i" }
];

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

function getTelegramId(ctx) {
  return String(ctx.from?.id || "");
}

function isStartLikeUpdate(ctx) {
  const text = ctx.message?.text?.trim() || "";
  return text === "/start" || text.startsWith("/start@") || text === "/id" || text.startsWith("/id@");
}

function buildUnauthorizedText(ctx) {
  const telegramId = getTelegramId(ctx);
  return [
    "Telegram ID cá»§a Sáº¿p:",
    telegramId || "(khÃ´ng xÃ¡c Ä‘á»‹nh)",
    "",
    "Bot lá»‹ch Hermes Ä‘ang khoÃ¡.",
    "Gá»­i ID nÃ y cho admin Ä‘á»ƒ Ä‘Æ°á»£c thÃªm vÃ o danh sÃ¡ch cho phÃ©p."
  ].join("\n");
}

async function isAllowedUser(ctx) {
  if (isStartLikeUpdate(ctx)) {
    return true;
  }
  return isAuthorizedTelegramId(getTelegramId(ctx));
}

function keyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("ðŸ“Œ Tá»•ng há»£p", "action:today_dashboard"), Markup.button.callback("ðŸŽ¯ KPI", "action:hermes_kpi")],
    [Markup.button.callback("ðŸ“… Lá»‹ch lÃ m viá»‡c", "action:hermes_work_menu"), Markup.button.callback("ðŸ“‹ Lá»‹ch trá»±c", "action:duty_menu")],
    [Markup.button.callback("ðŸ‘¤ TÃ i khoáº£n Hermes", "action:hermes_account_menu")]
  ]);
}




function extractOtp(text) {
  const value = String(text || "").trim();
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const directMatch = normalized.match(/ma\s*otp\s*[:?-]?\s*(\d{4,6})/i);
  if (directMatch) return directMatch[1];

  const plainOtp = value.match(/^\s*(\d{4,6})\s*$/);
  if (plainOtp) return plainOtp[1];

  return value;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactButtonLabel(text, maxLength = 42) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}â€¦` : value;
}

function formatMenuDateLabel(date = new Date()) {
  const target = parseWorkScheduleDateInput(date) || new Date(date);
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: config.timezoneId
  }).format(target);
}

function firstValidScheduleLink(entry) {
  const requestOrderPageUrl = getRequestOrderPageUrlFromScheduleEntry(entry);
  if (requestOrderPageUrl) return requestOrderPageUrl;
  const requestOrderId = getRequestOrderIdFromScheduleEntry(entry);
  if (!requestOrderId) return "";
  return [entry?.link, ...(entry?.links || [])]
    .filter(Boolean)
    .find((link) => /^https?:\/\//i.test(String(link))) || "";
}

function workScheduleKeyboard(result, cacheKey) {
  const rows = [];
  const entries = result?.entries || [];

  for (let index = 0; index < Math.min(entries.length, 10); index += 2) {
    const row = [];
    row.push(Markup.button.callback(`\uD83D\uDCC4 Xem l\u1ECBch ${index + 1}`, `action:hermes_work_detail:${cacheKey}:${index}`));
    if (index + 1 < Math.min(entries.length, 10)) {
      row.push(Markup.button.callback(`\uD83D\uDCC4 Xem l\u1ECBch ${index + 2}`, `action:hermes_work_detail:${cacheKey}:${index + 1}`));
    }
    rows.push(row);
  }

  const date = result.targetDate;
  rows.push([
    Markup.button.callback("\u2B05\uFE0F Ng\u00E0y tr\u01B0\u1EDBc", `action:hermes_work_date:${date}:-1`),
    Markup.button.callback("\uD83D\uDCC5 H\u00F4m nay", "action:hermes_work_offset:0"),
    Markup.button.callback("Ng\u00E0y sau \u27A1\uFE0F", `action:hermes_work_date:${date}:1`)
  ]);
  rows.push([
    Markup.button.callback("\uD83D\uDDD3\uFE0F Xem c\u1EA3 tu\u1EA7n", `action:hermes_work_week:${date}`),
    Markup.button.callback("\uD83D\uDCC6 Ch\u1ECDn ng\u00E0y", "action:hermes_work_other"),
    Markup.button.callback("\uD83C\uDFE0 Trang ch\u1EE7", "action:menu")
  ]);
  return Markup.inlineKeyboard(rows);
}

function workScheduleDetailKeyboard(result, cacheKey, entry = null) {
  const date = result?.targetDate || toHermesLocalDate(new Date());
  return Markup.inlineKeyboard([
    [Markup.button.callback("\uD83D\uDCCB Quay l\u1EA1i danh s\u00E1ch", `action:hermes_work_list:${cacheKey}`)],
    [
      Markup.button.callback("\u2B05\uFE0F Ng\u00E0y tr\u01B0\u1EDBc", `action:hermes_work_date:${date}:-1`),
      Markup.button.callback("\uD83D\uDCC5 H\u00F4m nay", "action:hermes_work_offset:0"),
      Markup.button.callback("Ng\u00E0y sau \u27A1\uFE0F", `action:hermes_work_date:${date}:1`)
    ],
    [
      Markup.button.callback("\uD83D\uDDD3\uFE0F Xem c\u1EA3 tu\u1EA7n", `action:hermes_work_week:${date}`),
      Markup.button.callback("\uD83D\uDCC6 Ch\u1ECDn ng\u00E0y", "action:hermes_work_other"),
      Markup.button.callback("\uD83C\uDFE0 Trang ch\u1EE7", "action:menu")
    ]
  ]);
}

function dutyKeyboard(date = new Date()) {
  const targetDate = parseWorkScheduleDateInput(date) || new Date(date);
  const targetDateText = toHermesLocalDate(targetDate);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("\u2B05\uFE0F Ng\u00E0y tr\u01B0\u1EDBc", `action:duty_date:${targetDateText}:-1`),
      Markup.button.callback("\uD83D\uDCC5 H\u00F4m nay", "action:duty_today"),
      Markup.button.callback("Ng\u00E0y sau \u27A1\uFE0F", `action:duty_date:${targetDateText}:1`)
    ],
    [
      Markup.button.callback("\uD83D\uDDD3\uFE0F Xem c\u1EA3 tu\u1EA7n", `action:duty_week:${targetDateText}`),
      Markup.button.callback("\uD83D\uDCC6 Ch\u1ECDn ng\u00E0y", "action:duty_other"),
      Markup.button.callback("\uD83C\uDFE0 Trang ch\u1EE7", "action:menu")
    ]
  ]);
}

function dashboardKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("\uD83D\uDDD3\uFE0F L\u1ECBch l\u00E0m vi\u1EC7c", "action:hermes_work_menu"),
      Markup.button.callback("\uD83D\uDCCB L\u1ECBch tr\u1EF1c", "action:duty_menu"),
      Markup.button.callback("\uD83C\uDFAF KPI", "action:hermes_kpi"),
    ],
    [
      Markup.button.callback("\uD83C\uDFE0 V\u1EC1 trang ch\u1EE7", "action:menu")
    ]
  ]);
}

function workMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("\u2B05\uFE0F H\u00F4m qua", "action:hermes_work_offset:-1"),
      Markup.button.callback("\uD83D\uDCC5 H\u00F4m nay", "action:hermes_work_offset:0"),
      Markup.button.callback("Ng\u00E0y mai \u27A1\uFE0F", "action:hermes_work_offset:1")
    ],
    [
      Markup.button.callback("\uD83D\uDDD3\uFE0F Xem c\u1EA3 tu\u1EA7n", "action:hermes_work_week"),
      Markup.button.callback("\uD83D\uDCC6 Ch\u1ECDn ng\u00E0y", "action:hermes_work_other"),
      Markup.button.callback("\uD83C\uDFE0 Trang ch\u1EE7", "action:menu")
    ]
  ]);
}

function dutyMenuKeyboard() {
  const today = toHermesLocalDate(new Date());

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("\u2B05\uFE0F H\u00F4m qua", `action:duty_date:${today}:-1`),
      Markup.button.callback("\uD83D\uDCC5 H\u00F4m nay", "action:duty_today"),
      Markup.button.callback("Ng\u00E0y mai \u27A1\uFE0F", `action:duty_date:${today}:1`)
    ],
    [
      Markup.button.callback("\uD83D\uDDD3\uFE0F Xem c\u1EA3 tu\u1EA7n", `action:duty_week:${today}`),
      Markup.button.callback("\uD83D\uDCC6 Ch\u1ECDn ng\u00E0y", "action:duty_other"),
      Markup.button.callback("\uD83C\uDFE0 Trang ch\u1EE7", "action:menu")
    ]
  ]);
}

function accountMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("ðŸ‘¤ Xem thÃ´ng tin", "action:hermes_current_user"),
      Markup.button.callback("ðŸ” Cáº­p nháº­t", "action:hermes_account"),
      Markup.button.callback("ðŸ—‘ï¸ XoÃ¡ tÃ i khoáº£n", "action:delete_hermes")
    ],
    [Markup.button.callback("ðŸ  Vá» menu chÃ­nh", "action:menu")]
  ]);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: config.timezoneId
  }).format(date);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ");
}

function formatHermesAccountStatus(account) {
  if (!account?.hermesUsername) {
    return [
      "ChÆ°a lÆ°u tÃ i khoáº£n Hermes.",
      "Gá»­i /sethermes Ä‘á»ƒ thÃªm tÃ i khoáº£n."
    ].join("\n");
  }
  return [
    `User Hermes Ä‘ang lÆ°u: ${account.hermesUsername}`,
    `Telegram: ${account.telegramName || "(khÃ´ng cÃ³ tÃªn)"}${account.telegramUsername ? ` (@${account.telegramUsername})` : ""}`,
    `Chat ID: ${account.chatId || "(khÃ´ng cÃ³)"}`,
    `Cáº­p nháº­t: ${account.updatedAt ? formatDateTime(new Date(account.updatedAt)) : "khÃ´ng rÃµ"}`,
    `Session Hermes: ${account.hermesSession ? "Ä‘ang cÃ³" : "chÆ°a cÃ³"}`
  ].join("\n");
}

async function deleteLastBotMessage(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // XoÃ¡ tin nháº¯n vá»«a báº¥m nÃºt (náº¿u cÃ³) Ä‘á»ƒ trÃ¡nh dá»‘i máº¯t
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id);
    } catch {}
  }

  const lastMessageId = lastBotMessageByChat.get(chatId);
  if (!lastMessageId) return;

  // Náº¿u tin nháº¯n cuá»‘i cÃ¹ng khÃ¡c vá»›i tin nháº¯n vá»«a báº¥m thÃ¬ xoÃ¡ luÃ´n cáº£ nÃ³
  if (lastMessageId !== ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.telegram.deleteMessage(chatId, lastMessageId);
    } catch {}
  }
  lastBotMessageByChat.delete(chatId);
}

async function replyFresh(ctx, text, extra = undefined) {
  await deleteLastBotMessage(ctx);
  const sent = await ctx.reply(text, extra);
  if (sent?.message_id && ctx.chat?.id) {
    lastBotMessageByChat.set(ctx.chat.id, sent.message_id);
  }
  return sent;
}

async function sendTempMessage(ctx, text, extra = undefined) {
  const sent = await ctx.reply(text, extra);
  return sent?.message_id || null;
}

async function deleteTempMessage(ctx, messageId) {
  if (!ctx.chat?.id || !messageId) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {}
}

const DUTY_SHEET_GVIZ_URL = "https://docs.google.com/spreadsheets/d/1gWlj6NObCw0AMKBK5GW_2_mCPs6WoF73bNe7QgkGBDc/gviz/tq?tqx=out:json&gid=1110843393";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseDutySheetDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchDutyScheduleByDate(date = new Date()) {
  const targetDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);

  const response = await fetch(DUTY_SHEET_GVIZ_URL);
  if (!response.ok) {
    throw new Error(`KhÃ´ng táº£i Ä‘Æ°á»£c Google Sheet lá»‹ch trá»±c (${response.status}).`);
  }

  const text = await response.text();
  const jsonText = text.match(/setResponse\((.*)\);?\s*$/s)?.[1];
  if (!jsonText) {
    throw new Error("Google Sheet tráº£ dá»¯ liá»‡u khÃ´ng Ä‘Ãºng Ä‘á»‹nh dáº¡ng gviz.");
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("KhÃ´ng parse Ä‘Æ°á»£c dá»¯ liá»‡u lá»‹ch trá»±c tá»« Google Sheet.");
  }

  const rows = (data?.table?.rows || [])
    .map((item) => (item?.c || []).map((cell) => {
      if (!cell) return "";
      if (cell.f !== undefined && cell.f !== null && cell.f !== "") return String(cell.f);
      if (cell.v === null || cell.v === undefined) return "";
      return String(cell.v);
    }))
    .filter((cells) => parseDutySheetDate(cells[0]) === targetDate);

  if (!rows.length) {
    return { ok: true, targetDate, found: false };
  }

  const firstRow = rows[0];
  const weekday = String(firstRow[1] || "").trim();
  const note = rows.map((row) => String(row[7] || "").trim()).filter(Boolean).join("\n");
  const isHoliday = /nghá»‰ lá»…/i.test(note);
  const isSundayShift = rows.some((row) => /chá»§ nháº­t/i.test(String(row[1] || "").trim()));

  if (isSundayShift) {
    const sundayShifts = rows.map((row) => ({
      label: String(row[1] || "").trim(),
      people: row.slice(2, 7).map((item) => String(item || "").trim()).filter(Boolean),
      server: String(row[8] || "").trim(),
      note: String(row[7] || "").trim()
    }));

    return {
      ok: true,
      targetDate,
      found: true,
      weekday,
      note,
      isHoliday,
      isSundayShift,
      sundayShifts,
      dutyNight: [],
      afterHoursServer: "",
      morningPrimary: "",
      morningSupport: [],
      noon: []
    };
  }

  const row = firstRow;
  const dutyNight = row.slice(2, 7).map((item) => String(item || "").trim()).filter(Boolean);
  const afterHoursServer = String(row[8] || "").trim();
  const morningPrimary = String(row[9] || "").trim();
  const morningSupport = row.slice(10, 14).map((item) => String(item || "").trim()).filter(Boolean);
  const noon = row.slice(14, 17).map((item) => String(item || "").trim()).filter(Boolean);

  return {
    ok: true,
    targetDate,
    found: true,
    weekday,
    note,
    dutyNight,
    afterHoursServer,
    morningPrimary,
    morningSupport,
    noon,
    isHoliday,
    isSundayShift,
    sundayShifts: []
  };
}

const DUTY_SHEET_URL = "https://docs.google.com/spreadsheets/d/1gWlj6NObCw0AMKBK5GW_2_mCPs6WoF73bNe7QgkGBDc/edit?gid=1110843393#gid=1110843393";

function formatDutyHeader(result) {
  const displayDate = (() => {
    const match = String(result.targetDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return escapeHtml(result.targetDate || "");
    const [, yyyy, mm, dd] = match;
    return `${dd}/${mm}/${yyyy}`;
  })();

  const weekday = String(result.weekday || "").trim().replace(/\s*-\s*Ca\s*\d+.*$/i, "");

  return [
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    `ðŸ“‹ <b>Lá»‹ch trá»±c ${displayDate}</b>`,
    `ðŸ—“ï¸ <b>${escapeHtml(weekday).toUpperCase()}</b>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”"
  ];
}

function formatDutyInlinePeople(values = [], options = {}) {
  const items = values.map((item) => {
    const name = String(item || "").trim();
    if (!name || name === "-") return "";
    // Máº¹o: DÃ¹ng link ná»™i bá»™ Ä‘á»ƒ táº¡o mÃ u xanh (Click vÃ o chá»‰ má»Ÿ láº¡i Bot hoáº·c khÃ´ng Ä‘i Ä‘Ã¢u xa)
    return `<a href="https://t.me/share/url?url=${encodeURIComponent(name)}">${name}</a>`;
  }).filter(Boolean);
  
  if (!items.length) return "-";
  const joined = items.join(" â€¢ ");
  return options.bold ? `<b>${joined}</b>` : joined;
}

function formatDutyAlignedLine(icon, label, value) {
  const cleanLabel = String(label || "").trim();
  const displayValue = String(value || "").trim();
  if (!displayValue || displayValue === "-") {
    return `${icon} <b>${escapeHtml(cleanLabel)}:</b> -`;
  }
  return `${icon} <b>${escapeHtml(cleanLabel)}:</b> ${displayValue}`;
}

function splitNoteGroupItems(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findUserDutyRoles(result, fullName) {
  if (!fullName || !result?.found) return [];
  const lowerFullName = String(fullName).toLowerCase().trim();
  const viewerParts = lowerFullName.split(/\s+/).filter(Boolean);
  
  const roles = [];

  const isUserMatch = (scheduleNameRaw) => {
    if (!scheduleNameRaw) return false;
    const sName = String(scheduleNameRaw).toLowerCase().trim();
    if (!sName) return false;

    // TÃ¡ch táº¥t cáº£ cÃ¡c tá»« trong tÃªn trÃªn lá»‹ch (xá»­ lÃ½ cáº£ dáº¥u phÃ¢n cÃ¡ch â€¢ ,)
    const sParts = sName.split(/[\sâ€¢,]+/).filter(Boolean);
    
    // Kiá»ƒm tra xem cÃ³ báº¥t ká»³ tá»« nÃ o trong lá»‹ch khá»›p hoÃ n toÃ n vá»›i má»™t tá»« trong tÃªn sáº¿p khÃ´ng
    // VÃ­ dá»¥: Lá»‹ch ghi "Äá»©c" khá»›p vá»›i "Trá»‹nh Äá»©c" (vÃ¬ cÃ¹ng cÃ³ tá»« "Ä‘á»©c")
    return sParts.some(sPart => viewerParts.includes(sPart));
  };

  const checkValue = (value) => {
    if (!value) return false;
    const items = Array.isArray(value) ? value : [value];
    return items.some(item => isUserMatch(item));
  };

  if (result.isHoliday) {
    const lines = String(result.note || "").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^(Nghá»‰ lá»…[^:]*|Ca\s*\d+[^:]*):\s*(.*)$/i);
      if (match && isUserMatch(match[2])) {
        roles.push(match[1]);
      } else if (!match && isUserMatch(line)) {
        roles.push("Trá»±c lá»… (Ghi chÃº)");
      }
    }
  } else if (result.isSundayShift) {
    (result.sundayShifts || []).forEach(shift => {
      if (checkValue(shift.people)) roles.push(shift.label || "Trá»±c Chá»§ Nháº­t");
      if (checkValue(shift.server)) roles.push("Trá»±c server (Chá»§ Nháº­t)");
    });
  } else {
    if (checkValue(result.dutyNight)) roles.push("Trá»±c tá»‘i");
    if (checkValue(result.morningPrimary)) roles.push("Trá»±c sÃ¡ng");
    if (checkValue(result.morningSupport)) roles.push("Trá»±c hÃ nh chÃ­nh");
    if (checkValue(result.noon)) roles.push("Trá»±c trÆ°a");
    if (checkValue(result.afterHoursServer)) roles.push("Trá»±c server");
  }

  return [...new Set(roles)];
}

function parseDutyNoteGroups(note) {
  const groups = [];
  const lines = String(note || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      groups.push({ title: line, items: [] });
      continue;
    }
    const [, title, value] = match;
    groups.push({ title: title.trim(), items: splitNoteGroupItems(value) });
  }

  return groups;
}

function formatDutyNoteLines(note) {
  const groups = parseDutyNoteGroups(note);
  if (!groups.length) {
    return [];
  }

  return groups.map((group) => {
    const title = String(group.title || "").trim();
    const value = group.items.length ? formatDutyInlinePeople(group.items, { bold: true }) : "";
    return formatDutyAlignedLine("ðŸ“", title, value);
  });
}

function formatHolidayDutyScheduleHtml(result) {
  const lines = String(result.note || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "-------------------");

  const body = [...formatDutyHeader(result), ""];
  let hasNoteTitle = false;

  for (const line of lines) {
    const match = line.match(/^(Nghá»‰ lá»…[^:]*|Ca\s*\d+[^:]*):\s*(.*)$/i);
    if (match) {
      const [, title, value] = match;
      const icon = /ca\s*1/i.test(title) ? "â˜€ï¸" : /ca\s*2/i.test(title) ? "ðŸŒ¤ï¸" : "ðŸŽŠ";
      const label = /ca\s*1/i.test(title) ? "Trá»±c ca 1" : /ca\s*2/i.test(title) ? "Trá»±c ca 2" : title;
      const people = String(value || "").split(/[â€¢,]/).map(s => s.trim()).filter(Boolean);
      body.push(formatDutyAlignedLine(icon, label, formatDutyInlinePeople(people, { bold: true })));
      continue;
    }

    if (!hasNoteTitle) {
      body.push("", "ðŸ“ <b>GHI CHÃš</b>");
      hasNoteTitle = true;
    }
    body.push(line.startsWith("ðŸ“") ? escapeHtml(line) : formatDutyAlignedLine("ðŸ“", line, ""));
  }

  return body.concat(["", `ðŸ”— <a href="${escapeHtml(DUTY_SHEET_URL)}">Xem Google Sheet</a>`]).join("\n");
}

function formatSundayDutyScheduleHtml(result) {
  const lines = [
    ...formatDutyHeader(result),
    ""
  ];

  const shifts = Array.isArray(result.sundayShifts) ? result.sundayShifts : [];
  shifts.forEach((shift, shiftIndex) => {
    if (shiftIndex > 0) lines.push("â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€");
    const isCa2 = /^.*ca\s*2/i.test(String(shift.label || ""));
    const label = isCa2 ? "Trá»±c ca 2" : "Trá»±c ca 1";
    const icon = isCa2 ? "ðŸŒ¤ï¸" : "â˜€ï¸";
    
    lines.push(formatDutyAlignedLine(icon, label, formatDutyInlinePeople(shift.people, { bold: true })));
    lines.push(formatDutyAlignedLine("ðŸ“¡", "Trá»±c server", formatDutyInlinePeople(shift.server ? [shift.server] : [], { bold: true })));
    if (shift.note) {
      const noteValue = String(shift.note || "").replace(/^Server\s*:\s*/i, "").trim() || "-";
      lines.push(formatDutyAlignedLine("ðŸ“", "Ghi chÃº", `<i>${escapeHtml(noteValue)}</i>`));
    }
  });

  return lines.join("\n") + `\n\nðŸ”— <a href="${escapeHtml(DUTY_SHEET_URL)}">Xem Google Sheet</a>`;
}

function getAccountDisplayName(account = {}) {
  const safeAccount = account || {};
  return safeAccount.telegramName || safeAccount.fullName || safeAccount.username || safeAccount.hermesUsername || "";
}

function getTelegramDisplayName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
}

function buildViewerAccount(ctx, account = null) {
  const from = ctx?.from || {};
  const chat = ctx?.chat || {};
  return {
    ...(account || {}),
    telegramId: account?.telegramId || from.id,
    chatId: account?.chatId || chat.id || from.id,
    telegramUsername: account?.telegramUsername || from.username || "",
    telegramName: account?.telegramName || getTelegramDisplayName(from)
  };
}

function getAccountMention(account = {}) {
  const safeAccount = account || {};
  const username = String(safeAccount.telegramUsername || "").replace(/^@/, "").trim();
  if (username) return `@${username}`;
  const name = escapeHtml(getAccountDisplayName(safeAccount) || safeAccount.telegramId || safeAccount.chatId || "NgÆ°á»i trá»±c");
  const id = safeAccount.telegramId || safeAccount.chatId;
  return id ? `<a href="tg://user?id=${escapeHtml(id)}">${name}</a>` : name;
}

function formatDutyMatchedMentions(result, accounts = []) {
  const lines = [];
  for (const account of accounts) {
    const displayName = getAccountDisplayName(account);
    if (!displayName) continue;
    const roles = findUserDutyRoles(result, displayName);
    if (!roles.length) continue;
    lines.push(`âœ… ${getAccountMention(account)} - ${roles.map((role) => `<b>${escapeHtml(role)}</b>`).join(" â€¢ ")}`);
  }
  return lines;
}
function formatDutyScheduleHtml(result, viewerName = "", options = {}) {
  const viewerAccount = options.viewerAccount || null;
  const includePersonalSection = options.includePersonalSection !== false;
  const userRoles = includePersonalSection ? findUserDutyRoles(result, viewerName) : [];
  const personalSection = userRoles.length
    ? [
      "âœ… <b>Báº N CÃ“ Lá»ŠCH TRá»°C</b>",
      `${viewerAccount ? getAccountMention(viewerAccount) + " - " : ""}${userRoles.map((role) => `<b>${escapeHtml(role)}</b>`).join(" â€¢ ")}`,
      ""
    ]
    : [
      "ðŸ“­ <b>Báº N KHÃ”NG CÃ“ Lá»ŠCH TRá»°C</b>",
      "Báº¡n khÃ´ng cÃ³ lá»‹ch trá»±c trong ngÃ y nÃ y.",
      ""
    ];

  if (!result?.found) {
    return [
      "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
      "ðŸ“‹ <b>Lá»‹ch trá»±c</b>",
      "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
      ...(includePersonalSection ? personalSection : []),
      "ðŸ“­ KhÃ´ng cÃ³ dá»¯ liá»‡u lá»‹ch trá»±c cho ngÃ y nÃ y."
    ].join("\n");
  }

  let content = "";
  if (result.isHoliday) {
    content = formatHolidayDutyScheduleHtml(result);
  } else if (result.isSundayShift) {
    content = formatSundayDutyScheduleHtml(result);
  } else {
    const lines = [
      ...formatDutyHeader(result),
      "",
      formatDutyAlignedLine("â˜€ï¸", "Trá»±c sÃ¡ng", formatDutyInlinePeople(result.morningPrimary ? [result.morningPrimary] : [], { bold: true })),
      formatDutyAlignedLine("ðŸ›ï¸", "Trá»±c hÃ nh chÃ­nh", formatDutyInlinePeople(result.morningSupport, { bold: true })),
      formatDutyAlignedLine("ðŸ±", "Trá»±c trÆ°a", formatDutyInlinePeople(result.noon, { bold: true })),
      formatDutyAlignedLine("ðŸŒ¤ï¸", "Trá»±c tá»‘i", formatDutyInlinePeople(result.dutyNight, { bold: true })),
      formatDutyAlignedLine("ðŸ“¡", "Trá»±c server", formatDutyInlinePeople(result.afterHoursServer ? [result.afterHoursServer] : [], { bold: true })),
    ];

    const noteLines = formatDutyNoteLines(result.note);
    if (noteLines.length) {
      lines.push("", "ðŸ“ <b>GHI CHÃš</b>");
      lines.push(...noteLines);
    }

    lines.push("", `ðŸ”— <a href="${escapeHtml(DUTY_SHEET_URL)}">Xem Google Sheet</a>`);
    content = lines.join("\n");
  }

  // ChÃ¨n pháº§n cÃ¡ nhÃ¢n vÃ o cuá»‘i
  const footerDivider = "â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€";
  return [
    content,
    ...(includePersonalSection ? [footerDivider, ...personalSection] : [])
  ].join("\n");
}

function formatWeekScheduleEntryHtml(entry, index) {
  const shift = String(getScheduleShiftLabel(entry) || "").trim();
  let summary = String(formatWorkScheduleSummaryLine(entry) || "").trim();
  if (shift) {
    summary = summary.replace(new RegExp(`\\s*-\\s*${escapeRegExp(shift)}\\s*$`, "i"), "").trim();
  }

  const link = firstValidScheduleLink(entry);
  const ticket = String(entry?.ticket || "").trim();
  const displayTicket = /^#\d{5,}$/.test(ticket) ? ticket : (summary.match(/#\d{5,}/)?.[0] || "");
  if (!link || !displayTicket || !summary.includes(displayTicket)) {
    return `${index}. ${escapeHtml(summary)}`;
  }

  const escapedSummary = escapeHtml(summary);
  const escapedTicket = escapeHtml(displayTicket);
  const linkedTicket = `<a href="${escapeHtml(link)}">${escapedTicket}</a>`;
  return `${index}. ${escapedSummary.replace(escapedTicket, linkedTicket)}`;
}
function formatWeekScheduleResult(results, checkedAt = new Date()) {
  const checkedDate = new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: config.timezoneId
  }).format(checkedAt);
  const checkedTime = new Intl.DateTimeFormat("vi-VN", { timeStyle: "medium", timeZone: config.timezoneId }).format(checkedAt);

  const lines = [
    `ðŸ—“ï¸ <b>Lá»‹ch lÃ m viá»‡c cáº£ tuáº§n</b>`,
    "________________________________",
    "",
    `â±ï¸ Giá» check: ${checkedTime}`,
    `ðŸ—“ï¸ NgÃ y check: ${checkedDate}`,
    ""
  ];

  for (const result of results) {
    const target = parseWorkScheduleDateInput(result.targetDate) || new Date();
    const label = new Intl.DateTimeFormat("vi-VN", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: config.timezoneId
    }).format(target);
    lines.push(`ðŸ—“ï¸ <b>${label}</b>`);
    
    if (!result.entries?.length) {
      lines.push("  - ChÆ°a cÃ³ lá»‹ch lÃ m viá»‡c");
      lines.push("");
      continue;
    }

    const sorted = sortWorkScheduleEntries(result.entries);
    const groups = {
      fullDay: { label: "Cáº¢ NGÃ€Y", icon: "ðŸ—“ï¸", items: sorted.filter((e) => /cáº£ ngÃ y|all day/i.test(getScheduleShiftLabel(e))) },
      morning: { label: "CA SÃNG", icon: "â˜€ï¸", items: sorted.filter((e) => /sÃ¡ng/i.test(getScheduleShiftLabel(e))) },
      afternoon: { label: "CA CHIá»€U", icon: "ðŸŒ¤ï¸", items: sorted.filter((e) => /chiá»u/i.test(getScheduleShiftLabel(e))) },
      other: { label: "KHÃC", icon: "ðŸ’¡", items: sorted.filter((e) => !/cáº£ ngÃ y|all day|sÃ¡ng|chiá»u/i.test(getScheduleShiftLabel(e))) }
    };


    let dayIndex = 1;
    for (const key of ["fullDay", "morning", "afternoon", "other"]) {
      const g = groups[key];
      if (g.items.length) {
        lines.push(`  ${g.icon} <b>${g.label}</b>`);
        for (const e of g.items) {
          lines.push(`  ${formatWeekScheduleEntryHtml(e, dayIndex)}`);
          dayIndex++;
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

const START_QUOTES = [
  [
    "HÃ´m nay mÃ¢y kÃ©o lÆ°ng trá»i,",
    "lá»‹ch cá»§a Sáº¿p Ä‘á»ƒ em ngá»“i canh cho."
  ],
  [
    "NgÃ y dÃ i viá»‡c cÃ³ thá»ƒ Ä‘Ã´ng,",
    "nhÆ°ng Ä‘Ãºng ngÃ y Ä‘Ãºng lá»‹ch thÃ¬ em khÃ´ng Ä‘á»ƒ sai."
  ],
  [
    "SÃ¡ng ra má»Ÿ lá»‹ch thong dong,",
    "phiáº¿u nÃ o Ä‘Ãºng viá»‡c em lÃ´i ra liá»n."
  ],
  [
    "Viá»‡c nhiá»u chÆ°a cháº¯c Ä‘Ã£ cÄƒng,",
    "cÃ³ em giá»¯ lá»‹ch, Ä‘á»¡ nháº±n hÆ¡n kha khÃ¡."
  ],
  [
    "Lá»‹ch kia náº¿u cÃ³ Ä‘á»•i dá»i,",
    "em soi Ä‘Ãºng chá»— chá»© khÃ´ng lÃ´i lá»‹ch ma."
  ],
  [
    "Má»™t láº§n báº¥m, má»™t láº§n xem,",
    "Ä‘Ãºng ngÃ y Ä‘Ãºng phiáº¿u em Ä‘em ra liá»n."
  ],
  [
    "GiÃ³ ngoÃ i kia thÃ­ch lang thang,",
    "cÃ²n em thÃ¬ thÃ­ch giá»¯ hÃ ng lá»‹ch cho Sáº¿p."
  ],
  [
    "Viá»‡c cháº¡y ngÆ°á»£c, lá»‹ch Ä‘á»«ng loáº¡n,",
    "Ä‘á»ƒ em gom láº¡i cho gá»n tá»«ng ngÃ y."
  ],
  [
    "Báº¥m vÃ o má»™t nhá»‹p lÃ  xem,",
    "lá»‹ch Ä‘Ã¢u phiáº¿u Ä‘Ã³ em Ä‘em tá»›i liá»n."
  ]
];

function pickStartQuote() {
  const index = Math.floor(Math.random() * START_QUOTES.length);
  return START_QUOTES[index] || START_QUOTES[0];
}

function homeText(telegramId) {
  return [
    "ðŸ  <b>TRANG CHá»¦ HERMES BOT</b>",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "Em há»— trá»£ anh theo dÃµi cÃ´ng viá»‡c Hermes háº±ng ngÃ y: tá»•ng há»£p hÃ´m nay, lá»‹ch lÃ m viá»‡c, lá»‹ch trá»±c vÃ  KPI.",
    "",
    "ðŸ“Œ <b>CÃC Má»¤C CHÃNH</b>",
    "â€¢ <b>Tá»•ng há»£p</b>: xem nhanh lá»‹ch trá»±c, lá»‹ch Hermes vÃ  KPI hÃ´m nay.",
    "â€¢ <b>Lá»‹ch lÃ m viá»‡c</b>: xem lá»‹ch ngÃ y, tuáº§n, má»Ÿ nhanh phiáº¿u Hermes báº±ng mÃ£ <code>#phiáº¿u</code>.",
    "â€¢ <b>Lá»‹ch trá»±c</b>: xem trá»±c ngÃ y/tuáº§n vÃ  nháº­n nháº¯c lá»‹ch trá»±c tá»± Ä‘á»™ng.",
    "â€¢ <b>KPI</b>: xem KPI tá»«ng thÃ¡ng nÄƒm 2026, point, doanh thu phÃ²ng vÃ  táº¡m tÃ­nh phÃ¢n bá»• cÃ¡ nhÃ¢n.",
    "â€¢ <b>ThÃ´ng bÃ¡o Hermes</b>: tá»± bÃ¡o khi cÃ³ thÃ´ng bÃ¡o má»›i hoáº·c phiáº¿u yÃªu cáº§u Ä‘á»•i tráº¡ng thÃ¡i, khÃ´ng bÃ¡o trÃ¹ng.",
    "",
    "âŒ¨ï¸ <b>Lá»†NH NHANH</b>",
    "â€¢ <code>/today</code> - Xem tá»•ng há»£p hÃ´m nay",
    "â€¢ <code>/lich</code> - Xem lá»‹ch lÃ m viá»‡c hÃ´m nay",
    "â€¢ <code>/lich mai</code> - Xem lá»‹ch lÃ m viá»‡c ngÃ y mai",
    "â€¢ <code>/lich 28/04/2026</code> - Xem lá»‹ch lÃ m viá»‡c theo ngÃ y",
    "â€¢ <code>/truc</code> - Xem lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <code>/truc mai</code> - Xem lá»‹ch trá»±c ngÃ y mai",
    "â€¢ <code>/kpi</code> - Má»Ÿ menu KPI theo thÃ¡ng",
    "â€¢ <code>/sethermes</code> - LÆ°u hoáº·c Ä‘á»•i tÃ i khoáº£n Hermes",
    "â€¢ <code>/deletehermes</code> - XÃ³a tÃ i khoáº£n Hermes Ä‘Ã£ lÆ°u",
    "â€¢ <code>/clearhermes</code> - XÃ³a session Hermes, giá»¯ tÃ i khoáº£n Ä‘á»ƒ test OTP",
    "â€¢ <code>/id</code> - Xem Telegram ID",
    "â€¢ <code>/cancel</code> - Há»§y thao tÃ¡c Ä‘ang chá»",
    "â€¢ <code>/testnotify</code> - Test Ä‘á»c thÃ´ng bÃ¡o Hermes má»›i nháº¥t",
    "",
    `ðŸ‘¤ Telegram ID: <code>${telegramId}</code>`
  ].join("\n");
}

function helpText(telegramId) {
  return homeText(telegramId);
}

function workMenuText() {
  return [
    "ðŸ—“ï¸ <b>Lá»‹ch lÃ m viá»‡c</b>",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "DÃ¹ng má»¥c nÃ y Ä‘á»ƒ xem lá»‹ch há»— trá»£/triá»ƒn khai theo ngÃ y hoáº·c cáº£ tuáº§n.",
    "",
    "âœ… <b>BOT Sáº¼ HIá»‚N THá»Š</b>",
    "â€¢ Lá»‹ch Ä‘Æ°á»£c nhÃ³m theo <b>Cáº¢ NGÃ€Y / CA SÃNG / CA CHIá»€U</b>.",
    "â€¢ MÃ£ <code>#phiáº¿u</code> cÃ³ thá»ƒ báº¥m Ä‘á»ƒ má»Ÿ nhanh phiáº¿u Hermes.",
    "â€¢ NÃºt <b>Xem lá»‹ch 1, 2, 3...</b> Ä‘á»ƒ xem ghi chÃº/chi tiáº¿t tá»«ng lá»‹ch.",
    "",
    "âŒ¨ï¸ <b>Lá»†NH Cáº¦N NHá»š</b>",
    "â€¢ <code>/lich</code> - Lá»‹ch hÃ´m nay",
    "â€¢ <code>/lich hÃ´m nay</code> - Lá»‹ch hÃ´m nay",
    "â€¢ <code>/lich mai</code> - Lá»‹ch ngÃ y mai",
    "â€¢ <code>/lich 28/04</code> - Lá»‹ch ngÃ y 28/04 trong nÄƒm hiá»‡n táº¡i",
    "â€¢ <code>/lich 28/04/2026</code> - Lá»‹ch Ä‘Ãºng ngÃ y 28/04/2026",
    "",
    "ðŸ‘‡ Anh chá»n nÃºt bÃªn dÆ°á»›i Ä‘á»ƒ xem nhanh."
  ].join("\n");
}

function dutyMenuText() {
  return [
    "ðŸ“‹ <b>Lá»‹ch trá»±c</b>",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "DÃ¹ng má»¥c nÃ y Ä‘á»ƒ xem lá»‹ch trá»±c cÃ¡ nhÃ¢n vÃ  toÃ n Ä‘á»™i theo Google Sheet.",
    "",
    "âœ… <b>BOT Sáº¼ HIá»‚N THá»Š</b>",
    "â€¢ Báº¡n cÃ³ lá»‹ch trá»±c hay khÃ´ng trong ngÃ y Ä‘Æ°á»£c chá»n.",
    "â€¢ NgÆ°á»i cÃ³ lá»‹ch trá»±c theo username Telegram Ä‘á»ƒ trÃ¡nh miss thÃ´ng bÃ¡o.",
    "â€¢ Lá»‹ch trá»±c ngÃ y hoáº·c lá»‹ch trá»±c cáº£ tuáº§n.",
    "",
    "ðŸ”” <b>THÃ”NG BÃO Tá»° Äá»˜NG</b>",
    "â€¢ <b>08:00</b>: tá»± gá»­i tab Tá»•ng há»£p hÃ´m nay",
    "â€¢ <b>Má»—i 30 giÃ¢y</b>: kiá»ƒm tra thÃ´ng bÃ¡o Hermes má»›i vÃ  chá»‰ bÃ¡o 1 láº§n",
    "â€¢ <b>07:00</b>: nháº¯c lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <b>11:00</b>: nháº¯c lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <b>17:00</b>: nháº¯c lá»‹ch trá»±c ngÃ y mai",
    "",
    "âŒ¨ï¸ <b>Lá»†NH Cáº¦N NHá»š</b>",
    "â€¢ <code>/truc</code> - Lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <code>/truc hÃ´m nay</code> - Lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <code>/truc mai</code> - Lá»‹ch trá»±c ngÃ y mai",
    "â€¢ <code>/truc 29/04</code> - Lá»‹ch trá»±c ngÃ y 29/04",
    "â€¢ <code>/truc 29/04/2026</code> - Lá»‹ch trá»±c Ä‘Ãºng ngÃ y",
    "â€¢ <code>/testtruc</code> - Test thÃ´ng bÃ¡o lá»‹ch trá»±c hÃ´m nay",
    "â€¢ <code>/testtruc mai</code> - Test thÃ´ng bÃ¡o lá»‹ch trá»±c ngÃ y mai",
    "",
    "ðŸ‘‡ Anh chá»n nÃºt bÃªn dÆ°á»›i Ä‘á»ƒ xem nhanh."
  ].join("\n");
}

function kpiMenuText(months = []) {
  const monthText = months.length ? months.map((month) => { const [year, monthNumber] = String(month).split("_"); return `${monthNumber}/${year}`; }).join(", ") : "chÆ°a cÃ³ thÃ¡ng nÃ o";
  return [
    "ðŸŽ¯ <b>KPI HERMES 2026</b>",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "DÃ¹ng má»¥c nÃ y Ä‘á»ƒ xem KPI theo tá»«ng thÃ¡ng, Ä‘Ãºng sheet thÃ¡ng Ä‘ang chá»n.",
    "",
    "âœ… <b>BOT Sáº¼ HIá»‚N THá»Š</b>",
    "â€¢ KPI Hotline, KPI Deploy vÃ  KPI SUM.",
    "â€¢ Point thá»±c táº¿, point bonus, point tÃ­nh lÆ°Æ¡ng.",
    "â€¢ Sáº£n lÆ°á»£ng triá»ƒn khai vÃ  chá»‰ sá»‘ váº­n hÃ nh.",
    "â€¢ Doanh thu phÃ²ng theo Ä‘Ãºng thÃ¡ng Ä‘ang xem.",
    "â€¢ Doanh thu phÃ¢n bá»• cÃ¡ nhÃ¢n vÃ  há»‡ sá»‘ phÃ¢n bá»• nhÃ³m <i>(táº¡m tÃ­nh)</i>.",
    "",
    "ðŸ§¾ <b>SHEET KPI</b>",
    "â€¢ Bot tá»± dÃ² cÃ¡c sheet dáº¡ng <code>2026_01</code> Ä‘áº¿n <code>2026_12</code>.",
    "â€¢ Khi phÃ¡t sinh sheet thÃ¡ng má»›i, báº¥m láº¡i <code>/kpi</code> Ä‘á»ƒ menu tá»± cáº­p nháº­t.",
    `â€¢ ThÃ¡ng Ä‘ang cÃ³ dá»¯ liá»‡u: <code>${monthText}</code>`,
    "",
    "âŒ¨ï¸ <b>Lá»†NH Cáº¦N NHá»š</b>",
    "â€¢ <code>/kpi</code> - Má»Ÿ menu KPI theo thÃ¡ng",
    "â€¢ Chá»n nÃºt thÃ¡ng, vÃ­ dá»¥ <b>05/2026</b>, Ä‘á»ƒ xem KPI thÃ¡ng Ä‘Ã³",
    "",
    "ðŸ‘‡ Anh chá»n thÃ¡ng bÃªn dÆ°á»›i Ä‘á»ƒ xem chi tiáº¿t."
  ].join("\n");
}

function buildStatusText() {
  return [
    "Bot lá»‹ch Hermes: online",
    `Báº¯t Ä‘áº§u: ${formatDateTime(startedAt)}`,
    `Uptime: ${formatDuration(Date.now() - startedAt.getTime())}`,
    `Thu muc chay: ${process.cwd()}`
  ].join("\n");
}

async function notifyAllowedUsers(message, options = {}) {
  const ids = await getAllowedTelegramIds();
  for (const telegramId of ids) {
    try {
      await bot.telegram.sendMessage(telegramId, message, options);
    } catch (error) {
      console.warn(`Cannot send Telegram notification to ${telegramId}:`, error.message);
    }
  }
}

async function notifyDutyScheduleForDate(date, reasonLabel) {
  const result = await fetchDutyScheduleByDate(date);
  const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
  const mentionLines = formatDutyMatchedMentions(result, accounts);
  const mentionSection = mentionLines.length
    ? ["âœ… <b>Báº N CÃ“ Lá»ŠCH TRá»°C</b>", ...mentionLines, "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”"]
    : [];
  const dateLabel = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date);
  const text = [
    "ðŸ”” <b>NHáº®C Lá»ŠCH TRá»°C</b>",
    `â° <b>Má»‘c nháº¯c:</b> ${escapeHtml(reasonLabel)}`,
    `ðŸ“… <b>NgÃ y trá»±c:</b> <code>${escapeHtml(dateLabel)}</code>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    ...mentionSection,
    formatDutyScheduleHtml(result, "")
  ].join("\n");
  await notifyAllowedUsers(text, { parse_mode: "HTML", disable_web_page_preview: true });
}

function getDutyReminderMoment(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parseInt(String(parts.hour).replace(/\D/g, ""), 10);
  const minute = parseInt(String(parts.minute).replace(/\D/g, ""), 10);
  if (isNaN(hour) || isNaN(minute)) return null;
  
  if (minute > 5 || ![7, 11, 17].includes(hour)) return null;
  const localDate = parseWorkScheduleDateInput(`${parts.year}-${parts.month}-${parts.day}`) || now;
  if (hour === 17) {
    return {
      key: `${parts.year}-${parts.month}-${parts.day}-17-tomorrow`,
      date: getRelativeWorkScheduleDate(1, localDate),
      label: "17:00 - lá»‹ch trá»±c ngÃ y mai"
    };
  }
  return {
    key: `${parts.year}-${parts.month}-${parts.day}-${hour}-today`,
    date: localDate,
    label: `${String(hour).padStart(2, "0")}:00 - lá»‹ch trá»±c hÃ´m nay`
  };
}

async function checkDutyScheduleReminders() {
  const now = new Date();
  const reminder = getDutyReminderMoment(now);
  console.log(`[Auto-Cron] Checking Duty Schedule at ${now.toLocaleTimeString("vi-VN")}`);
  if (!reminder || sentDutyReminderKeys.has(reminder.key)) return;
  sentDutyReminderKeys.add(reminder.key);
  await notifyDutyScheduleForDate(reminder.date, reminder.label);
}
async function syncTelegramCommandMenu() {
  try {
    await bot.telegram.setMyCommands(telegramCommands);
    await bot.telegram.setMyCommands(telegramCommands, { scope: { type: "all_private_chats" } });
    await bot.telegram.setChatMenuButton({ menuButton: { type: "commands" } });
  } catch (error) {
    console.error("Cannot sync Telegram command menu:", error);
  }
}

async function acquireInstanceLock() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Another Hermes schedule bot instance is already running on port ${config.lockPort}.`));
        return;
      }
      reject(error);
    });
    server.listen(config.lockPort, "127.0.0.1", () => {
      instanceLockServer = server;
      resolve();
    });
  });
}

async function releaseInstanceLock() {
  if (!instanceLockServer) return;
  await new Promise((resolve) => instanceLockServer.close(() => resolve()));
  instanceLockServer = null;
}

async function guard(ctx, next) {
  if (!isPrivateChat(ctx)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("Bot chá»‰ hoáº¡t Ä‘á»™ng trong chat private.");
    if (ctx.reply) await ctx.reply("Bot chá»‰ hoáº¡t Ä‘á»™ng trong chat private. Má»Ÿ chat riÃªng vá»›i bot nhÃ© Sáº¿p.");
    return;
  }
  if (isStartLikeUpdate(ctx)) return next();
  if (!(await isAllowedUser(ctx))) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("Telegram ID nÃ y chÆ°a Ä‘Æ°á»£c cáº¥p quyá»n.");
    if (ctx.reply) await ctx.reply(buildUnauthorizedText(ctx), Markup.removeKeyboard());
    return;
  }
  return next();
}

function parseScheduleCommandDate(text) {
  const raw = String(text || "").trim();
  const arg = raw.split(/\s+/).slice(1).join(" ");
  return parseWorkScheduleDateInput(arg);
}

function getWorkScheduleCacheKey(chatId, targetDate) {
  return `${chatId}:${targetDate}`;
}

function rememberWorkSchedule(ctx, result) {
  const key = getWorkScheduleCacheKey(ctx.chat.id, result.targetDate);
  // Sáº¯p xáº¿p láº¡i danh sÃ¡ch lá»‹ch trÆ°á»›c khi lÆ°u vÃ o cache Ä‘á»ƒ nÃºt báº¥m khá»›p vá»›i danh sÃ¡ch hiá»ƒn thá»‹
  const sortedResult = {
    ...result,
    entries: sortWorkScheduleEntries(result.entries)
  };
  workScheduleCache.set(key, { result: sortedResult, savedAt: Date.now() });
  for (const [cacheKey, value] of workScheduleCache.entries()) {
    if (Date.now() - value.savedAt > 30 * 60 * 1000) workScheduleCache.delete(cacheKey);
  }
  return key;
}

async function askWorkScheduleOtherDate(ctx) {
  pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_date" });
  await replyFresh(ctx, [
    "ðŸ“† <b>Chá»n ngÃ y cáº§n xem lá»‹ch</b>",
    "",
    "Sáº¿p chá»‰ cáº§n gá»­i má»™t trong cÃ¡c dáº¡ng sau:",
    "â€¢ <code>28/04</code>",
    "â€¢ <code>28/04/2026</code>",
    "â€¢ <code>hÃ´m nay</code>",
    "â€¢ <code>mai</code>",
    "",
    "Muá»‘n huá»· thÃ¬ gÃµ <code>/cancel</code>."
  ].join("\n"), {
    parse_mode: "HTML"
  });
}

async function askDutyOtherDate(ctx) {
  pendingActions.set(ctx.chat.id, { stage: "duty_schedule_date" });
  await replyFresh(ctx, [
    "ðŸ“† <b>Chá»n ngÃ y cáº§n xem lá»‹ch trá»±c</b>",
    "",
    "Sáº¿p chá»‰ cáº§n gá»­i má»™t trong cÃ¡c dáº¡ng sau:",
    "â€¢ <code>29/04</code>",
    "â€¢ <code>29/04/2026</code>",
    "â€¢ <code>hÃ´m nay</code>",
    "â€¢ <code>mai</code>",
    "",
    "Muá»‘n huá»· thÃ¬ gÃµ <code>/cancel</code>."
  ].join("\n"), {
    parse_mode: "HTML"
  });
}

async function getHermesAccountOrReply(ctx) {
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  if (!account?.hermesUsername || !account?.hermesPassword) {
    await replyFresh(ctx, "ChÆ°a cÃ³ tÃ i khoáº£n Hermes. Gá»­i /sethermes Ä‘á»ƒ lÆ°u trÆ°á»›c nhÃ© Sáº¿p.", keyboard());
    return null;
  }
  return account;
}

async function showWorkSchedule(ctx, date = new Date()) {
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;

  const loadingMessageId = await sendTempMessage(ctx, "Äang kiá»ƒm tra lá»‹ch lÃ m viá»‡c Hermes...");
  try {
    const result = await enqueue(() => getWorkScheduleByDay({
      username: account.hermesUsername,
      password: account.hermesPassword,
      date,
      storageState: account.hermesSession || null
    }));

    if (result.sessionExpired) await clearHermesSession(ctx.chat.id);
    if (result.otpRequired) {
      pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_otp", date });
      await replyFresh(ctx, "Hermes yÃªu cáº§u OTP. Sáº¿p gá»­i mÃ£ OTP má»›i nháº¥t, em sáº½ xÃ¡c nháº­n rá»“i lÆ°u phiÃªn. /cancel Ä‘á»ƒ huá»·.");
      return;
    }
    if (!result.ok) {
      await replyFresh(ctx, `KhÃ´ng láº¥y Ä‘Æ°á»£c lá»‹ch lÃ m viá»‡c.\n${String(result.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh").slice(0, 700)}`, keyboard());
      return;
    }
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    const cacheKey = rememberWorkSchedule(ctx, result);
    await replyFresh(ctx, formatWorkScheduleResult(result), {
      parse_mode: "HTML",
      ...workScheduleKeyboard(result, cacheKey)
    });
  } finally {
    await deleteTempMessage(ctx, loadingMessageId);
  }
}

function kpiKeyboard(months = []) {
  const rows = [];
  const normalizedMonths = [...new Set(months)]
    .filter((month) => /^2026_\d{2}$/.test(String(month)))
    .sort((a, b) => a.localeCompare(b));

  const monthButtons = normalizedMonths.map((month) => {
    const [year, monthNumber] = String(month).split("_");
    return Markup.button.callback(`ðŸ“Š ${monthNumber}/${year}`, `action:hermes_kpi_month:${month}`);
  });

  for (let i = 0; i < monthButtons.length; i += 3) {
    rows.push(monthButtons.slice(i, i + 3));
  }

  const homeButton = Markup.button.callback("ðŸ  Vá» trang chá»§", "action:menu");
  if (rows.length && rows[rows.length - 1].length < 3) {
    rows[rows.length - 1].push(homeButton);
  } else {
    rows.push([homeButton]);
  }
  return Markup.inlineKeyboard(rows);
}

function formatPercentLine(label, ratio) {
  const percent = Number(ratio || 0) * 100;
  return `${label}: <b>${percent.toFixed(2)}%</b>`;
}

function formatKpiBar(label, ratio) {
  const percent = Number(ratio || 0) * 100;
  const totalSteps = 10;
  const activeSteps = Math.round((Math.min(percent, 100) / 100) * totalSteps);
  
  const filled = "â–°".repeat(activeSteps);
  const empty = "â–±".repeat(totalSteps - activeSteps);
  const bar = `${filled}${empty}`;
  
  let icon = "ðŸŸ¢";
  if (percent < 80) {
    icon = "ðŸ”´";
  } else if (percent < 100) {
    icon = "ðŸŸ¡";
  } else if (percent >= 110) {
    icon = "ðŸ’Ž"; // Bonus icon for high performance
  }

  const dummyLink = "https://t.me/hermes_kpi";
  return [
    `${icon} <b>${label.toUpperCase()}</b>`,
    `<code>${bar}</code>  <a href="${dummyLink}"><b>${percent.toFixed(1)}%</b></a>`
  ].join("\n");
}

function formatMetricValue(value, digits = 1) {
  return Number(value || 0).toFixed(digits);
}

function parseMoneyValue(value) {
  const normalized = String(value || "")
    .replace(/[^0-9,.-]/g, "")
    .replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function formatMoneyValue(value) {
  return Math.round(Number(value || 0)).toLocaleString("en-US") + " Ä‘";
}

function padRight(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width) : " ".repeat(width - text.length) + text;
}

function formatWorkloadTable(item) {
  const allRows = [
    ["POS (6)", item.deployPos, "ðŸ–¥"],
    ["FABi (6)", item.deployFabi, "ðŸ¥ª"],
    ["CRM (3)", item.deployCrm, "ðŸ‘¥"],
    ["BK (3)", item.deployBk, "ðŸ“’"],
    ["Call (3)", item.deployCall, "ðŸ“ž"],
    ["WO (3)", item.deployWo, "ðŸ› "],
    ["O2O (3)", item.deployO2o, "ðŸŒ"],
    ["Hub (1)", item.deployHub, "ðŸ”Œ"],
    ["HDDT (1.5)", item.deployHddt, "ðŸ§¾"],
    ["FoodHub (1.5)", item.deployFoodHub, "ðŸ±"],
    ["Triá»ƒn khai thÃªm (3)", item.deployExtra, "âž•"],
    ["Onsite TX (1.5)", item.onsiteTx, "ðŸ "],
    ["Onsite NT (3)", item.onsiteNt, "ðŸ“"],
    ["Báº£o trÃ¬ (3)", item.maintenance, "ðŸ”§"]
  ];

  const activeRows = allRows.filter(([, val]) => Number(val || 0) > 0);
  const dummyLink = "https://t.me/hermes_kpi";

  if (activeRows.length === 0) {
    return "âœ¨ <b>Sáº¢N LÆ¯á»¢NG:</b> <i>ChÆ°a cÃ³ dá»¯ liá»‡u má»›i.</i>";
  }

  const lines = [
    "âœ¨ <b>CHI TIáº¾T Sáº¢N LÆ¯á»¢NG</b>",
    ...activeRows.map(([label, val, icon]) => `${icon} ${label}: <a href="${dummyLink}"><b>${formatMetricValue(val)}</b></a>`)
  ];

  if (Number(item.supportCount || 0) > 0 || Number(item.missFactor || 0) > 0 || Number(item.rateFactor || 0) > 0 || Number(item.rateAiAvg || 0) > 0) {
    lines.push("", "âš™ï¸ <b>Váº¬N HÃ€NH</b>");
    if (Number(item.supportCount || 0) > 0) lines.push(`â˜Žï¸ Support Count: <a href="${dummyLink}"><b>${formatMetricValue(item.supportCount, 0)}</b></a>`);
    if (Number(item.missFactor || 0) > 0) lines.push(`ðŸ“‰ Há»‡ sá»‘ nhá»¡: <a href="${dummyLink}"><b>${formatMetricValue(item.missFactor, 2)}</b></a>`);
    if (Number(item.rateFactor || 0) > 0) lines.push(`â­ Há»‡ sá»‘ Rate: <a href="${dummyLink}"><b>${formatMetricValue(item.rateFactor, 2)}</b></a>`);
    if (Number(item.rateAiAvg || 0) > 0) lines.push(`ðŸ¤– Rate AI Avg: <a href="${dummyLink}"><b>${formatMetricValue(item.rateAiAvg, 4)}</b></a>`);
  }

  return lines.join("\n");
}

function formatKpiMonthTelegramHtml(monthData, item) {
  const monthLabel = String(monthData.month || "").replace("_", "/");
  const dummyLink = "https://t.me/hermes_kpi";
  const defaultOtherRatio = 0.069;
  const baseTeamTotalPoint = Number(monthData.teamTotalPointSalary || 0);
  const adjustedTeamTotalPoint = baseTeamTotalPoint / (1 - defaultOtherRatio);
  const personalRatio = Number(item.pointSalary || 0) / Math.max(1, adjustedTeamTotalPoint);
  const allocationFactor = 0.506;
  const roomRevenueValue = parseMoneyValue(item.roomRevenue);
  const personalRevenue = roomRevenueValue * allocationFactor * personalRatio;
  return [
    "ðŸ’Ž <b>BÃO CÃO HIá»†U SUáº¤T - KPI</b>",
    `ðŸ“… <b>Giai Ä‘oáº¡n:</b> <code>THÃNG ${monthLabel}</code>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    `ðŸ‘¤ <b>Há»™i viÃªn:</b> <code>${escapeHtml(item.support)}</code>`,
    "",
    "ðŸ“Š <b>Báº¢NG Tá»”NG Há»¢P HIá»†U SUáº¤T</b>",
    formatKpiBar("HOTLINE", item.hotlinePct),
    "",
    formatKpiBar("TRIá»‚N KHAI", item.deployPct),
    "",
    formatKpiBar("KPI Tá»”NG", item.kpiSum),
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "",
    "ðŸ’° <b>THU NHáº¬P Æ¯á»šC TÃNH (POINTS)</b>",
    `ðŸ’µ Point Thá»±c táº¿: <a href="${dummyLink}"><b>${formatMetricValue(item.pointActual)}</b></a>`,
    `ðŸŽ Point ThÆ°á»Ÿng: <a href="${dummyLink}"><b>${formatMetricValue(item.pointBonus)}</b></a>`,
    `â€¢ <b>Tá»”NG Cá»˜NG:</b> <a href="${dummyLink}"><b>${formatMetricValue(item.pointSalary)}</b></a>`,
    "",
    `ðŸ‘¥ Tá»•ng point Ä‘á»™i: <a href="${dummyLink}"><b>${formatMetricValue(adjustedTeamTotalPoint)}</b></a>`,
    `âž• Suáº¥t máº·c Ä‘á»‹nh khÃ¡c: <a href="${dummyLink}"><b>6.9%</b></a>`,
    `ðŸ“ˆ Tá»· lá»‡ cÃ¡ nhÃ¢n: <a href="${dummyLink}"><b>${(personalRatio * 100).toFixed(1)}%</b></a>`,
    `ðŸ’° Doanh thu phÃ²ng: <a href="${dummyLink}"><b>${escapeHtml(item.roomRevenue || "---")}</b></a>`,
    `âš–ï¸ Há»‡ sá»‘ phÃ¢n bá»• nhÃ³m (táº¡m tÃ­nh): <a href="${dummyLink}"><b>50.6%</b></a>`,
    `ðŸ’µ Doanh thu phÃ¢n bá»• cÃ¡ nhÃ¢n (táº¡m tÃ­nh): <a href="${dummyLink}"><b>${formatMoneyValue(personalRevenue)}</b></a>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    formatWorkloadTable(item),
    "",
    "<i>HÃ£y tiáº¿p tá»¥c duy trÃ¬ phong Ä‘á»™ xuáº¥t sáº¯c nhÃ©! ðŸš€âœ¨</i>"
  ].join("\n");
}

async function showKpiSummary(ctx) {
  const loadingMessageId = await sendTempMessage(ctx, "Äang kiá»ƒm tra thÃ´ng tin KPI...");
  try {
    const result = await enqueue(() => getKpiSummary());
    if (!result?.ok) {
      await replyFresh(ctx, `KhÃ´ng táº£i Ä‘Æ°á»£c KPI.\n${String(result?.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh").slice(0, 700)}`, keyboard());
      return;
    }
    await replyFresh(ctx, kpiMenuText(result.months || []), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...kpiKeyboard(result.months || [])
    });
  } finally {
    await deleteTempMessage(ctx, loadingMessageId);
  }
}

async function showKpiMonth(ctx, month) {
  const loadingMessageId = await sendTempMessage(ctx, `Äang kiá»ƒm tra thÃ´ng tin KPI ${String(month || "").replace("_", "/")}...`);
  try {
    const account = await getHermesAccountOrReply(ctx);
    if (!account) return;
    const result = await enqueue(() => getKpiSummary(month));
    if (!result?.ok) {
      await ctx.reply(`KhÃ´ng táº£i Ä‘Æ°á»£c KPI.\n${String(result?.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh").slice(0, 700)}`, keyboard());
      return;
    }
    const monthData = (result.monthly || []).find((item) => item.month === month);
    if (!monthData) {
      await ctx.reply(`KhÃ´ng tÃ¬m tháº¥y sheet KPI thÃ¡ng ${month}.`, keyboard());
      return;
    }
    const item = (monthData.records || []).find((row) => {
      const support = String(row.support || "").trim().toLowerCase();
      const user = String(account.hermesUsername || "").trim().toLowerCase();
      return support === user || support === `${user}@ipos.vn` || user === `${support}@ipos.vn`;
    });
    if (!item) {
      await ctx.reply(`KhÃ´ng tÃ¬m tháº¥y KPI cá»§a tÃ i khoáº£n ${account.hermesUsername} trong sheet ${month}.`, keyboard());
      return;
    }

    const revenueResult = await enqueue(() => getHermesRoomRevenue({
      username: account.hermesUsername,
      password: account.hermesPassword,
      storageState: account.hermesSession,
      month
    }));
    if (revenueResult.sessionExpired) await clearHermesSession(ctx.chat.id);
    if (revenueResult.otpRequired) {
      pendingActions.set(ctx.chat.id, { stage: "hermes_kpi_otp", month });
      await replyFresh(ctx, "Hermes y?u c?u OTP khi l?y KPI. S?p g?i m? OTP m?i nh?t, em s? x?c nh?n r?i quay l?i ??ng KPI th?ng n?y. /cancel ?? hu?.");
      return;
    }
    if (revenueResult.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: revenueResult.storageState });
    }
    item.roomRevenue = revenueResult.ok ? revenueResult.value : "?ang c?p nh?t...";

    await replyFresh(ctx, formatKpiMonthTelegramHtml(monthData, item), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...kpiKeyboard(result.months || [])
    });
  } finally {
    await deleteTempMessage(ctx, loadingMessageId);
  }
}

async function showDutySchedule(ctx, date = new Date()) {
  try {
    const result = await fetchDutyScheduleByDate(date);
    const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.from.id });
    const viewerAccount = buildViewerAccount(ctx, account);
    const viewerName = getAccountDisplayName(viewerAccount);

    const text = formatDutyScheduleHtml(result, viewerName, { viewerAccount });
    await replyFresh(ctx, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...dutyKeyboard(date)
    });
  } catch (error) {
    await replyFresh(ctx, `KhÃ´ng táº£i Ä‘Æ°á»£c lá»‹ch trá»±c Google Sheet.\n${String(error.message || error).slice(0, 700)}`, dutyKeyboard(date));
  }
}

async function showDutyScheduleWeek(ctx, date = new Date()) {
  const startDate = getWeekRange(date).start;
  const parts = [];
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.from.id });
  const viewerAccount = buildViewerAccount(ctx, account);
  const viewerName = getAccountDisplayName(viewerAccount);

  for (let offset = 0; offset < 7; offset += 1) {
    const targetDate = getRelativeWorkScheduleDate(offset, startDate);
    const result = await fetchDutyScheduleByDate(targetDate);
    parts.push(formatDutyScheduleHtml(result, viewerName, { viewerAccount }));
  }
  await replyFresh(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...dutyKeyboard(date)
  });
}

async function showTodayDashboard(ctx) {
  const loadingMessageId = await sendTempMessage(ctx, "ðŸš€ <b>Äang chuáº©n bá»‹ Dashboard hÃ´m nay...</b>\n<i>Em Ä‘ang gom lá»‹ch trá»±c, lá»‹ch Hermes vÃ  KPI cho Sáº¿p. Äá»£i em má»™t xÃ­u nhÃ©!</i>", { parse_mode: "HTML" });
  
  const date = new Date();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  const viewerName = account?.fullName || account?.username || `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();

  const sections = [
    "ðŸš€ <b>DASHBOARD Tá»”NG Há»¢P HÃ”M NAY</b>",
    `ðŸ“… NgÃ y: <code>${new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date)}</code>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    ""
  ];

  try {
    const duty = await fetchDutyScheduleByDate(date);
    sections.push("ðŸ“‹ <b>Lá»‹ch trá»±c</b>");
    // Láº¥y ná»™i dung lá»‹ch trá»±c nhÆ°ng bá» bá»›t header rÆ°á»m rÃ 
    const dutyText = formatDutyScheduleHtml(duty, viewerName);
    const dutyBody = dutyText.split("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”").pop().trim();
    sections.push(dutyBody || "ðŸ“­ KhÃ´ng cÃ³ dá»¯ liá»‡u lá»‹ch trá»±c.");
  } catch (error) {
    sections.push("ðŸ“‹ <b>Lá»‹ch trá»±c</b>");
    sections.push("âŒ Lá»—i táº£i lá»‹ch trá»±c Google Sheet.");
  }

  if (account?.hermesUsername) {
    sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
    sections.push("ðŸ—“ï¸ <b>Lá»‹ch lÃ m viá»‡c</b>");
    
    const work = await enqueue(() => getWorkScheduleByDay({
      username: account.hermesUsername,
      password: account.hermesPassword,
      date,
      storageState: account.hermesSession || null
    }));

    if (work.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: work.storageState });
    }

    if (work.ok) {
      // Láº¥y ná»™i dung lá»‹ch lÃ m viá»‡c, bá» header rÆ°á»m rÃ 
      const workText = formatWorkScheduleResult(work);
      const workBody = workText.split("________________________________").pop().trim();
      sections.push(workBody || "âœ¨ HÃ´m nay Sáº¿p thong dong, chÆ°a tháº¥y lá»‹ch há»— trá»£ nÃ o.");
    } else {
      sections.push(`âŒ KhÃ´ng láº¥y Ä‘Æ°á»£c lá»‹ch: ${work.message || "Lá»—i Hermes"}`);
    }

    const kpi = await enqueue(() => getKpiSummary());
    if (kpi?.ok) {
      const nowMonth = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezoneId, year: "numeric", month: "2-digit" }).format(date).replace("-", "_");
      const monthData = (kpi.monthly || []).find((item) => item.month === nowMonth);
      const row = monthData?.records?.find((entry) => {
        const support = String(entry.support || "").trim().toLowerCase();
        const user = String(account.hermesUsername || "").trim().toLowerCase();
        return support === user || support === `${user}@ipos.vn` || user === `${support}@ipos.vn`;
      });
      if (monthData && row) {
        const revenueResult = await enqueue(() => getHermesRoomRevenue({
          username: account.hermesUsername,
          password: account.hermesPassword,
          storageState: account.hermesSession,
          month: nowMonth
        }));
        row.roomRevenue = revenueResult.ok ? revenueResult.value : "Äang cáº­p nháº­t...";

        sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
        sections.push("ðŸŽ¯ <b>KPI Tá»”NG Há»¢P</b>");
        const kpiText = formatKpiMonthTelegramHtml(monthData, row);
        const kpiParts = kpiText.split("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
        const kpiBody = kpiParts.slice(2, 4).join("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”").trim();
        sections.push(kpiBody || kpiText);
      }
      }
  }

  sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
  sections.push("<i>ChÃºc Sáº¿p má»™t ngÃ y lÃ m viá»‡c rá»±c rá»¡! ðŸš€âœ¨</i>");

  try {
    await deleteTempMessage(ctx, loadingMessageId);
    await replyFresh(ctx, sections.join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...dashboardKeyboard()
    });
  } catch (error) {
    console.error("Error replying dashboard:", error);
  }
}


async function buildTodayDashboardTextForChat(chatId, from = {}) {
  const date = new Date();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId });
  const viewerName = account?.fullName || account?.username || `${from.first_name || ""} ${from.last_name || ""}`.trim();

  const sections = [
    "ðŸš€ <b>DASHBOARD Tá»”NG Há»¢P HÃ”M NAY</b>",
    `ðŸ“… NgÃ y: <code>${new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date)}</code>`,
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    ""
  ];

  try {
    const duty = await fetchDutyScheduleByDate(date);
    sections.push("ðŸ“‹ <b>Lá»‹ch trá»±c</b>");
    const dutyText = formatDutyScheduleHtml(duty, viewerName);
    const dutyBody = dutyText.split("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”").pop().trim();
    sections.push(dutyBody || "ðŸ“­ KhÃ´ng cÃ³ dá»¯ liá»‡u lá»‹ch trá»±c.");
  } catch (error) {
    sections.push("ðŸ“‹ <b>Lá»‹ch trá»±c</b>");
    sections.push("âŒ Lá»—i táº£i lá»‹ch trá»±c Google Sheet.");
  }

  if (account?.hermesUsername) {
    sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
    sections.push("ðŸ—“ï¸ <b>Lá»‹ch lÃ m viá»‡c</b>");

    const work = await enqueue(() => getWorkScheduleByDay({
      username: account.hermesUsername,
      password: account.hermesPassword,
      date,
      storageState: account.hermesSession || null
    }));

    if (work.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId, storageState: work.storageState });
    }

    if (work.ok) {
      const workText = formatWorkScheduleResult(work);
      const workBody = workText.split("________________________________").pop().trim();
      sections.push(workBody || "âœ¨ HÃ´m nay Sáº¿p thong dong, chÆ°a tháº¥y lá»‹ch há»— trá»£ nÃ o.");
    } else {
      sections.push(`âŒ KhÃ´ng láº¥y Ä‘Æ°á»£c lá»‹ch: ${work.message || "Lá»—i Hermes"}`);
    }

    const kpi = await enqueue(() => getKpiSummary());
    if (kpi?.ok) {
      const nowMonth = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezoneId, year: "numeric", month: "2-digit" }).format(date).replace("-", "_");
      const monthData = (kpi.monthly || []).find((item) => item.month === nowMonth);
      const row = monthData?.records?.find((entry) => {
        const support = String(entry.support || "").trim().toLowerCase();
        const user = String(account.hermesUsername || "").trim().toLowerCase();
        return support === user || support === `${user}@ipos.vn` || user === `${support}@ipos.vn`;
      });
      if (monthData && row) {
        const revenueResult = await enqueue(() => getHermesRoomRevenue({
          username: account.hermesUsername,
          password: account.hermesPassword,
          storageState: account.hermesSession,
          month: nowMonth
        }));
        row.roomRevenue = revenueResult.ok ? revenueResult.value : "Äang cáº­p nháº­t...";

        sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
        sections.push("ðŸŽ¯ <b>KPI Tá»”NG Há»¢P</b>");
        const kpiText = formatKpiMonthTelegramHtml(monthData, row);
        const kpiParts = kpiText.split("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
        const kpiBody = kpiParts.slice(2, 4).join("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”").trim();
        sections.push(kpiBody || kpiText);
      }
    }
  }

  sections.push("", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
  sections.push("<i>ChÃºc Sáº¿p má»™t ngÃ y lÃ m viá»‡c rá»±c rá»¡! ðŸš€âœ¨</i>");
  return sections.join("\n");
}

async function notifyTodayDashboard() {
  const ids = await getAllowedTelegramIds();
  for (const telegramId of ids) {
    try {
      const text = await buildTodayDashboardTextForChat(telegramId);
      const sent = await bot.telegram.sendMessage(telegramId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...dashboardKeyboard()
      });
      if (sent?.message_id) lastBotMessageByChat.set(telegramId, sent.message_id);
    } catch (error) {
      console.warn(`Cannot send daily dashboard to ${telegramId}:`, error.message);
    }
  }
}

function getDashboardReminderMoment(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parseInt(String(parts.hour).replace(/\D/g, ""), 10);
  const minute = parseInt(String(parts.minute).replace(/\D/g, ""), 10);
  if (isNaN(hour) || isNaN(minute)) return null;
  
  if (hour !== 8 || minute > 5) return null;
  return `${parts.year}-${parts.month}-${parts.day}-08-dashboard`;
}

async function checkDashboardReminder() {
  const now = new Date();
  const key = getDashboardReminderMoment(now);
  console.log(`[Auto-Cron] Checking Daily Dashboard at ${now.toLocaleTimeString("vi-VN")}`);
  if (!key || sentDashboardReminderKeys.has(key)) return;
  sentDashboardReminderKeys.add(key);
  await notifyTodayDashboard();
}
async function showWorkScheduleWeek(ctx, date = new Date()) {
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;

  const loadingMessageId = await sendTempMessage(ctx, "Äang kiá»ƒm tra lá»‹ch cáº£ tuáº§n Hermes...");
  try {
    const results = [];
    let storageState = account.hermesSession || null;

    for (let offset = 0; offset < 7; offset += 1) {
      const targetDate = getRelativeWorkScheduleDate(offset, getRelativeWorkScheduleDate(-(new Date(date).getDay() || 7) + 1, date));
      const result = await enqueue(() => getWorkScheduleByDay({
        username: account.hermesUsername,
        password: account.hermesPassword,
        date: targetDate,
        storageState
      }));

      if (result.sessionExpired) await clearHermesSession(ctx.chat.id);
      if (result.otpRequired) {
        pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_otp", date: targetDate });
        await replyFresh(ctx, "Hermes yÃªu cáº§u OTP giá»¯a lÃºc láº¥y lá»‹ch tuáº§n. Sáº¿p gá»­i mÃ£ OTP má»›i nháº¥t rá»“i báº¥m láº¡i giÃºp em. /cancel Ä‘á»ƒ huá»·.");
        return;
      }
      if (!result.ok) {
        await replyFresh(ctx, `KhÃ´ng láº¥y Ä‘Æ°á»£c lá»‹ch tuáº§n.\n${String(result.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh").slice(0, 700)}`, keyboard());
        return;
      }
      if (result.storageState) {
        storageState = result.storageState;
        await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState });
      }
      results.push(result);
    }

    await replyFresh(ctx, formatWeekScheduleResult(results), {
      parse_mode: "HTML",
      ...keyboard()
    });
  } finally {
    await deleteTempMessage(ctx, loadingMessageId);
  }
}

bot.use(guard);

bot.start(async (ctx) => {
  const allowed = await isAllowedUser(ctx);
  if (!allowed) {
    await ctx.reply(buildUnauthorizedText(ctx), Markup.removeKeyboard());
    return;
  }
  await replyFresh(ctx, helpText(ctx.from.id), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard()
  });
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Telegram ID cá»§a Sáº¿p: ${getTelegramId(ctx)}`);
});

bot.command("menu", async (ctx) => {
  await replyFresh(ctx, homeText(ctx.from.id), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard()
  });
});

bot.command("status", async (ctx) => {
  await ctx.reply(buildStatusText(), keyboard());
});

bot.command("update", async (ctx) => {
  const loadingMessage = await ctx.reply("Đang kiểm tra bản mới trên GitHub...");
  const result = await updateFromGitHub();
  await ctx.reply(formatUpdateResult(result));

  if (result.ok && result.changed) {
    await ctx.reply("Bot sẽ khởi động lại để chạy bản mới. Nếu đang chạy bằng PM2/service, tiến trình sẽ tự bật lại.");
    setTimeout(() => process.exit(0), 1500);
  } else if (loadingMessage?.message_id) {
    await ctx.deleteMessage(loadingMessage.message_id).catch(() => {});
  }
});

bot.command("cancel", async (ctx) => {
  const pending = pendingActions.get(ctx.chat.id);
  if (["hermes_otp", "hermes_schedule_otp", "hermes_kpi_otp"].includes(pending?.stage)) {
    await cancelHermesOtpSession();
  }
  pendingActions.delete(ctx.chat.id);
  await ctx.reply("ÄÃ£ huá»· thao tÃ¡c Ä‘ang Ä‘á»£i.", Markup.removeKeyboard());
});

bot.command("deletehermes", async (ctx) => {
  await cancelHermesOtpSession();
  const removed = await deleteHermesAccount(ctx.chat.id);
  pendingActions.delete(ctx.chat.id);
  await ctx.reply(removed ? "?? xo? s?ch t?i kho?n Hermes v? session ?? l?u. S?p d?ng /sethermes ?? ??ng nh?p l?i t? ??u." : "Kh?ng t?m th?y t?i kho?n Hermes ?? xo?.");
});

bot.command("clearhermes", async (ctx) => {
  await cancelHermesOtpSession();
  const cleared = await clearHermesSession(ctx.chat.id);
  pendingActions.delete(ctx.chat.id);
  await ctx.reply(cleared ? "?? xo? session Hermes ?? l?u, v?n gi? t?i kho?n. S?p d?ng /lich ho?c /kpi ?? bot ??ng nh?p l?i v? b?t OTP m?i." : "Kh?ng t?m th?y session Hermes ?? xo?. N?u ch?a l?u t?i kho?n th? d?ng /sethermes tr??c nh?.", keyboard());
});

bot.command("sethermes", async (ctx) => {
  const message = ctx.message.text.trim();
  const parts = message.split(/\s+/);
  if (parts.length < 3) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_credentials" });
    await ctx.reply([
      "Nháº­p user vÃ  password Hermes trong tin nháº¯n tiáº¿p theo.",
      "Máº«u:",
      "username Abc123@"
    ].join("\n"));
    return;
  }
  const hermesUsername = parts[1];
  const hermesPassword = parts.slice(2).join(" ");
  await saveHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id, telegramUser: ctx.from, hermesUsername, hermesPassword });
  await ctx.reply(`ÄÃ£ lÆ°u tÃ i khoáº£n Hermes cho ${hermesUsername}. Äang test Ä‘Äƒng nháº­p...`);
  const result = await enqueue(() => validateHermesLogin({ username: hermesUsername, password: hermesPassword, keepOtpSession: true }));
  if (result.otpRequired) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_otp" });
    await ctx.reply("Hermes Ä‘ang yÃªu cáº§u OTP. Sáº¿p gá»­i mÃ£ OTP vÃ o tin nháº¯n tiáº¿p theo nhÃ©. /cancel Ä‘á»ƒ huá»·.");
    return;
  }
  await ctx.reply(result.ok ? result.message : `LÆ°u rá»“i nhÆ°ng test Hermes lá»—i: ${result.message}`, keyboard());
});

bot.command("today", async (ctx) => {
  await showTodayDashboard(ctx);
});

bot.command("truc", async (ctx) => {
  const date = parseScheduleCommandDate(ctx.message.text);
  if (!date) {
    await ctx.reply([
      "NgÃ y khÃ´ng há»£p lá»‡ Sáº¿p.",
      "Máº«u dÃ¹ng:",
      "/truc",
      "/truc hÃ´m nay",
      "/truc mai",
      "/truc 29/04",
      "/truc 29/04/2026"
    ].join("\n"));
    return;
  }
  await showDutySchedule(ctx, date);
});

bot.command("kpi", async (ctx) => {
  await showKpiSummary(ctx);
});

bot.command("testtruc", async (ctx) => {
  const text = String(ctx.message?.text || "").toLowerCase();
  const isTomorrow = /mai|tomorrow|17/.test(text);
  const targetDate = isTomorrow ? getRelativeWorkScheduleDate(1, new Date()) : new Date();
  const reasonLabel = isTomorrow ? "TEST - 17:00 - lá»‹ch trá»±c ngÃ y mai" : "TEST - lá»‹ch trá»±c hÃ´m nay";
  const loading = await sendTempMessage(ctx, "Äang test thÃ´ng bÃ¡o lá»‹ch trá»±c...");
  try {
    const result = await fetchDutyScheduleByDate(targetDate);
    const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
    const mentionLines = formatDutyMatchedMentions(result, accounts);
    const mentionSection = mentionLines.length ? ["âœ… <b>Báº N CÃ“ Lá»ŠCH TRá»°C</b>", ...mentionLines] : [];
    const dateLabel = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(targetDate);
    const textMessage = [
      "ðŸ”” <b>TEST NHáº®C Lá»ŠCH TRá»°C</b>",
      "â° <b>Má»‘c nháº¯c:</b> " + escapeHtml(reasonLabel),
      "ðŸ“… <b>NgÃ y trá»±c:</b> <code>" + escapeHtml(dateLabel) + "</code>",
      "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
      formatDutyScheduleHtml(result, "", { includePersonalSection: false }),
      "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
      ...mentionSection
    ].join("\n");
    await ctx.reply(textMessage, { parse_mode: "HTML", disable_web_page_preview: true });
  } finally {
    await deleteTempMessage(ctx, loading);
  }
});


bot.command("testnotify", async (ctx) => {
  const loading = await sendTempMessage(ctx, "Äang test thÃ´ng bÃ¡o Hermes...");
  try {
    const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
    if (!account?.hermesUsername || !account?.hermesPassword) {
      await ctx.reply("Anh chÆ°a lÆ°u tÃ i khoáº£n Hermes. DÃ¹ng /sethermes trÆ°á»›c nhÃ©.");
      return;
    }

    const result = await enqueue(() => getHermesNotifications({
      username: account.hermesUsername,
      password: account.hermesPassword,
      storageState: account.hermesSession || null
    }));
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    if (!result.ok) {
      await ctx.reply(`KhÃ´ng táº£i Ä‘Æ°á»£c thÃ´ng bÃ¡o Hermes.\n${String(result.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh").slice(0, 700)}`);
      return;
    }

    const notification = (result.notifications || [])[0];
    if (!notification) {
      await ctx.reply("Hiá»‡n chÆ°a Ä‘á»c Ä‘Æ°á»£c thÃ´ng bÃ¡o thay Ä‘á»•i tráº¡ng thÃ¡i phiáº¿u nÃ o tá»« Hermes.");
      return;
    }

    await ctx.reply([
      "ðŸ§ª <b>TEST THÃ”NG BÃO HERMES</b>",
      "Tin bÃªn dÆ°á»›i lÃ  thÃ´ng bÃ¡o má»›i nháº¥t bot Ä‘á»c Ä‘Æ°á»£c tá»« Hermes.",
      ""
    ].join("\n"), { parse_mode: "HTML" });
    await ctx.reply(formatHermesNotificationHtml(notification), {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...Markup.inlineKeyboard([
        [
          ...(notification.requestOrderId ? [Markup.button.callback("ðŸ‘ï¸ View chi tiáº¿t", `action:view_request_order:${notification.requestOrderId}`)] : []),
          Markup.button.callback("ðŸ  Trang chá»§", "action:menu")
        ]
      ])
    });
  } finally {
    await deleteTempMessage(ctx, loading);
  }
});
bot.command(["lich", "schedule", "workschedule"], async (ctx) => {
  const date = parseScheduleCommandDate(ctx.message.text);
  if (!date) {
    await ctx.reply([
      "NgÃ y khÃ´ng há»£p lá»‡ Sáº¿p.",
      "Máº«u dÃ¹ng:",
      "/lich",
      "/lich hÃ´m nay",
      "/lich mai",
      "/lich 28/04",
      "/lich 28/04/2026"
    ].join("\n"));
    return;
  }
  await showWorkSchedule(ctx, date);
});

bot.action("action:noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("action:menu", async (ctx) => {
  await ctx.answerCbQuery();
  await replyFresh(ctx, homeText(ctx.from.id), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard()
  });
});

bot.action("action:hermes_work_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await replyFresh(ctx, workMenuText(), {
    parse_mode: "HTML",
    ...workMenuKeyboard()
  });
});

bot.action("action:duty_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await replyFresh(ctx, dutyMenuText(), {
    parse_mode: "HTML",
    ...dutyMenuKeyboard()
  });
});

bot.action("action:hermes_account_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  const summary = account?.hermesUsername
    ? `ðŸ” <b>TÃ i khoáº£n Hermes</b>\nÄang lÆ°u: <b>${escapeHtml(account.hermesUsername)}</b>`
    : "ðŸ” <b>TÃ i khoáº£n Hermes</b>\nChÆ°a lÆ°u tÃ i khoáº£n.";
  await replyFresh(ctx, summary, {
    parse_mode: "HTML",
    ...accountMenuKeyboard()
  });
});

bot.action("action:hermes_work", async (ctx) => {
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch hÃ´m nay...");
  await showWorkSchedule(ctx, new Date());
});

bot.action(/^action:hermes_work_offset:(-?\d+)$/, async (ctx) => {
  const offset = Number(ctx.match?.[1] || 0);
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch...");
  await showWorkSchedule(ctx, getRelativeWorkScheduleDate(offset));
});

bot.action(/^action:hermes_work_date:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
  const baseDate = parseWorkScheduleDateInput(ctx.match?.[1]);
  const offset = Number(ctx.match?.[2] || 0);
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch...");
  await showWorkSchedule(ctx, getRelativeWorkScheduleDate(offset, baseDate || new Date()));
});

bot.action("action:today_dashboard", async (ctx) => {
  await ctx.answerCbQuery("Äang ghÃ©p dashboard hÃ´m nay...");
  await showTodayDashboard(ctx);
});

bot.action("action:duty_today", async (ctx) => {
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch trá»±c...");
  await showDutySchedule(ctx, new Date());
});

bot.action(/^action:duty_date:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
  const baseDate = parseWorkScheduleDateInput(ctx.match?.[1]);
  const offset = Number(ctx.match?.[2] || 0);
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch trá»±c...");
  await showDutySchedule(ctx, getRelativeWorkScheduleDate(offset, baseDate || new Date()));
});

bot.action(/^action:duty_week:?(\d{4}-\d{2}-\d{2})?$/, async (ctx) => {
  const dateStr = ctx.match?.[1];
  const date = dateStr ? parseWorkScheduleDateInput(dateStr) : new Date();
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch trá»±c cáº£ tuáº§n...");
  await showDutyScheduleWeek(ctx, date);
});

bot.action("action:duty_other", async (ctx) => {
  await ctx.answerCbQuery();
  await askDutyOtherDate(ctx);
});

bot.action(/^action:hermes_work_week:?(\d{4}-\d{2}-\d{2})?$/, async (ctx) => {
  const dateStr = ctx.match?.[1];
  const date = dateStr ? parseWorkScheduleDateInput(dateStr) : new Date();
  await ctx.answerCbQuery("Äang láº¥y lá»‹ch cáº£ tuáº§n...");
  await showWorkScheduleWeek(ctx, date);
});

bot.action("action:hermes_kpi", async (ctx) => {
  await ctx.answerCbQuery();
  await showKpiSummary(ctx);
});

bot.action(/^action:hermes_kpi_month:(\d{4}_\d{2})$/, async (ctx) => {
  const month = ctx.match?.[1];
  await ctx.answerCbQuery();
  await showKpiMonth(ctx, month);
});

bot.action("action:hermes_work_other", async (ctx) => {
  await ctx.answerCbQuery();
  await askWorkScheduleOtherDate(ctx);
});

bot.action("action:hermes_account", async (ctx) => {
  await ctx.answerCbQuery();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  if (account?.hermesUsername) {
    await replyFresh(ctx, `Äang lÆ°u tÃ i khoáº£n Hermes: ${account.hermesUsername}\nMuá»‘n Ä‘á»•i thÃ¬ gá»­i /sethermes.`, accountMenuKeyboard());
    return;
  }
  pendingActions.set(ctx.chat.id, { stage: "hermes_credentials" });
  await replyFresh(ctx, [
    "ChÆ°a lÆ°u tÃ i khoáº£n Hermes.",
    "Gá»­i user vÃ  password Hermes trong tin nháº¯n tiáº¿p theo.",
    "Máº«u:",
    "username Abc123@"
  ].join("\n"), accountMenuKeyboard());
});

bot.action("action:hermes_current_user", async (ctx) => {
  await ctx.answerCbQuery();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  await replyFresh(ctx, formatHermesAccountStatus(account), keyboard());
});

bot.action("action:delete_hermes", async (ctx) => {
  await ctx.answerCbQuery();
  await cancelHermesOtpSession();
  const removed = await deleteHermesAccount(ctx.chat.id);
  pendingActions.delete(ctx.chat.id);
  await replyFresh(ctx, removed ? "?? xo? s?ch t?i kho?n Hermes v? session ?? l?u. S?p d?ng /sethermes ?? ??ng nh?p l?i t? ??u." : "Kh?ng t?m th?y t?i kho?n Hermes ?? xo?.", keyboard());
});

bot.action(/^action:hermes_work_detail:(.+):(\d+)$/, async (ctx) => {
  const cacheKey = ctx.match?.[1];
  const index = Number(ctx.match?.[2] || 0);
  const cached = workScheduleCache.get(cacheKey);
  await ctx.answerCbQuery();
  if (!cached) {
    await replyFresh(ctx, "Dá»¯ liá»‡u lá»‹ch Ä‘Ã£ háº¿t háº¡n. Sáº¿p báº¥m láº¥y lá»‹ch láº¡i nhÃ©.", keyboard());
    return;
  }
  const entry = cached.result.entries?.[index];
  if (!entry) {
    await replyFresh(ctx, "KhÃ´ng tÃ¬m tháº¥y má»¥c lá»‹ch nÃ y. Sáº¿p báº¥m láº¥y lá»‹ch láº¡i nhÃ©.", workScheduleKeyboard(cached.result, cacheKey));
    return;
  }
  const requestOrderId = getRequestOrderIdFromScheduleEntry(entry);
  if (!requestOrderId) {
    await replyFresh(ctx, formatWorkScheduleNoteOnlyDetail(entry, cached.result), {
      parse_mode: "HTML",
      ...workScheduleDetailKeyboard(cached.result, cacheKey, entry)
    });
    return;
  }

  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;
  const loadingMessageId = await sendTempMessage(ctx, "Äang láº¥y chi tiáº¿t PYC tháº­t tá»« Hermes...");
  const detail = await enqueue(() => getRequestOrderDetailById({
    username: account.hermesUsername,
    password: account.hermesPassword,
    requestOrderId,
    storageState: account.hermesSession || null
  }));

  await deleteTempMessage(ctx, loadingMessageId);

  if (detail.sessionExpired) await clearHermesSession(ctx.chat.id);
  if (detail.otpRequired) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_otp", date: cached.result.targetDate });
    await replyFresh(ctx, "PhiÃªn Hermes Ä‘Ã£ háº¿t háº¡n nÃªn Hermes yÃªu cáº§u OTP láº¡i. Sáº¿p gá»­i mÃ£ OTP má»›i nháº¥t rá»“i báº¥m lá»‹ch láº¡i nhÃ©. /cancel Ä‘á»ƒ huá»·.");
    return;
  }
  if (!detail.ok) {
    console.error("[hermes_work_detail] failed to fetch request order detail", {
      chatId: ctx.chat?.id,
      cacheKey,
      index,
      requestOrderId,
      ticket: entry?.ticket || "",
      message: detail.message || "Unknown error",
      sessionExpired: Boolean(detail.sessionExpired),
      otpRequired: Boolean(detail.otpRequired)
    });
    await replyFresh(ctx, formatWorkScheduleNoteOnlyDetail(entry, cached.result), {
      parse_mode: "HTML",
      ...workScheduleDetailKeyboard(cached.result, cacheKey, entry)
    });
    return;
  }
  if (detail.storageState) {
    await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: detail.storageState });
  }
  await replyFresh(ctx, formatRequestOrderDetailHtml(detail.order, { checkedAt: detail.checkedAt }), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...workScheduleDetailKeyboard(cached.result, cacheKey, entry, detail.order)
  });
});

bot.action(/^action:view_request_order:(.+)$/, async (ctx) => {
  const requestOrderId = ctx.match?.[1];
  if (!requestOrderId || requestOrderId === "undefined") {
    await ctx.answerCbQuery("KhÃ´ng láº¥y Ä‘Æ°á»£c mÃ£ phiáº¿u.");
    return;
  }
  await ctx.answerCbQuery();
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;
  const loadingMessageId = await sendTempMessage(ctx, "Äang láº¥y chi tiáº¿t phiáº¿u tá»« Hermes...");
  const detail = await enqueue(() => getRequestOrderDetailById({
    username: account.hermesUsername,
    password: account.hermesPassword,
    requestOrderId,
    storageState: account.hermesSession || null
  }));
  await deleteTempMessage(ctx, loadingMessageId);

  if (detail.sessionExpired) await clearHermesSession(ctx.chat.id);
  if (detail.otpRequired) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_otp", date: new Date() });
    await replyFresh(ctx, "PhiÃªn Hermes Ä‘Ã£ háº¿t háº¡n nÃªn Hermes yÃªu cáº§u OTP láº¡i. Sáº¿p gá»­i mÃ£ OTP má»›i nháº¥t rá»“i báº¥m xem láº¡i nhÃ©. /cancel Ä‘á»ƒ huá»·.");
    return;
  }
  if (!detail.ok) {
    await replyFresh(ctx, `KhÃ´ng táº£i Ä‘Æ°á»£c chi tiáº¿t phiáº¿u.\n${detail.message || "Lá»—i Hermes"}`, keyboard());
    return;
  }
  if (detail.storageState) {
    await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: detail.storageState });
  }
  await replyFresh(ctx, formatRequestOrderDetailHtml(detail.order, { checkedAt: detail.checkedAt }), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([[Markup.button.callback("ðŸ  Vá» trang chá»§", "action:menu")]])
  });
});
bot.action(/^action:hermes_work_list:(.+)$/, async (ctx) => {
  const cacheKey = ctx.match?.[1];
  const cached = workScheduleCache.get(cacheKey);
  await ctx.answerCbQuery();
  if (!cached) {
    await replyFresh(ctx, "Dá»¯ liá»‡u lá»‹ch Ä‘Ã£ háº¿t háº¡n. Sáº¿p báº¥m láº¥y lá»‹ch láº¡i nhÃ©.", keyboard());
    return;
  }
  await replyFresh(ctx, formatWorkScheduleResult(cached.result), {
    parse_mode: "HTML",
    ...workScheduleKeyboard(cached.result, cacheKey)
  });
});

bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  
  if (text === "/testauto" || text.startsWith("/testauto@")) {
    await ctx.reply("â³ Äang giáº£ láº­p cháº¡y thÃ´ng bÃ¡o tá»± Ä‘á»™ng (Cronjob)...");
    try {
      await checkDutyScheduleReminders();
      await checkDashboardReminder();
      // Báº¯n tháº³ng hÃ m notify Ä‘á»ƒ test náº¿u giá» khÃ´ng khá»›p
      await notifyTodayDashboard();
      await notifyDutyScheduleForDate(new Date(), "Test lá»‡nh tá»± Ä‘á»™ng");
      await ctx.reply("âœ… ÄÃ£ cháº¡y xong hÃ m tá»± Ä‘á»™ng!");
    } catch (error) {
      await ctx.reply(`âŒ Lá»—i khi test tá»± Ä‘á»™ng: ${error.message}`);
    }
    return;
  }

  if (text === "/testnotify" || text.startsWith("/testnotify@")) {
    await ctx.reply("â³ Äang quÃ©t thá»­ thÃ´ng bÃ¡o Hermes Ä‘á»ƒ xem cÃ³ láº¥y Ä‘Æ°á»£c API khÃ´ng...");
    try {
      const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
      if (!account?.hermesUsername) {
        await ctx.reply("Sáº¿p chÆ°a lÆ°u tÃ i khoáº£n Hermes.");
        return;
      }
      
      const result = await enqueue(() => getHermesNotifications({
        username: account.hermesUsername,
        password: account.hermesPassword,
        storageState: account.hermesSession || null
      }));
      
      if (!result.ok) {
        await ctx.reply(`âŒ QuÃ©t tháº¥t báº¡i: ${result.message || "Lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh"}\nSession expired: ${Boolean(result.sessionExpired)}`);
        return;
      }
      
      const notifs = result.notifications || [];
      const notifsText = notifs.slice(0, 3).map((n, i) => `${i+1}. [${n.status}] ${n.title}\nKey: ${n.key}\nChi tiáº¿t: ${String(n.message).slice(0, 50)}...`).join("\n\n");
      await ctx.reply(`âœ… QuÃ©t thÃ nh cÃ´ng, tÃ¬m tháº¥y ${notifs.length} thÃ´ng bÃ¡o má»›i nháº¥t trÃªn trang.\n\nTop 3 thÃ´ng bÃ¡o bot Ä‘ang Ä‘á»c Ä‘Æ°á»£c lÃ :\n${notifsText || "KhÃ´ng cÃ³ thÃ´ng bÃ¡o nÃ o."}\n\nSáº¿p kiá»ƒm tra xem máº¥y cÃ¡i top nÃ y cÃ³ giá»‘ng vá»›i thÃ´ng bÃ¡o thá»±c táº¿ Sáº¿p Ä‘ang tháº¥y trÃªn web khÃ´ng nhÃ©!`);
    } catch (error) {
      await ctx.reply(`âŒ Lá»—i há»‡ thá»‘ng: ${error.message}`);
    }
    return;
  }

  const pending = pendingActions.get(ctx.chat.id);
  if (!pending) {
    await ctx.reply("Em chÆ°a hiá»ƒu lá»‡nh nÃ y. Gá»­i /lich hoáº·c /menu nhÃ© Sáº¿p.", keyboard());
    return;
  }

  if (pending.stage === "hermes_otp") {
    const otp = extractOtp(ctx.message.text);
    const loadingMessageId = await sendTempMessage(ctx, "Äang xÃ¡c nháº­n OTP Hermes...");
    const result = await enqueue(() => submitHermesOtp(otp));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      await replyFresh(ctx, result.message);
      return;
    }
    pendingActions.delete(ctx.chat.id);
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    if (!result.ok) {
      const msg = result.storageState 
        ? `âœ… XÃ¡c nháº­n OTP thÃ nh cÃ´ng (Ä‘Ã£ lÆ°u phiÃªn Ä‘Äƒng nháº­p).\nâŒ Lá»—i táº£i dá»¯ liá»‡u: ${result.message}`
        : `âŒ XÃ¡c nháº­n OTP lá»—i: ${result.message}`;
      await replyFresh(ctx, msg, keyboard());
      return;
    }
    await replyFresh(ctx, result.message, keyboard());
    return;
  }

  if (pending.stage === "hermes_kpi_otp") {
    const otp = extractOtp(ctx.message.text);
    const loadingMessageId = await sendTempMessage(ctx, "?ang x?c nh?n OTP Hermes v? quay l?i KPI...");
    const result = await enqueue(() => submitHermesOtpAndGetRoomRevenue(otp, pending.month || null));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      await replyFresh(ctx, result.message);
      return;
    }
    pendingActions.delete(ctx.chat.id);
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    if (!result.ok) {
      const msg = result.storageState
        ? `? X?c nh?n OTP th?nh c?ng (?? l?u phi?n ??ng nh?p).
? Nh?ng l?i khi l?y KPI: ${result.message}
(S?p b?m l?i KPI th?ng l? ???c v? phi?n ?? ??ng nh?p th?nh c?ng)`
        : `? X?c nh?n OTP l?i: ${result.message}`;
      await replyFresh(ctx, msg, keyboard());
      return;
    }
    await showKpiMonth(ctx, pending.month);
    return;
  }

  if (pending.stage === "duty_schedule_date") {
    const date = parseWorkScheduleDateInput(text);
    if (!date) {
      await ctx.reply("NgÃ y chÆ°a Ä‘Ãºng Ä‘á»‹nh dáº¡ng rá»“i Sáº¿p. VÃ­ dá»¥: 29/04, 29/04/2026, hÃ´m nay, mai.");
      return;
    }
    pendingActions.delete(ctx.chat.id);
    await showDutySchedule(ctx, date);
    return;
  }

  if (pending.stage === "hermes_schedule_otp") {
    const otp = extractOtp(ctx.message.text);
    const loadingMessageId = await sendTempMessage(ctx, "Äang xÃ¡c nháº­n OTP Hermes vÃ  láº¥y lá»‹ch...");
    const result = await enqueue(() => submitHermesOtpAndGetWorkSchedule(otp, pending.date || new Date()));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      await replyFresh(ctx, result.message);
      return;
    }
    pendingActions.delete(ctx.chat.id);
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    if (!result.ok) {
      const msg = result.storageState 
        ? `âœ… XÃ¡c nháº­n OTP thÃ nh cÃ´ng (Ä‘Ã£ lÆ°u phiÃªn Ä‘Äƒng nháº­p).\nâŒ NhÆ°ng lá»—i khi láº¥y lá»‹ch: ${result.message}\n(Sáº¿p cÃ³ thá»ƒ thá»­ gá»­i láº¡i lá»‡nh /lich vÃ¬ tÃ i khoáº£n Ä‘Ã£ Ä‘Äƒng nháº­p thÃ nh cÃ´ng)`
        : `âŒ XÃ¡c nháº­n OTP lá»—i: ${result.message}`;
      await replyFresh(ctx, msg, keyboard());
      return;
    }
    const cacheKey = rememberWorkSchedule(ctx, result);
    await replyFresh(ctx, formatWorkScheduleResult(result), {
      parse_mode: "HTML",
      ...workScheduleKeyboard(result, cacheKey)
    });
    return;
  }

  if (pending.stage === "hermes_schedule_date") {
    const date = parseWorkScheduleDateInput(ctx.message.text);
    if (!date) {
      await ctx.reply("NgÃ y khÃ´ng há»£p lá»‡ Sáº¿p. Gá»­i theo máº«u 28/04 hoáº·c 28/04/2026, hoáº·c /cancel Ä‘á»ƒ huá»·.");
      return;
    }
    pendingActions.delete(ctx.chat.id);
    await showWorkSchedule(ctx, date);
    return;
  }

  if (pending.stage === "hermes_credentials") {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply([
        "ChÆ°a Ä‘Ãºng máº«u nháº­p.",
        "Gá»­i láº¡i user vÃ  password Hermes trÃªn cÃ¹ng 1 dÃ²ng.",
        "VÃ­ dá»¥:",
        "username Abc123@"
      ].join("\n"));
      return;
    }
    const hermesUsername = parts[0];
    const hermesPassword = parts.slice(1).join(" ");
    await saveHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id, telegramUser: ctx.from, hermesUsername, hermesPassword });
    pendingActions.delete(ctx.chat.id);
    const loadingMessageId = await sendTempMessage(ctx, `ÄÃ£ lÆ°u tÃ i khoáº£n Hermes cho ${hermesUsername}. Äang test Ä‘Äƒng nháº­p...`);
    const result = await enqueue(() => validateHermesLogin({ username: hermesUsername, password: hermesPassword, keepOtpSession: true }));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      pendingActions.set(ctx.chat.id, { stage: "hermes_otp" });
      await replyFresh(ctx, "Hermes Ä‘ang yÃªu cáº§u OTP. Sáº¿p gá»­i mÃ£ OTP vÃ o tin nháº¯n tiáº¿p theo nhÃ©. /cancel Ä‘á»ƒ huá»·.");
      return;
    }
    if (result.ok && result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    await replyFresh(ctx, result.ok ? result.message : `LÆ°u rá»“i nhÆ°ng test Hermes lá»—i: ${result.message}`, keyboard());
  }
});

bot.catch((error, ctx) => {
  console.error("Hermes schedule bot error:", error);
  import("fs").then(m => m.appendFileSync("hermes_error_trace.txt", new Date().toISOString() + "\n" + (error.stack || error) + "\n\n"));
  if (ctx?.reply) ctx.reply("Bot lá»‹ch Hermes gáº·p lá»—i ngoÃ i dá»± kiáº¿n. Xem log Ä‘á»ƒ biáº¿t chi tiáº¿t.").catch(() => {});
});


function cleanHermesNotifyText(value = "") {
  return String(value || "")
    .replace(/<\/?strong>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatHermesStatus(value = "") {
  const raw = String(value || "").trim();
  const map = {
    RO_CHANGE_STATUS: "Thay Ä‘á»•i tráº¡ng thÃ¡i phiáº¿u",
    RO_CREATE: "Táº¡o phiáº¿u má»›i",
    RO_ASSIGN: "ÄÆ°á»£c phÃ¢n cÃ´ng xá»­ lÃ½",
    RO_COMMENT: "CÃ³ bÃ¬nh luáº­n má»›i",
    RO_REMIND: "Nháº¯c xá»­ lÃ½ phiáº¿u",
    RO_CHANGE_PROCESSOR: "Thay Ä‘á»•i ngÆ°á»i xá»­ lÃ½"
  };
  return map[raw] || raw || "CÃ³ cáº­p nháº­t";
}

function formatHermesNotificationHtml(notification = {}) {
  const title = cleanHermesNotifyText(notification.title || "ThÃ´ng bÃ¡o Hermes");
  const rawTicket = notification.ticketCode || notification.requestOrderId || "ChÆ°a rÃµ";
  const link = notification.link || (notification.requestOrderId ? `https://hermes.ipos.vn/request-order/${notification.requestOrderId}` : "");
  const ticketDisplay = link ? `<a href="${escapeHtml(link)}">${escapeHtml(rawTicket)}</a>` : `<code>${escapeHtml(rawTicket)}</code>`;
  const status = formatHermesStatus(notification.status);
  const message = cleanHermesNotifyText(notification.message || "");
  return [
    "ðŸ”” <b>THÃ”NG BÃO HERMES</b>",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    `ðŸ“Œ <b>Ná»™i dung:</b> ${escapeHtml(title)}`,
    `ðŸŽ« <b>Phiáº¿u yÃªu cáº§u:</b> ${ticketDisplay}`,
    `ðŸ”„ <b>Tráº¡ng thÃ¡i:</b> ${escapeHtml(status)}`,
    message ? `ðŸ“ <b>Chi tiáº¿t:</b>\n${escapeHtml(message).slice(0, 1200)}` : "",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "Anh báº¥m nÃºt bÃªn dÆ°á»›i Ä‘á»ƒ xem chi tiáº¿t phiáº¿u yÃªu cáº§u."
  ].filter(Boolean).join("\n");
}

async function checkHermesNotifications() {
  const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
  for (const account of accounts) {
    if (!account.chatId || !account.hermesUsername || !account.hermesPassword) continue;
    try {
      const result = await enqueue(() => getHermesNotifications({
        username: account.hermesUsername,
        password: account.hermesPassword,
        storageState: account.hermesSession || null
      }));
      if (result.storageState) {
        await saveHermesSession({ secret: config.botSecretKey, chatId: account.chatId, storageState: result.storageState });
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          await updateHermesNotificationState(account.chatId, { hermesSessionExpired: true });
        }
        continue;
      }

      const state = account.notificationState || {};
      const previousKeys = new Set(state.hermesNotificationKeys || []);
      const seenKeys = new Set(previousKeys);
      const isFirstScan = !Array.isArray(state.hermesNotificationKeys);
      for (const notification of result.notifications || []) {
        if (!notification.key) continue;
        if (seenKeys.has(notification.key)) continue;
        seenKeys.add(notification.key);
        if (isFirstScan) continue;
        await bot.telegram.sendMessage(account.chatId, formatHermesNotificationHtml(notification), {
          parse_mode: "HTML",
          disable_web_page_preview: false,
          ...Markup.inlineKeyboard([
            [
              ...(notification.requestOrderId ? [Markup.button.callback("ðŸ‘ï¸ View chi tiáº¿t", `action:view_request_order:${notification.requestOrderId}`)] : []),
              Markup.button.callback("ðŸ  Trang chá»§", "action:menu")
            ]
          ])
        });
      }
      await updateHermesNotificationState(account.chatId, {
        hermesSessionExpired: false,
        hermesNotificationKeys: Array.from(seenKeys).slice(-500),
        hermesNotificationCheckedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn(`Cannot check Hermes notifications for ${account.chatId}:`, error.message);
    }
  }
}
async function checkAllHermesSessions() {
  const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
  for (const account of accounts) {
    if (!account.hermesSession || (account.notificationState && account.notificationState.hermesSessionExpired)) {
      continue;
    }

    const res = await enqueue(() => validateStoredSession(account.hermesSession));
    if (!res.ok) {
      console.log(`[MONITOR] Hermes session for ${account.hermesUsername} (Chat: ${account.chatId}) has expired.`);
      await updateHermesNotificationState(account.chatId, { hermesSessionExpired: true });
      await bot.telegram.sendMessage(account.chatId, [
        "âš ï¸ <b>THÃ”NG BÃO: PHIÃŠN HERMES Háº¾T Háº N</b>",
        "",
        `TÃ i khoáº£n <b>${account.hermesUsername}</b> cá»§a Sáº¿p Ä‘Ã£ háº¿t háº¡n Ä‘Äƒng nháº­p trÃªn Hermes.`,
        "Äá»ƒ Ä‘áº£m báº£o dá»¯ liá»‡u Lá»‹ch lÃ m viá»‡c vÃ  Doanh thu luÃ´n sáºµn sÃ ng, Sáº¿p hÃ£y dÃ¹ng lá»‡nh /lich Ä‘á»ƒ Ä‘Äƒng nháº­p láº¡i nhÃ©!",
        "",
        "<i>Bot sáº½ táº¡m dá»«ng cáº­p nháº­t doanh thu cho Ä‘áº¿n khi cÃ³ phiÃªn má»›i.</i>"
      ].join("\n"), { parse_mode: "HTML" }).catch(() => {});
    }
  }
}

acquireInstanceLock()
  .then(() => bot.launch())
  .then(async () => {
    console.log("Hermes schedule Telegram bot is running.");
    await syncTelegramCommandMenu();
    if (config.startupNotify) {
      await notifyAllowedUsers("Bot lá»‹ch Hermes Ä‘Ã£ khá»Ÿi Ä‘á»™ng OK.");
    }
    
    // Start session monitoring
    setInterval(() => checkAllHermesSessions().catch(console.error), 30 * 60 * 1000); // Check every 30 mins
    checkAllHermesSessions().catch(console.error); // Check once on start
    setInterval(() => checkDutyScheduleReminders().catch(console.error), 60 * 1000);
    setInterval(() => checkDashboardReminder().catch(console.error), 60 * 1000);
    checkDutyScheduleReminders().catch(console.error);
    checkDashboardReminder().catch(console.error);
    setInterval(() => checkHermesNotifications().catch(console.error), 30 * 1000);
    checkHermesNotifications().catch(console.error);
  })
  .catch(async (error) => {
    console.error("Cannot launch Hermes schedule bot:", error);
    await releaseInstanceLock();
    process.exit(1);
  });

process.once("SIGINT", async () => {
  bot.stop("SIGINT");
  await releaseInstanceLock();
});

process.once("SIGTERM", async () => {
  bot.stop("SIGTERM");
  await releaseInstanceLock();
});

























