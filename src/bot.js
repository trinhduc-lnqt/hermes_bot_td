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
import { checkGithubVersion } from "./githubVersion.js";
import { ICON, TEXT, buttonText, statusText } from "./ui.js";
import { appVersion } from "./version.js";

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
let notifiedGithubVersion = null;

const telegramCommands = [
  { command: "start", description: "Mở menu Hermes" },
  { command: "today", description: "Xem tổng hợp hôm nay" },
  { command: "lich", description: "Xem lịch làm việc" },
  { command: "truc", description: "Xem lịch trực từ Google Sheet" },
  { command: "kpi", description: "Xem KPI tháng và năm" },
  { command: "sethermes", description: "Lưu tài khoản Hermes" },
  { command: "deletehermes", description: "Xóa tài khoản Hermes" },
  { command: "id", description: "Xem Telegram ID" },
  { command: "cancel", description: "Hủy thao tác đang đợi" }
];

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

function isGroupChat(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function isAllowedGroup(ctx) {
  return config.allowedGroupIds.includes(String(ctx.chat?.id || ""));
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
    "Telegram ID của Sếp:",
    telegramId || "(không xác định)",
    "",
    "Bot lịch Hermes đang khoá.",
    "Gửi ID này cho admin để được thêm vào danh sách cho phép."
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
    [Markup.button.callback(buttonText("dashboard", "menu"), "action:today_dashboard"), Markup.button.callback(buttonText("kpi", "kpi"), "action:hermes_kpi")],
    [Markup.button.callback(buttonText("workSchedule", "calendar"), "action:hermes_work_menu"), Markup.button.callback(buttonText("duty", "clipboard"), "action:duty_menu")],
    [Markup.button.callback(buttonText("account", "user"), "action:hermes_account_menu")]
  ]);
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactButtonLabel(text, maxLength = 42) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
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
    row.push(Markup.button.callback(`${ICON.detail} Xem lịch ${index + 1}`, `action:hermes_work_detail:${cacheKey}:${index}`));
    if (index + 1 < Math.min(entries.length, 10)) {
      row.push(Markup.button.callback(`${ICON.detail} Xem lịch ${index + 2}`, `action:hermes_work_detail:${cacheKey}:${index + 1}`));
    }
    rows.push(row);
  }

  const date = result.targetDate;
  rows.push([
    Markup.button.callback(buttonText("previousDay", "back"), `action:hermes_work_date:${date}:-1`),
    Markup.button.callback(buttonText("today", "calendar"), "action:hermes_work_offset:0"),
    Markup.button.callback(`${TEXT.button.nextDay} ${ICON.next}`, `action:hermes_work_date:${date}:1`)
  ]);
  rows.push([
    Markup.button.callback(buttonText("week", "week"), `action:hermes_work_week:${date}`),
    Markup.button.callback(buttonText("chooseDate", "calendar"), "action:hermes_work_other"),
    Markup.button.callback(buttonText("home", "home"), "action:menu")
  ]);
  return Markup.inlineKeyboard(rows);
}

function workScheduleDetailKeyboard(result, cacheKey, entry = null) {
  const date = result?.targetDate || toHermesLocalDate(new Date());
  return Markup.inlineKeyboard([
    [Markup.button.callback(buttonText("backToList", "clipboard"), `action:hermes_work_list:${cacheKey}`)],
    [
      Markup.button.callback(buttonText("previousDay", "back"), `action:hermes_work_date:${date}:-1`),
      Markup.button.callback(buttonText("today", "calendar"), "action:hermes_work_offset:0"),
      Markup.button.callback(`${TEXT.button.nextDay} ${ICON.next}`, `action:hermes_work_date:${date}:1`)
    ],
    [
      Markup.button.callback(buttonText("week", "week"), `action:hermes_work_week:${date}`),
      Markup.button.callback(buttonText("chooseDate", "calendar"), "action:hermes_work_other"),
      Markup.button.callback(buttonText("home", "home"), "action:menu")
    ]
  ]);
}

function dutyKeyboard(date = new Date()) {
  const targetDate = parseWorkScheduleDateInput(date) || new Date(date);
  const targetDateText = toHermesLocalDate(targetDate);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonText("previousDay", "back"), `action:duty_date:${targetDateText}:-1`),
      Markup.button.callback(buttonText("today", "calendar"), "action:duty_today"),
      Markup.button.callback(`${TEXT.button.nextDay} ${ICON.next}`, `action:duty_date:${targetDateText}:1`)
    ],
    [
      Markup.button.callback(buttonText("week", "week"), `action:duty_week:${targetDateText}`),
      Markup.button.callback(buttonText("chooseDate", "calendar"), "action:duty_other"),
      Markup.button.callback(buttonText("home", "home"), "action:menu")
    ]
  ]);
}

function dashboardKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonText("workSchedule", "week"), "action:hermes_work_menu"),
      Markup.button.callback(buttonText("duty", "clipboard"), "action:duty_menu"),
      Markup.button.callback(buttonText("kpi", "kpi"), "action:hermes_kpi"),
    ],
    [
      Markup.button.callback(buttonText("home", "home"), "action:menu")
    ]
  ]);
}

function workMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonText("previousDayShort", "back"), "action:hermes_work_offset:-1"),
      Markup.button.callback(buttonText("today", "calendar"), "action:hermes_work_offset:0"),
      Markup.button.callback(`${TEXT.button.nextDayShort} ${ICON.next}`, "action:hermes_work_offset:1")
    ],
    [
      Markup.button.callback(buttonText("week", "week"), "action:hermes_work_week"),
      Markup.button.callback(buttonText("chooseDate", "calendar"), "action:hermes_work_other"),
      Markup.button.callback(buttonText("home", "home"), "action:menu")
    ]
  ]);
}

function dutyMenuKeyboard() {
  const today = toHermesLocalDate(new Date());

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonText("previousDayShort", "back"), `action:duty_date:${today}:-1`),
      Markup.button.callback(buttonText("today", "calendar"), "action:duty_today"),
      Markup.button.callback(`${TEXT.button.nextDayShort} ${ICON.next}`, `action:duty_date:${today}:1`)
    ],
    [
      Markup.button.callback(buttonText("week", "week"), `action:duty_week:${today}`),
      Markup.button.callback(buttonText("chooseDate", "calendar"), "action:duty_other"),
      Markup.button.callback(buttonText("home", "home"), "action:menu")
    ]
  ]);
}

function accountMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(buttonText("currentUser", "user"), "action:hermes_current_user"),
      Markup.button.callback(buttonText("updateAccount", "lock"), "action:hermes_account"),
      Markup.button.callback(buttonText("deleteAccount", "delete"), "action:delete_hermes")
    ],
    [Markup.button.callback(buttonText("home", "home"), "action:menu")]
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
      "Chưa lưu tài khoản Hermes.",
      "Gửi /sethermes để thêm tài khoản."
    ].join("\n");
  }
  return [
    `User Hermes đang lưu: ${account.hermesUsername}`,
    `Telegram: ${account.telegramName || "(không có tên)"}${account.telegramUsername ? ` (@${account.telegramUsername})` : ""}`,
    `Chat ID: ${account.chatId || "(không có)"}`,
    `Cập nhật: ${account.updatedAt ? formatDateTime(new Date(account.updatedAt)) : "không rõ"}`,
    `Session Hermes: ${account.hermesSession ? "đang có" : "chưa có"}`
  ].join("\n");
}

async function deleteLastBotMessage(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Xoá tin nhắn vừa bấm nút (nếu có) để tránh dối mắt
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id);
    } catch {}
  }

  const lastMessageId = lastBotMessageByChat.get(chatId);
  if (!lastMessageId) return;

  // Nếu tin nhắn cuối cùng khác với tin nhắn vừa bấm thì xoá luôn cả nó
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
    throw new Error(`Không tải được Google Sheet lịch trực (${response.status}).`);
  }

  const text = await response.text();
  const jsonText = text.match(/setResponse\((.*)\);?\s*$/s)?.[1];
  if (!jsonText) {
    throw new Error("Google Sheet trả dữ liệu không đúng định dạng gviz.");
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("Không parse được dữ liệu lịch trực từ Google Sheet.");
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
  const isHoliday = /nghỉ lễ/i.test(note);
  const isSundayShift = rows.some((row) => /chủ nhật/i.test(String(row[1] || "").trim()));

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
const OT_SHEET_URL = "https://docs.google.com/spreadsheets/d/15frj-04elTgZgmVgPDmFEG6aWCxgZqy9/edit?gid=1960207408#gid=1960207408";

function formatDutyHeader(result, options = {}) {
  const displayDate = (() => {
    const match = String(result.targetDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return escapeHtml(result.targetDate || "");
    const [, yyyy, mm, dd] = match;
    return `${dd}/${mm}/${yyyy}`;
  })();

  const weekday = String(result.weekday || "").trim().replace(/\s*-\s*Ca\s*\d+.*$/i, "");

  if (options.weekView) {
    return [
      "━━━━━━━━━━━━━━━━━━━━",
      `📅 <b>${escapeHtml(weekday).toUpperCase()} • ${displayDate}</b>`,
      "━━━━━━━━━━━━━━━━━━━━"
    ];
  }

  return [
    "━━━━━━━━━━━━━━━━━━━━",
    `📋 <b>Lịch trực ${displayDate}</b>`,
    `🗓️ <b>${escapeHtml(weekday).toUpperCase()}</b>`,
    "━━━━━━━━━━━━━━━━━━━━"
  ];
}

function formatDutyInlinePeople(values = [], options = {}) {
  const items = values.map((item) => {
    const name = String(item || "").trim();
    if (!name || name === "-") return "";
    const safeName = escapeHtml(name);
    if (options.link === false) return safeName;
    return `<a href="https://t.me/share/url?url=${encodeURIComponent(name)}">${safeName}</a>`;
  }).filter(Boolean);
  
  if (!items.length) return "-";
  return items.join(" • ");
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

    // Tách tất cả các từ trong tên trên lịch (xử lý cả dấu phân cách • ,)
    const sParts = sName.split(/[\s•,]+/).filter(Boolean);
    
    // Kiểm tra xem có bất kỳ từ nào trong lịch khớp hoàn toàn với một từ trong tên sếp không
    // Ví dụ: Lịch ghi "Đức" khớp với "Trịnh Đức" (vì cùng có từ "đức")
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
      const match = line.match(/^(Nghỉ lễ[^:]*|Ca\s*\d+[^:]*):\s*(.*)$/i);
      if (match && isUserMatch(match[2])) {
        roles.push(match[1]);
      } else if (!match && isUserMatch(line)) {
        roles.push("Trực lễ (Ghi chú)");
      }
    }
  } else if (result.isSundayShift) {
    (result.sundayShifts || []).forEach(shift => {
      if (checkValue(shift.people)) roles.push(shift.label || "Trực Chủ Nhật");
      if (checkValue(shift.server)) roles.push("Trực server (Chủ Nhật)");
    });
  } else {
    if (checkValue(result.dutyNight)) roles.push("Trực tối");
    if (checkValue(result.morningPrimary)) roles.push("Trực sáng");
    if (checkValue(result.morningSupport)) roles.push("Trực hành chính");
    if (checkValue(result.noon)) roles.push("Trực trưa");
    if (checkValue(result.afterHoursServer)) roles.push("Trực server");
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
    return formatDutyAlignedLine("📍", title, value);
  });
}

function formatDutyDetailLinks() {
  return `📋 <a href="${escapeHtml(DUTY_SHEET_URL)}">Chi tiết lịch trực</a>\n⏱️ <a href="${escapeHtml(OT_SHEET_URL)}">Chi tiết OT</a>`;
}

function formatHolidayDutyScheduleHtml(result, options = {}) {
  const lines = String(result.note || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "-------------------");

  const body = [...formatDutyHeader(result, { weekView: options.weekView }), ""];
  let hasNoteTitle = false;

  for (const line of lines) {
    const match = line.match(/^(Nghỉ lễ[^:]*|Ca\s*\d+[^:]*):\s*(.*)$/i);
    if (match) {
      const [, title, value] = match;
      const icon = /ca\s*1/i.test(title) ? "☀️" : /ca\s*2/i.test(title) ? "🌤️" : "🎊";
      const label = /ca\s*1/i.test(title) ? "Trực ca 1" : /ca\s*2/i.test(title) ? "Trực ca 2" : title;
      const people = String(value || "").split(/[•,]/).map(s => s.trim()).filter(Boolean);
      body.push(formatDutyAlignedLine(icon, label, formatDutyInlinePeople(people, { bold: true, link: options.linkPeople })));
      continue;
    }

    if (!hasNoteTitle) {
      body.push("", "📝 <b>GHI CHÚ</b>");
      hasNoteTitle = true;
    }
    body.push(line.startsWith("📍") ? escapeHtml(line) : formatDutyAlignedLine("📍", line, ""));
  }

  return body.concat(options.includeDetailLinks === false ? [] : ["", formatDutyDetailLinks()]).join("\n");
}

function formatSundayDutyScheduleHtml(result, options = {}) {
  const lines = [
    ...formatDutyHeader(result, { weekView: options.weekView }),
    ""
  ];

  const shifts = Array.isArray(result.sundayShifts) ? result.sundayShifts : [];
  shifts.forEach((shift, shiftIndex) => {
    if (shiftIndex > 0) lines.push("────────────────────");
    const isCa2 = /^.*ca\s*2/i.test(String(shift.label || ""));
    const label = isCa2 ? "Trực ca 2" : "Trực ca 1";
    const icon = isCa2 ? "🌤️" : "☀️";
    
    lines.push(formatDutyAlignedLine(icon, label, formatDutyInlinePeople(shift.people, { bold: true, link: options.linkPeople })));
    lines.push(formatDutyAlignedLine("📡", "Trực server", formatDutyInlinePeople(shift.server ? [shift.server] : [], { bold: true, link: options.linkPeople })));
    if (shift.note) {
      const noteValue = String(shift.note || "").replace(/^Server\s*:\s*/i, "").trim() || "-";
      lines.push(formatDutyAlignedLine("📝", "Ghi chú", `<i>${escapeHtml(noteValue)}</i>`));
    }
  });

  return lines.join("\n") + (options.includeDetailLinks === false ? "" : `\n\n${formatDutyDetailLinks()}`);
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
  const name = escapeHtml(getAccountDisplayName(safeAccount) || safeAccount.telegramId || safeAccount.chatId || "Người trực");
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
    lines.push(`✅ ${getAccountMention(account)} - ${roles.map((role) => `<b>${escapeHtml(role)}</b>`).join(" • ")}`);
  }
  return lines;
}
function formatDutyScheduleHtml(result, viewerName = "", options = {}) {
  const viewerAccount = options.viewerAccount || null;
  const includePersonalSection = options.includePersonalSection !== false;
  const includeDetailLinks = options.includeDetailLinks !== false;
  const linkPeople = options.linkPeople !== false;
  const weekView = Boolean(options.weekView);
  const userRoles = includePersonalSection ? findUserDutyRoles(result, viewerName) : [];
  const personalSection = userRoles.length
    ? [
      "✅ <b>BẠN CÓ LỊCH TRỰC</b>",
      `${viewerAccount ? getAccountMention(viewerAccount) + " - " : ""}${userRoles.map((role) => `<b>${escapeHtml(role)}</b>`).join(" • ")}`,
      ""
    ]
    : [
      "📭 <b>BẠN KHÔNG CÓ LỊCH TRỰC</b>",
      "Bạn không có lịch trực trong ngày này.",
      ""
    ];

  if (!result?.found) {
    return [
      "━━━━━━━━━━━━━━━━━━━━",
      "📋 <b>Lịch trực</b>",
      "━━━━━━━━━━━━━━━━━━━━",
      ...(includePersonalSection ? personalSection : []),
      "📭 Không có dữ liệu lịch trực cho ngày này."
    ].join("\n");
  }

  let content = "";
  if (result.isHoliday) {
    content = formatHolidayDutyScheduleHtml(result, { includeDetailLinks, linkPeople, weekView });
  } else if (result.isSundayShift) {
    content = formatSundayDutyScheduleHtml(result, { includeDetailLinks, linkPeople, weekView });
  } else {
    const lines = [
      ...formatDutyHeader(result, { weekView }),
      "",
      formatDutyAlignedLine("☀️", "Trực sáng", formatDutyInlinePeople(result.morningPrimary ? [result.morningPrimary] : [], { bold: true, link: linkPeople })),
      formatDutyAlignedLine("🏛️", "Trực hành chính", formatDutyInlinePeople(result.morningSupport, { bold: true, link: linkPeople })),
      formatDutyAlignedLine("🍱", "Trực trưa", formatDutyInlinePeople(result.noon, { bold: true, link: linkPeople })),
      formatDutyAlignedLine("🌤️", "Trực tối", formatDutyInlinePeople(result.dutyNight, { bold: true, link: linkPeople })),
      formatDutyAlignedLine("📡", "Trực server", formatDutyInlinePeople(result.afterHoursServer ? [result.afterHoursServer] : [], { bold: true, link: linkPeople })),
    ];

    const noteLines = formatDutyNoteLines(result.note);
    if (noteLines.length) {
      lines.push("", "📝 <b>GHI CHÚ</b>");
      lines.push(...noteLines);
    }

    if (includeDetailLinks) lines.push("", formatDutyDetailLinks());
    content = lines.join("\n");
  }

  // Chèn phần cá nhân vào cuối
  const footerDivider = "────────────────────";
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

  let weekLabel = "Lịch làm việc cả tuần";
  if (results.length > 0) {
    const firstTarget = parseWorkScheduleDateInput(results[0].targetDate) || new Date(results[0].targetDate);
    const weekStart = new Date(firstTarget);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() || 7) - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const fmt = new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: config.timezoneId
    });
    weekLabel = `Lịch làm việc cả tuần (${fmt.format(weekStart)} - ${fmt.format(weekEnd)})`;
  }

  const lines = [
    `🗓️ <b>${weekLabel}</b>`,
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `⏱️ Giờ check: ${checkedTime}`,
    `🗓️ Ngày check: ${checkedDate}`,
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
    lines.push(`🔹 <b>${label.toUpperCase()}</b>`);
    
    if (!result.entries?.length) {
      lines.push("   <i>- Chưa có lịch làm việc -</i>");
      lines.push("┈┈┈┈┈┈┈┈┈┈┈┈┈");
      continue;
    }

    const sorted = sortWorkScheduleEntries(result.entries);
    const groups = {
      fullDay: { label: "CẢ NGÀY", icon: "🗓️", items: sorted.filter((e) => /cả ngày|all day/i.test(getScheduleShiftLabel(e))) },
      morning: { label: "CA SÁNG", icon: "☀️", items: sorted.filter((e) => /sáng/i.test(getScheduleShiftLabel(e))) },
      afternoon: { label: "CA CHIỀU", icon: "🌤️", items: sorted.filter((e) => /chiều/i.test(getScheduleShiftLabel(e))) },
      other: { label: "KHÁC", icon: "💡", items: sorted.filter((e) => !/cả ngày|all day|sáng|chiều/i.test(getScheduleShiftLabel(e))) }
    };


    let dayIndex = 1;
    for (const key of ["fullDay", "morning", "afternoon", "other"]) {
      const g = groups[key];
      if (g.items.length) {
        lines.push(`   ${g.icon} <b>${g.label}</b>`);
        for (const e of g.items) {
          lines.push(`     ${formatWeekScheduleEntryHtml(e, dayIndex)}`);
          dayIndex++;
        }
      }
    }
    lines.push("┈┈┈┈┈┈┈┈┈┈┈┈┈");
  }

  return lines.join("\n");
}

const START_QUOTES = [
  [
    "Hôm nay mây kéo lưng trời,",
    "lịch của Sếp để em ngồi canh cho."
  ],
  [
    "Ngày dài việc có thể đông,",
    "nhưng đúng ngày đúng lịch thì em không để sai."
  ],
  [
    "Sáng ra mở lịch thong dong,",
    "phiếu nào đúng việc em lôi ra liền."
  ],
  [
    "Việc nhiều chưa chắc đã căng,",
    "có em giữ lịch, đỡ nhằn hơn kha khá."
  ],
  [
    "Lịch kia nếu có đổi dời,",
    "em soi đúng chỗ chứ không lôi lịch ma."
  ],
  [
    "Một lần bấm, một lần xem,",
    "đúng ngày đúng phiếu em đem ra liền."
  ],
  [
    "Gió ngoài kia thích lang thang,",
    "còn em thì thích giữ hàng lịch cho Sếp."
  ],
  [
    "Việc chạy ngược, lịch đừng loạn,",
    "để em gom lại cho gọn từng ngày."
  ],
  [
    "Bấm vào một nhịp là xem,",
    "lịch đâu phiếu đó em đem tới liền."
  ]
];

function pickStartQuote() {
  const index = Math.floor(Math.random() * START_QUOTES.length);
  return START_QUOTES[index] || START_QUOTES[0];
}

function homeText(telegramId) {
  return [
    "🏠 <b>TRANG CHỦ HERMES BOT</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Em hỗ trợ anh theo dõi công việc Hermes hằng ngày: tổng hợp hôm nay, lịch làm việc, lịch trực và KPI.",
    "",
    "📌 <b>CÁC MỤC CHÍNH</b>",
    "• <b>Tổng hợp</b>: xem nhanh lịch trực, lịch Hermes và KPI hôm nay.",
    "• <b>Lịch làm việc</b>: xem lịch ngày, tuần, mở nhanh phiếu Hermes bằng mã <code>#phiếu</code>.",
    "• <b>Lịch trực</b>: xem trực ngày/tuần và nhận nhắc lịch trực tự động.",
    "• <b>KPI</b>: xem KPI từng tháng năm 2026, point, doanh thu phòng và tạm tính phân bổ cá nhân.",
    "• <b>Thông báo Hermes</b>: tự báo khi có thông báo mới hoặc phiếu yêu cầu đổi trạng thái, không báo trùng.",
    "",
    "⌨️ <b>LỆNH NHANH</b>",
    "• <code>/today</code> - Xem tổng hợp hôm nay",
    "• <code>/lich</code> - Xem lịch làm việc hôm nay",
    "• <code>/lich mai</code> - Xem lịch làm việc ngày mai",
    "• <code>/lich 28/04/2026</code> - Xem lịch làm việc theo ngày",
    "• <code>/truc</code> - Xem lịch trực hôm nay",
    "• <code>/truc mai</code> - Xem lịch trực ngày mai",
    "• <code>/kpi</code> - Mở menu KPI theo tháng",
    "• <code>/sethermes</code> - Lưu hoặc đổi tài khoản Hermes",
    "• <code>/deletehermes</code> - Xóa tài khoản Hermes đã lưu",
    "• <code>/id</code> - Xem Telegram ID",
    "• <code>/cancel</code> - Hủy thao tác đang chờ",
    "• <code>/testnotify</code> - Test đọc thông báo Hermes mới nhất",
    "",
    `👤 Telegram ID: <code>${telegramId}</code>`
  ].join("\n");
}

function helpText(telegramId) {
  return homeText(telegramId);
}

function workMenuText() {
  return [
    "🗓️ <b>Lịch làm việc</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Dùng mục này để xem lịch hỗ trợ/triển khai theo ngày hoặc cả tuần.",
    "",
    "✅ <b>BOT SẼ HIỂN THỊ</b>",
    "• Lịch được nhóm theo <b>CẢ NGÀY / CA SÁNG / CA CHIỀU</b>.",
    "• Mã <code>#phiếu</code> có thể bấm để mở nhanh phiếu Hermes.",
    "• Nút <b>Xem lịch 1, 2, 3...</b> để xem ghi chú/chi tiết từng lịch.",
    "",
    "⌨️ <b>LỆNH CẦN NHỚ</b>",
    "• <code>/lich</code> - Lịch hôm nay",
    "• <code>/lich hôm nay</code> - Lịch hôm nay",
    "• <code>/lich mai</code> - Lịch ngày mai",
    "• <code>/lich 28/04</code> - Lịch ngày 28/04 trong năm hiện tại",
    "• <code>/lich 28/04/2026</code> - Lịch đúng ngày 28/04/2026",
    "",
    "👇 Anh chọn nút bên dưới để xem nhanh."
  ].join("\n");
}

function dutyMenuText() {
  return [
    "📋 <b>Lịch trực</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Dùng mục này để xem lịch trực cá nhân và toàn đội theo Google Sheet.",
    "",
    "✅ <b>BOT SẼ HIỂN THỊ</b>",
    "• Bạn có lịch trực hay không trong ngày được chọn.",
    "• Người có lịch trực theo username Telegram để tránh miss thông báo.",
    "• Lịch trực ngày hoặc lịch trực cả tuần.",
    "",
    "🔔 <b>THÔNG BÁO TỰ ĐỘNG</b>",
    "• <b>08:00</b>: tự gửi tab Tổng hợp hôm nay",
    "• <b>Mỗi 30 giây</b>: kiểm tra thông báo Hermes mới và chỉ báo 1 lần",
    "• <b>07:00</b>: nhắc lịch trực hôm nay",
    "• <b>11:00</b>: nhắc lịch trực hôm nay",
    "• <b>17:00</b>: nhắc lịch trực ngày mai",
    "",
    "⌨️ <b>LỆNH CẦN NHỚ</b>",
    "• <code>/truc</code> - Lịch trực hôm nay",
    "• <code>/truc hôm nay</code> - Lịch trực hôm nay",
    "• <code>/truc mai</code> - Lịch trực ngày mai",
    "• <code>/truc 29/04</code> - Lịch trực ngày 29/04",
    "• <code>/truc 29/04/2026</code> - Lịch trực đúng ngày",
    "• <code>/testtruc</code> - Test thông báo lịch trực hôm nay",
    "• <code>/testtruc mai</code> - Test thông báo lịch trực ngày mai",
    "",
    "👇 Anh chọn nút bên dưới để xem nhanh."
  ].join("\n");
}

function kpiMenuText(months = []) {
  const monthText = months.length ? months.map((month) => { const [year, monthNumber] = String(month).split("_"); return `${monthNumber}/${year}`; }).join(", ") : "chưa có tháng nào";
  return [
    "🎯 <b>KPI HERMES 2026</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Dùng mục này để xem KPI theo từng tháng, đúng sheet tháng đang chọn.",
    "",
    "✅ <b>BOT SẼ HIỂN THỊ</b>",
    "• KPI Hotline, KPI Deploy và KPI SUM.",
    "• Point thực tế, point bonus, point tính lương.",
    "• Sản lượng triển khai và chỉ số vận hành.",
    "• Doanh thu phòng theo đúng tháng đang xem.",
    "• Doanh thu phân bổ cá nhân và hệ số phân bổ nhóm <i>(tạm tính)</i>.",
    "",
    "🧾 <b>SHEET KPI</b>",
    "• Bot tự dò các sheet dạng <code>2026_01</code> đến <code>2026_12</code>.",
    "• Khi phát sinh sheet tháng mới, bấm lại <code>/kpi</code> để menu tự cập nhật.",
    `• Tháng đang có dữ liệu: <code>${monthText}</code>`,
    "",
    "⌨️ <b>LỆNH CẦN NHỚ</b>",
    "• <code>/kpi</code> - Mở menu KPI theo tháng",
    "• Chọn nút tháng, ví dụ <b>05/2026</b>, để xem KPI tháng đó",
    "",
    "👇 Anh chọn tháng bên dưới để xem chi tiết."
  ].join("\n");
}

function buildStatusText() {
  return [
    "Bot lịch Hermes: online",
    `Bắt đầu: ${formatDateTime(startedAt)}`,
    `Uptime: ${formatDuration(Date.now() - startedAt.getTime())}`
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

async function checkGithubUpdateNotification() {
  if (!config.githubVersionCheckEnabled || !config.githubPackageUrl) return;
  try {
    const result = await checkGithubVersion(config.githubPackageUrl);
    if (!result.hasNewVersion) return;
    if (notifiedGithubVersion === result.remoteVersion) return;
    notifiedGithubVersion = result.remoteVersion;
    await notifyAllowedUsers([
      "🚀 <b>CÓ BẢN HERMES BOT MỚI TRÊN GITHUB</b>",
      "",
      `Bản đang chạy: <code>${escapeHtml(result.localVersion || appVersion)}</code>`,
      `Bản mới: <code>${escapeHtml(result.remoteVersion)}</code>`,
      "",
      "Để cập nhật trên VPS/Git:",
      "<code>npm run update:vps</code>",
      "",
      "Nếu dùng package global:",
      "<code>npm i -g hermesbot@latest</code>",
      "",
      "Bot sẽ backup bản cũ và tăng version sau update."
    ].join("\n"), { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (error) {
    console.warn("Cannot check GitHub version:", error.message);
  }
}

async function notifyDutyScheduleForDate(date, reasonLabel) {
  const result = await fetchDutyScheduleByDate(date);
  const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
  const mentionLines = formatDutyMatchedMentions(result, accounts);
  const mentionSection = mentionLines.length
    ? ["✅ <b>BẠN CÓ LỊCH TRỰC</b>", ...mentionLines, "━━━━━━━━━━━━━━━━━━━━"]
    : [];
  const dateLabel = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date);
  const text = [
    "🔔 <b>NHẮC LỊCH TRỰC</b>",
    `⏰ <b>Mốc nhắc:</b> ${escapeHtml(reasonLabel)}`,
    `📅 <b>Ngày trực:</b> <code>${escapeHtml(dateLabel)}</code>`,
    "━━━━━━━━━━━━━━━━━━━━",
    ...mentionSection,
    formatDutyScheduleHtml(result, "")
  ].join("\n");
  await notifyAllowedUsers(text, { parse_mode: "HTML", disable_web_page_preview: true });
}

function getDutyReminderMoment(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
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
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (minute > 5 || ![7, 11, 17].includes(hour)) return null;
  const localDate = parseWorkScheduleDateInput(`${parts.year}-${parts.month}-${parts.day}`) || now;
  if (hour === 17) {
    return {
      key: `${parts.year}-${parts.month}-${parts.day}-17-tomorrow`,
      date: getRelativeWorkScheduleDate(1, localDate),
      label: "17:00 - lịch trực ngày mai"
    };
  }
  return {
    key: `${parts.year}-${parts.month}-${parts.day}-${hour}-today`,
    date: localDate,
    label: `${String(hour).padStart(2, "0")}:00 - lịch trực hôm nay`
  };
}

async function checkDutyScheduleReminders() {
  const now = new Date();
  const reminder = getDutyReminderMoment(now);
  console.log(`[Auto-Cron] Duty check at ${now.toLocaleTimeString("vi-VN", { timeZone: config.timezoneId })}`);
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
  if (!isPrivateChat(ctx) && !isGroupChat(ctx)) return;
  if (isStartLikeUpdate(ctx)) return next();
  if (isGroupChat(ctx) && isAllowedGroup(ctx)) return next();
  if (!(await isAllowedUser(ctx))) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("Telegram ID này chưa được cấp quyền.");
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
  // Sắp xếp lại danh sách lịch trước khi lưu vào cache để nút bấm khớp với danh sách hiển thị
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
    "📆 <b>Chọn ngày cần xem lịch</b>",
    "",
    "Sếp chỉ cần gửi một trong các dạng sau:",
    "• <code>28/04</code>",
    "• <code>28/04/2026</code>",
    "• <code>hôm nay</code>",
    "• <code>mai</code>",
    "",
    "Muốn huỷ thì gõ <code>/cancel</code>."
  ].join("\n"), {
    parse_mode: "HTML"
  });
}

async function askDutyOtherDate(ctx) {
  pendingActions.set(ctx.chat.id, { stage: "duty_schedule_date" });
  await replyFresh(ctx, [
    "📆 <b>Chọn ngày cần xem lịch trực</b>",
    "",
    "Sếp chỉ cần gửi một trong các dạng sau:",
    "• <code>29/04</code>",
    "• <code>29/04/2026</code>",
    "• <code>hôm nay</code>",
    "• <code>mai</code>",
    "",
    "Muốn huỷ thì gõ <code>/cancel</code>."
  ].join("\n"), {
    parse_mode: "HTML"
  });
}

async function getHermesAccountOrReply(ctx) {
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  if (!account?.hermesUsername || !account?.hermesPassword) {
    await replyFresh(ctx, "Chưa có tài khoản Hermes. Gửi /sethermes để lưu trước nhé Sếp.", keyboard());
    return null;
  }
  return account;
}

async function showWorkSchedule(ctx, date = new Date()) {
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;

  const loadingMessageId = await sendTempMessage(ctx, "Đang kiểm tra lịch làm việc Hermes...");
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
      await replyFresh(ctx, "Hermes yêu cầu OTP. Sếp gửi mã OTP mới nhất, em sẽ xác nhận rồi lưu phiên. /cancel để huỷ.");
      return;
    }
    if (!result.ok) {
      await replyFresh(ctx, `Không lấy được lịch làm việc.\n${String(result.message || "Lỗi không xác định").slice(0, 700)}`, keyboard());
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
    .filter((month) => /^\d{4}_\d{2}$/.test(String(month)))
    .sort((a, b) => a.localeCompare(b));

  const monthButtons = normalizedMonths.map((month) => {
    const [year, monthNumber] = String(month).split("_");
    return Markup.button.callback(`📊 ${monthNumber}/${year}`, `action:hermes_kpi_month:${month}`);
  });

  for (let i = 0; i < monthButtons.length; i += 3) {
    rows.push(monthButtons.slice(i, i + 3));
  }

  const homeButton = Markup.button.callback(buttonText("homeMain", "home"), "action:menu");
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
  
  const filled = "▰".repeat(activeSteps);
  const empty = "▱".repeat(totalSteps - activeSteps);
  const bar = `${filled}${empty}`;
  
  let icon = "🟢";
  if (percent < 80) {
    icon = "🔴";
  } else if (percent < 100) {
    icon = "🟡";
  } else if (percent >= 110) {
    icon = "💎"; // Bonus icon for high performance
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
  return Math.round(Number(value || 0)).toLocaleString("en-US") + " đ";
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
    ["POS (6)", item.deployPos, "🖥"],
    ["FABi (6)", item.deployFabi, "🥪"],
    ["CRM (3)", item.deployCrm, "👥"],
    ["BK (3)", item.deployBk, "📒"],
    ["Call (3)", item.deployCall, "📞"],
    ["WO (3)", item.deployWo, "🛠"],
    ["O2O (3)", item.deployO2o, "🌐"],
    ["Hub (1)", item.deployHub, "🔌"],
    ["HDDT (1.5)", item.deployHddt, "🧾"],
    ["FoodHub (1.5)", item.deployFoodHub, "🍱"],
    ["Triển khai thêm (3)", item.deployExtra, "➕"],
    ["Onsite TX (1.5)", item.onsiteTx, "🏠"],
    ["Onsite NT (3)", item.onsiteNt, "📍"],
    ["Bảo trì (3)", item.maintenance, "🔧"]
  ];

  const activeRows = allRows.filter(([, val]) => Number(val || 0) > 0);
  const dummyLink = "https://t.me/hermes_kpi";

  if (activeRows.length === 0) {
    return "✨ <b>SẢN LƯỢNG:</b> <i>Chưa có dữ liệu mới.</i>";
  }

  const lines = [
    "✨ <b>CHI TIẾT SẢN LƯỢNG</b>",
    ...activeRows.map(([label, val, icon]) => `${icon} ${label}: <a href="${dummyLink}"><b>${formatMetricValue(val)}</b></a>`)
  ];

  if (Number(item.supportCount || 0) > 0 || Number(item.missFactor || 0) > 0 || Number(item.rateFactor || 0) > 0 || Number(item.rateAiAvg || 0) > 0) {
    lines.push("", "⚙️ <b>VẬN HÀNH</b>");
    if (Number(item.supportCount || 0) > 0) lines.push(`☎️ Support Count: <a href="${dummyLink}"><b>${formatMetricValue(item.supportCount, 0)}</b></a>`);
    if (Number(item.missFactor || 0) > 0) lines.push(`📉 Hệ số nhỡ: <a href="${dummyLink}"><b>${formatMetricValue(item.missFactor, 2)}</b></a>`);
    if (Number(item.rateFactor || 0) > 0) lines.push(`⭐ Hệ số Rate: <a href="${dummyLink}"><b>${formatMetricValue(item.rateFactor, 2)}</b></a>`);
    if (Number(item.rateAiAvg || 0) > 0) lines.push(`🤖 Rate AI Avg: <a href="${dummyLink}"><b>${formatMetricValue(item.rateAiAvg, 4)}</b></a>`);
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
    "💎 <b>BÁO CÁO HIỆU SUẤT - KPI</b>",
    `📅 <b>Giai đoạn:</b> <code>THÁNG ${monthLabel}</code>`,
    "━━━━━━━━━━━━━━━━━━━━",
    `👤 <b>Hội viên:</b> <code>${escapeHtml(item.support)}</code>`,
    "",
    "📊 <b>BẢNG TỔNG HỢP HIỆU SUẤT</b>",
    formatKpiBar("HOTLINE", item.hotlinePct),
    "",
    formatKpiBar("TRIỂN KHAI", item.deployPct),
    "",
    formatKpiBar("KPI TỔNG", item.kpiSum),
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "💰 <b>THU NHẬP ƯỚC TÍNH (POINTS)</b>",
    `💵 Point Thực tế: <a href="${dummyLink}"><b>${formatMetricValue(item.pointActual)}</b></a>`,
    `🎁 Point Thưởng: <a href="${dummyLink}"><b>${formatMetricValue(item.pointBonus)}</b></a>`,
    `• <b>TỔNG CỘNG:</b> <a href="${dummyLink}"><b>${formatMetricValue(item.pointSalary)}</b></a>`,
    "",
    `👥 Tổng point đội: <a href="${dummyLink}"><b>${formatMetricValue(adjustedTeamTotalPoint)}</b></a>`,
    `➕ Suất mặc định khác: <a href="${dummyLink}"><b>6.9%</b></a>`,
    `📈 Tỷ lệ cá nhân: <a href="${dummyLink}"><b>${(personalRatio * 100).toFixed(1)}%</b></a>`,
    `💰 Doanh thu phòng: <a href="${dummyLink}"><b>${escapeHtml(item.roomRevenue || "---")}</b></a>`,
    `⚖️ Hệ số phân bổ nhóm (tạm tính): <a href="${dummyLink}"><b>50.6%</b></a>`,
    `💵 Doanh thu phân bổ cá nhân (tạm tính): <a href="${dummyLink}"><b>${formatMoneyValue(personalRevenue)}</b></a>`,
    "━━━━━━━━━━━━━━━━━━━━",
    formatWorkloadTable(item),
    "",
    "<i>Hãy tiếp tục duy trì phong độ xuất sắc nhé! 🚀✨</i>"
  ].join("\n");
}

async function showKpiSummary(ctx) {
  const loadingMessageId = await sendTempMessage(ctx, "Đang kiểm tra thông tin KPI...");
  try {
    const result = await enqueue(() => getKpiSummary());
    if (!result?.ok) {
      await replyFresh(ctx, `Không tải được KPI.\n${String(result?.message || "Lỗi không xác định").slice(0, 700)}`, keyboard());
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
  const loadingMessageId = await sendTempMessage(ctx, `Đang kiểm tra thông tin KPI ${String(month || "").replace("_", "/")}...`);
  try {
    const account = await getHermesAccountOrReply(ctx);
    if (!account) return;
    const result = await enqueue(() => getKpiSummary(month));
    if (!result?.ok) {
      await ctx.reply(`Không tải được KPI.\n${String(result?.message || "Lỗi không xác định").slice(0, 700)}`, keyboard());
      return;
    }
    const monthData = (result.monthly || []).find((item) => item.month === month);
    if (!monthData) {
      await ctx.reply(`Không tìm thấy sheet KPI tháng ${month}.`, keyboard());
      return;
    }
    const item = (monthData.records || []).find((row) => {
      const support = String(row.support || "").trim().toLowerCase();
      const user = String(account.hermesUsername || "").trim().toLowerCase();
      return support === user || support === `${user}@ipos.vn` || user === `${support}@ipos.vn`;
    });
    if (!item) {
      await ctx.reply(`Không tìm thấy KPI của tài khoản ${account.hermesUsername} trong sheet ${month}.`, keyboard());
      return;
    }

    const revenueResult = await enqueue(() => getHermesRoomRevenue({
      username: account.hermesUsername,
      password: account.hermesPassword,
      storageState: account.hermesSession,
      month
    }));
    item.roomRevenue = revenueResult.ok ? revenueResult.value : "Đang cập nhật...";

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
    await replyFresh(ctx, `Không tải được lịch trực Google Sheet.\n${String(error.message || error).slice(0, 700)}`, dutyKeyboard(date));
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
    parts.push(formatDutyScheduleHtml(result, viewerName, {
      viewerAccount,
      includeDetailLinks: offset === 6,
      linkPeople: true,
      weekView: true
    }));
  }
  await replyFresh(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...dutyKeyboard(date)
  });
}

async function showTodayDashboard(ctx) {
  const loadingMessageId = await sendTempMessage(ctx, "🚀 <b>Đang chuẩn bị Dashboard hôm nay...</b>\n<i>Em đang gom lịch trực, lịch Hermes và KPI cho Sếp. Đợi em một xíu nhé!</i>", { parse_mode: "HTML" });
  
  const date = new Date();
  const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
  const viewerName = account?.fullName || account?.username || `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();

  const sections = [
    "🚀 <b>DASHBOARD TỔNG HỢP HÔM NAY</b>",
    `📅 Ngày: <code>${new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date)}</code>`,
    "━━━━━━━━━━━━━━━━━━━━",
    ""
  ];

  try {
    const duty = await fetchDutyScheduleByDate(date);
    sections.push("📋 <b>Lịch trực</b>");
    // Lấy nội dung lịch trực nhưng bỏ bớt header rườm rà
    const dutyText = formatDutyScheduleHtml(duty, viewerName);
    const dutyBody = dutyText.split("━━━━━━━━━━━━━━━━━━━━").pop().trim();
    sections.push(dutyBody || "📭 Không có dữ liệu lịch trực.");
  } catch (error) {
    sections.push("📋 <b>Lịch trực</b>");
    sections.push("❌ Lỗi tải lịch trực Google Sheet.");
  }

  if (account?.hermesUsername) {
    sections.push("", "━━━━━━━━━━━━━━━━━━━━");
    sections.push("🗓️ <b>Lịch làm việc</b>");
    
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
      // Lấy nội dung lịch làm việc, bỏ header rườm rà
      const workText = formatWorkScheduleResult(work);
      const workBody = workText.split("________________________________").pop().trim();
      sections.push(workBody || "✨ Hôm nay Sếp thong dong, chưa thấy lịch hỗ trợ nào.");
    } else {
      sections.push(`❌ Không lấy được lịch: ${work.message || "Lỗi Hermes"}`);
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
        row.roomRevenue = revenueResult.ok ? revenueResult.value : "Đang cập nhật...";

        sections.push("", "━━━━━━━━━━━━━━━━━━━━");
        sections.push("🎯 <b>KPI TỔNG HỢP</b>");
        const kpiText = formatKpiMonthTelegramHtml(monthData, row);
        const kpiParts = kpiText.split("━━━━━━━━━━━━━━━━━━━━");
        const kpiBody = kpiParts.slice(2, 4).join("━━━━━━━━━━━━━━━━━━━━").trim();
        sections.push(kpiBody || kpiText);
      }
      }
  }

  sections.push("", "━━━━━━━━━━━━━━━━━━━━");
  sections.push("<i>Chúc Sếp một ngày làm việc rực rỡ! 🚀✨</i>");

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
    "🚀 <b>DASHBOARD TỔNG HỢP HÔM NAY</b>",
    `📅 Ngày: <code>${new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(date)}</code>`,
    "━━━━━━━━━━━━━━━━━━━━",
    ""
  ];

  try {
    const duty = await fetchDutyScheduleByDate(date);
    sections.push("📋 <b>Lịch trực</b>");
    const dutyText = formatDutyScheduleHtml(duty, viewerName);
    const dutyBody = dutyText.split("━━━━━━━━━━━━━━━━━━━━").pop().trim();
    sections.push(dutyBody || "📭 Không có dữ liệu lịch trực.");
  } catch (error) {
    sections.push("📋 <b>Lịch trực</b>");
    sections.push("❌ Lỗi tải lịch trực Google Sheet.");
  }

  if (account?.hermesUsername) {
    sections.push("", "━━━━━━━━━━━━━━━━━━━━");
    sections.push("🗓️ <b>Lịch làm việc</b>");

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
      sections.push(workBody || "✨ Hôm nay Sếp thong dong, chưa thấy lịch hỗ trợ nào.");
    } else {
      sections.push(`❌ Không lấy được lịch: ${work.message || "Lỗi Hermes"}`);
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
        row.roomRevenue = revenueResult.ok ? revenueResult.value : "Đang cập nhật...";

        sections.push("", "━━━━━━━━━━━━━━━━━━━━");
        sections.push("🎯 <b>KPI TỔNG HỢP</b>");
        const kpiText = formatKpiMonthTelegramHtml(monthData, row);
        const kpiParts = kpiText.split("━━━━━━━━━━━━━━━━━━━━");
        const kpiBody = kpiParts.slice(2, 4).join("━━━━━━━━━━━━━━━━━━━━").trim();
        sections.push(kpiBody || kpiText);
      }
    }
  }

  sections.push("", "━━━━━━━━━━━━━━━━━━━━");
  sections.push("<i>Chúc Sếp một ngày làm việc rực rỡ! 🚀✨</i>");
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
  const parts = new Intl.DateTimeFormat("en-CA", {
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
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour !== 8 || minute > 5) return null;
  return `${parts.year}-${parts.month}-${parts.day}-08-dashboard`;
}

async function checkDashboardReminder() {
  const now = new Date();
  const key = getDashboardReminderMoment(now);
  console.log(`[Auto-Cron] Dashboard check at ${now.toLocaleTimeString("vi-VN", { timeZone: config.timezoneId })}`);
  if (!key || sentDashboardReminderKeys.has(key)) return;
  sentDashboardReminderKeys.add(key);
  await notifyTodayDashboard();
}
async function showWorkScheduleWeek(ctx, date = new Date()) {
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;

  const loadingMessageId = await sendTempMessage(ctx, "Đang kiểm tra lịch cả tuần Hermes...");
  try {
    let storageState = account.hermesSession || null;
    const mondayDate = getRelativeWorkScheduleDate(-(new Date(date).getDay() || 7) + 1, date);
    
    const result = await enqueue(() => getWorkScheduleByDay({
      username: account.hermesUsername,
      password: account.hermesPassword,
      date: mondayDate,
      storageState,
      fetchFullWeek: true
    }));

    if (result.sessionExpired) await clearHermesSession(ctx.chat.id);
    if (result.otpRequired) {
      pendingActions.set(ctx.chat.id, { stage: "hermes_schedule_otp", date: mondayDate });
      await replyFresh(ctx, "Hermes yêu cầu OTP giữa lúc lấy lịch tuần. Sếp gửi mã OTP mới nhất rồi bấm lại giúp em. /cancel để huỷ.");
      return;
    }
    if (!result.ok) {
      await replyFresh(ctx, `Không lấy được lịch tuần.\n${String(result.message || "Lỗi không xác định").slice(0, 700)}`, keyboard());
      return;
    }
    if (result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }

    const results = result.weekResults || [result];

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
  await ctx.reply(`Telegram ID của Sếp: ${getTelegramId(ctx)}`);
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

bot.command("cancel", async (ctx) => {
  const pending = pendingActions.get(ctx.chat.id);
  if (pending?.stage === "hermes_otp" || pending?.stage === "hermes_schedule_otp") {
    await cancelHermesOtpSession();
  }
  pendingActions.delete(ctx.chat.id);
  await ctx.reply("Đã huỷ thao tác đang đợi.", Markup.removeKeyboard());
});

bot.command("deletehermes", async (ctx) => {
  const removed = await deleteHermesAccount(ctx.chat.id);
  pendingActions.delete(ctx.chat.id);
  await ctx.reply(removed ? "Đã xoá tài khoản Hermes đã lưu." : "Không tìm thấy tài khoản Hermes để xoá.");
});

bot.command("sethermes", async (ctx) => {
  const message = ctx.message.text.trim();
  const parts = message.split(/\s+/);
  if (parts.length < 3) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_credentials" });
    await ctx.reply([
      "Nhập user và password Hermes trong tin nhắn tiếp theo.",
      "Mẫu:",
      "username Abc123@"
    ].join("\n"));
    return;
  }
  const hermesUsername = parts[1];
  const hermesPassword = parts.slice(2).join(" ");
  await saveHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id, telegramUser: ctx.from, hermesUsername, hermesPassword });
  await ctx.reply(`Đã lưu tài khoản Hermes cho ${hermesUsername}. Đang test đăng nhập...`);
  const result = await enqueue(() => validateHermesLogin({ username: hermesUsername, password: hermesPassword, keepOtpSession: true }));
  if (result.otpRequired) {
    pendingActions.set(ctx.chat.id, { stage: "hermes_otp" });
    await ctx.reply("Hermes đang yêu cầu OTP. Sếp gửi mã OTP vào tin nhắn tiếp theo nhé. /cancel để huỷ.");
    return;
  }
  await ctx.reply(result.ok ? result.message : `Lưu rồi nhưng test Hermes lỗi: ${result.message}`, keyboard());
});

bot.command("today", async (ctx) => {
  await showTodayDashboard(ctx);
});

bot.command("truc", async (ctx) => {
  const date = parseScheduleCommandDate(ctx.message.text);
  if (!date) {
    await ctx.reply([
      "Ngày không hợp lệ Sếp.",
      "Mẫu dùng:",
      "/truc",
      "/truc hôm nay",
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
  const reasonLabel = isTomorrow ? "TEST - 17:00 - lịch trực ngày mai" : "TEST - lịch trực hôm nay";
  const loading = await sendTempMessage(ctx, "Đang test thông báo lịch trực...");
  try {
    const result = await fetchDutyScheduleByDate(targetDate);
    const accounts = await getAllHermesAccounts({ secret: config.botSecretKey });
    const mentionLines = formatDutyMatchedMentions(result, accounts);
    const mentionSection = mentionLines.length ? ["✅ <b>BẠN CÓ LỊCH TRỰC</b>", ...mentionLines] : [];
    const dateLabel = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: config.timezoneId }).format(targetDate);
    const textMessage = [
      "🔔 <b>TEST NHẮC LỊCH TRỰC</b>",
      "⏰ <b>Mốc nhắc:</b> " + escapeHtml(reasonLabel),
      "📅 <b>Ngày trực:</b> <code>" + escapeHtml(dateLabel) + "</code>",
      "━━━━━━━━━━━━━━━━━━━━",
      formatDutyScheduleHtml(result, "", { includePersonalSection: false }),
      "━━━━━━━━━━━━━━━━━━━━",
      ...mentionSection
    ].join("\n");
    await ctx.reply(textMessage, { parse_mode: "HTML", disable_web_page_preview: true });
  } finally {
    await deleteTempMessage(ctx, loading);
  }
});


bot.command("testauto", async (ctx) => {
  await ctx.reply(statusText("test", TEXT.testAuto.start));
  try {
    await notifyDutyScheduleForDate(new Date(), TEXT.testAuto.reason);
    await notifyTodayDashboard();
    await ctx.reply(statusText("success", TEXT.testAuto.success));
  } catch (error) {
    await ctx.reply(`${statusText("error", TEXT.testAuto.failurePrefix)}: ${error.message}`);
  }
});

bot.command("testnotify", async (ctx) => {
  const loading = await sendTempMessage(ctx, "Đang test thông báo Hermes...");
  try {
    const account = await getHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id });
    if (!account?.hermesUsername || !account?.hermesPassword) {
      await ctx.reply("Anh chưa lưu tài khoản Hermes. Dùng /sethermes trước nhé.");
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
      await ctx.reply(`Không tải được thông báo Hermes.\n${String(result.message || "Lỗi không xác định").slice(0, 700)}`);
      return;
    }

    const notification = (result.notifications || [])[0];
    if (!notification) {
      await ctx.reply("Hiện chưa đọc được thông báo thay đổi trạng thái phiếu nào từ Hermes.");
      return;
    }

    await ctx.reply([
      `${ICON.test} <b>${TEXT.testNotify.title}</b>`,
      TEXT.testNotify.latest,
      ""
    ].join("\n"), { parse_mode: "HTML" });
    await ctx.reply(formatHermesNotificationHtml(notification), {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...Markup.inlineKeyboard([
        [
          ...(notification.requestOrderId ? [Markup.button.callback(buttonText("detailView", "eye"), `action:view_request_order:${notification.requestOrderId}`)] : []),
          Markup.button.callback(buttonText("home", "home"), "action:menu")
        ]
      ])
    });
  } catch (error) {
    console.error("Test Hermes notification failed:", error);
    await ctx.reply(`${TEXT.testNotify.failurePrefix}.\n${String(error.message || error).slice(0, 700)}`);

  } finally {
    await deleteTempMessage(ctx, loading);
  }
});
bot.command(["lich", "schedule", "workschedule"], async (ctx) => {
  const date = parseScheduleCommandDate(ctx.message.text);
  if (!date) {
    await ctx.reply([
      "Ngày không hợp lệ Sếp.",
      "Mẫu dùng:",
      "/lich",
      "/lich hôm nay",
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
    ? `🔐 <b>Tài khoản Hermes</b>\nĐang lưu: <b>${escapeHtml(account.hermesUsername)}</b>`
    : "🔐 <b>Tài khoản Hermes</b>\nChưa lưu tài khoản.";
  await replyFresh(ctx, summary, {
    parse_mode: "HTML",
    ...accountMenuKeyboard()
  });
});

bot.action("action:hermes_work", async (ctx) => {
  await ctx.answerCbQuery("Đang lấy lịch hôm nay...");
  await showWorkSchedule(ctx, new Date());
});

bot.action(/^action:hermes_work_offset:(-?\d+)$/, async (ctx) => {
  const offset = Number(ctx.match?.[1] || 0);
  await ctx.answerCbQuery("Đang lấy lịch...");
  await showWorkSchedule(ctx, getRelativeWorkScheduleDate(offset));
});

bot.action(/^action:hermes_work_date:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
  const baseDate = parseWorkScheduleDateInput(ctx.match?.[1]);
  const offset = Number(ctx.match?.[2] || 0);
  await ctx.answerCbQuery("Đang lấy lịch...");
  await showWorkSchedule(ctx, getRelativeWorkScheduleDate(offset, baseDate || new Date()));
});

bot.action("action:today_dashboard", async (ctx) => {
  await ctx.answerCbQuery("Đang ghép dashboard hôm nay...");
  await showTodayDashboard(ctx);
});

bot.action("action:duty_today", async (ctx) => {
  await ctx.answerCbQuery("Đang lấy lịch trực...");
  await showDutySchedule(ctx, new Date());
});

bot.action(/^action:duty_date:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
  const baseDate = parseWorkScheduleDateInput(ctx.match?.[1]);
  const offset = Number(ctx.match?.[2] || 0);
  await ctx.answerCbQuery("Đang lấy lịch trực...");
  await showDutySchedule(ctx, getRelativeWorkScheduleDate(offset, baseDate || new Date()));
});

bot.action(/^action:duty_week:?(\d{4}-\d{2}-\d{2})?$/, async (ctx) => {
  const dateStr = ctx.match?.[1];
  const date = dateStr ? parseWorkScheduleDateInput(dateStr) : new Date();
  await ctx.answerCbQuery("Đang lấy lịch trực cả tuần...");
  await showDutyScheduleWeek(ctx, date);
});

bot.action("action:duty_other", async (ctx) => {
  await ctx.answerCbQuery();
  await askDutyOtherDate(ctx);
});

bot.action(/^action:hermes_work_week:?(\d{4}-\d{2}-\d{2})?$/, async (ctx) => {
  const dateStr = ctx.match?.[1];
  const date = dateStr ? parseWorkScheduleDateInput(dateStr) : new Date();
  await ctx.answerCbQuery("Đang lấy lịch cả tuần...");
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
    await replyFresh(ctx, `Đang lưu tài khoản Hermes: ${account.hermesUsername}\nMuốn đổi thì gửi /sethermes.`, accountMenuKeyboard());
    return;
  }
  pendingActions.set(ctx.chat.id, { stage: "hermes_credentials" });
  await replyFresh(ctx, [
    "Chưa lưu tài khoản Hermes.",
    "Gửi user và password Hermes trong tin nhắn tiếp theo.",
    "Mẫu:",
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
  const removed = await deleteHermesAccount(ctx.chat.id);
  pendingActions.delete(ctx.chat.id);
  await replyFresh(ctx, removed ? "Đã xoá tài khoản Hermes đã lưu." : "Không tìm thấy tài khoản Hermes để xoá.", keyboard());
});

bot.action(/^action:hermes_work_detail:(.+):(\d+)$/, async (ctx) => {
  const cacheKey = ctx.match?.[1];
  const index = Number(ctx.match?.[2] || 0);
  const cached = workScheduleCache.get(cacheKey);
  await ctx.answerCbQuery();
  if (!cached) {
    await replyFresh(ctx, "Dữ liệu lịch đã hết hạn. Sếp bấm lấy lịch lại nhé.", keyboard());
    return;
  }
  const entry = cached.result.entries?.[index];
  if (!entry) {
    await replyFresh(ctx, "Không tìm thấy mục lịch này. Sếp bấm lấy lịch lại nhé.", workScheduleKeyboard(cached.result, cacheKey));
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
  const loadingMessageId = await sendTempMessage(ctx, "Đang lấy chi tiết PYC thật từ Hermes...");
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
    await replyFresh(ctx, "Phiên Hermes đã hết hạn nên Hermes yêu cầu OTP lại. Sếp gửi mã OTP mới nhất rồi bấm lịch lại nhé. /cancel để huỷ.");
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
    await ctx.answerCbQuery("Không lấy được mã phiếu.");
    return;
  }
  await ctx.answerCbQuery();
  const account = await getHermesAccountOrReply(ctx);
  if (!account) return;
  const loadingMessageId = await sendTempMessage(ctx, "Đang lấy chi tiết phiếu từ Hermes...");
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
    await replyFresh(ctx, "Phiên Hermes đã hết hạn nên Hermes yêu cầu OTP lại. Sếp gửi mã OTP mới nhất rồi bấm xem lại nhé. /cancel để huỷ.");
    return;
  }
  if (!detail.ok) {
    await replyFresh(ctx, `Không tải được chi tiết phiếu.\n${detail.message || "Lỗi Hermes"}`, keyboard());
    return;
  }
  if (detail.storageState) {
    await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: detail.storageState });
  }
  await replyFresh(ctx, formatRequestOrderDetailHtml(detail.order, { checkedAt: detail.checkedAt }), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([[Markup.button.callback(buttonText("homeMain", "home"), "action:menu")]])
  });
});
bot.action(/^action:hermes_work_list:(.+)$/, async (ctx) => {
  const cacheKey = ctx.match?.[1];
  const cached = workScheduleCache.get(cacheKey);
  await ctx.answerCbQuery();
  if (!cached) {
    await replyFresh(ctx, "Dữ liệu lịch đã hết hạn. Sếp bấm lấy lịch lại nhé.", keyboard());
    return;
  }
  await replyFresh(ctx, formatWorkScheduleResult(cached.result), {
    parse_mode: "HTML",
    ...workScheduleKeyboard(cached.result, cacheKey)
  });
});

bot.on("text", async (ctx) => {
  const text = (ctx.message?.text || "").trim();

  const pending = pendingActions.get(ctx.chat.id);
  if (!pending) {
    await ctx.reply("Em chưa hiểu lệnh này. Gửi /lich hoặc /menu nhé Sếp.", keyboard());
    return;
  }

  if (pending.stage === "hermes_otp") {
    const otp = ctx.message.text.trim();
    const loadingMessageId = await sendTempMessage(ctx, "Đang xác nhận OTP Hermes...");
    const result = await enqueue(() => submitHermesOtp(otp));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      await replyFresh(ctx, result.message);
      return;
    }
    pendingActions.delete(ctx.chat.id);
    if (!result.ok) {
      await replyFresh(ctx, `Xác nhận OTP lỗi: ${result.message}`, keyboard());
      return;
    }
    if (result.storageState) await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    await replyFresh(ctx, result.message, keyboard());
    return;
  }

  if (pending.stage === "duty_schedule_date") {
    const date = parseWorkScheduleDateInput(text);
    if (!date) {
      await ctx.reply("Ngày chưa đúng định dạng rồi Sếp. Ví dụ: 29/04, 29/04/2026, hôm nay, mai.");
      return;
    }
    pendingActions.delete(ctx.chat.id);
    await showDutySchedule(ctx, date);
    return;
  }

  if (pending.stage === "hermes_schedule_otp") {
    const otp = ctx.message.text.trim();
    const loadingMessageId = await sendTempMessage(ctx, "Đang xác nhận OTP Hermes và lấy lịch...");
    const result = await enqueue(() => submitHermesOtpAndGetWorkSchedule(otp, pending.date || new Date()));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      await replyFresh(ctx, result.message);
      return;
    }
    pendingActions.delete(ctx.chat.id);
    if (!result.ok) {
      await replyFresh(ctx, `Xác nhận OTP/lấy lịch lỗi: ${result.message}`, keyboard());
      return;
    }
    if (result.storageState) await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
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
      await ctx.reply("Ngày không hợp lệ Sếp. Gửi theo mẫu 28/04 hoặc 28/04/2026, hoặc /cancel để huỷ.");
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
        "Chưa đúng mẫu nhập.",
        "Gửi lại user và password Hermes trên cùng 1 dòng.",
        "Ví dụ:",
        "username Abc123@"
      ].join("\n"));
      return;
    }
    const hermesUsername = parts[0];
    const hermesPassword = parts.slice(1).join(" ");
    await saveHermesAccount({ secret: config.botSecretKey, chatId: ctx.chat.id, telegramUser: ctx.from, hermesUsername, hermesPassword });
    pendingActions.delete(ctx.chat.id);
    const loadingMessageId = await sendTempMessage(ctx, `Đã lưu tài khoản Hermes cho ${hermesUsername}. Đang test đăng nhập...`);
    const result = await enqueue(() => validateHermesLogin({ username: hermesUsername, password: hermesPassword, keepOtpSession: true }));
    await deleteTempMessage(ctx, loadingMessageId);
    if (result.otpRequired) {
      pendingActions.set(ctx.chat.id, { stage: "hermes_otp" });
      await replyFresh(ctx, "Hermes đang yêu cầu OTP. Sếp gửi mã OTP vào tin nhắn tiếp theo nhé. /cancel để huỷ.");
      return;
    }
    if (result.ok && result.storageState) {
      await saveHermesSession({ secret: config.botSecretKey, chatId: ctx.chat.id, storageState: result.storageState });
    }
    await replyFresh(ctx, result.ok ? result.message : `Lưu rồi nhưng test Hermes lỗi: ${result.message}`, keyboard());
  }
});

bot.catch((error, ctx) => {
  console.error("Hermes schedule bot error:", error);
  import("fs").then(m => m.appendFileSync("hermes_error_trace.txt", new Date().toISOString() + "\n" + (error.stack || error) + "\n\n"));
  if (ctx?.reply) ctx.reply("Bot lịch Hermes gặp lỗi ngoài dự kiến. Xem log để biết chi tiết.").catch(() => {});
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
    RO_CHANGE_STATUS: "Thay đổi trạng thái phiếu",
    RO_CREATE: "Tạo phiếu mới",
    RO_ASSIGN: "Được phân công xử lý",
    RO_COMMENT: "Có bình luận mới",
    RO_REMIND: "Nhắc xử lý phiếu",
    RO_CHANGE_PROCESSOR: "Thay đổi người xử lý"
  };
  return map[raw] || raw || "Có cập nhật";
}

function formatHermesNotificationHtml(notification = {}) {
  const title = cleanHermesNotifyText(notification.title || "Thông báo Hermes");
  const rawTicket = notification.ticketCode || notification.requestOrderId || "Chưa rõ";
  const link = notification.link || (notification.requestOrderId ? `https://hermes.ipos.vn/request-order/${notification.requestOrderId}` : "");
  const ticketDisplay = link ? `<a href="${escapeHtml(link)}">${escapeHtml(rawTicket)}</a>` : `<code>${escapeHtml(rawTicket)}</code>`;
  const status = formatHermesStatus(notification.status);
  const message = cleanHermesNotifyText(notification.message || "");
  return [
    "🔔 <b>THÔNG BÁO HERMES</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `📌 <b>Nội dung:</b> ${escapeHtml(title)}`,
    `🎫 <b>Phiếu yêu cầu:</b> ${ticketDisplay}`,
    `🔄 <b>Trạng thái:</b> ${escapeHtml(status)}`,
    message ? `📝 <b>Chi tiết:</b>\n${escapeHtml(message).slice(0, 1200)}` : "",
    "━━━━━━━━━━━━━━━━━━━━",
    "Anh bấm nút bên dưới để xem chi tiết phiếu yêu cầu."
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
              ...(notification.requestOrderId ? [Markup.button.callback(buttonText("detailView", "eye"), `action:view_request_order:${notification.requestOrderId}`)] : []),
              Markup.button.callback(buttonText("home", "home"), "action:menu")
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
        "⚠️ <b>THÔNG BÁO: PHIÊN HERMES HẾT HẠN</b>",
        "",
        `Tài khoản <b>${account.hermesUsername}</b> của Sếp đã hết hạn đăng nhập trên Hermes.`,
        "Để đảm bảo dữ liệu Lịch làm việc và Doanh thu luôn sẵn sàng, Sếp hãy dùng lệnh /lich để đăng nhập lại nhé!",
        "",
        "<i>Bot sẽ tạm dừng cập nhật doanh thu cho đến khi có phiên mới.</i>"
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
      await notifyAllowedUsers("Bot lịch Hermes đã khởi động OK.");
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
    setInterval(
      () => checkGithubUpdateNotification().catch(console.error),
      Math.max(config.githubVersionCheckIntervalMinutes, 5) * 60 * 1000
    );
    checkGithubUpdateNotification().catch(console.error);
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











