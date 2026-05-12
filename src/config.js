import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toInteger(value, fallback) {
  return Math.max(0, Math.trunc(toNumber(value, fallback)));
}

function normalizePath(input, fallback) {
  const value = input?.trim() || fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeTransport(value) {
  const transport = (value || "http").trim().toLowerCase();
  return transport === "browser" ? "browser" : "http";
}

const baseUrl = (process.env.IHR_BASE_URL || "https://ihr.ipos.vn").trim().replace(/\/+$/, "");
const loginPath = normalizePath(process.env.IHR_LOGIN_PATH, "/System/Login");
const checkInPath = normalizePath(process.env.IHR_CHECKIN_PATH, "/Hrm/CheckInOut_Online");
const hermesBaseUrl = (process.env.HERMES_BASE_URL || "").trim().replace(/\/+$/, "");
const hermesLoginPath = normalizePath(process.env.HERMES_LOGIN_PATH, "/System/Login");
const hermesOtpTimeoutMs = toNumber(process.env.HERMES_OTP_TIMEOUT_MS, 180000);

const allowedIds = (process.env.ALLOWED_TELEGRAM_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const allowedGroupIds = (process.env.ALLOWED_TELEGRAM_GROUP_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const lat = process.env.IHR_GEO_LAT?.trim();
const lng = process.env.IHR_GEO_LNG?.trim();
const hasGeo = lat !== undefined && lat !== "" && lng !== undefined && lng !== "";
const machineName =
  (process.env.BOT_MACHINE_NAME || "").trim() ||
  process.env.COMPUTERNAME ||
  process.env.HOSTNAME ||
  "Unknown machine";

const wgTunnelName = (process.env.WG_TUNNEL_NAME || "").trim();
const wgConfPath = (process.env.WG_CONF_PATH || "").trim();
const defaultGithubPackageUrl = "https://raw.githubusercontent.com/trinhduc-lnqt/Ihr_hermes/main/hermes_bot/package.json";

export const config = {
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  botSecretKey: (process.env.BOT_SECRET_KEY || "").trim(),
  machineName,
  wgTunnelName,
  wgConfPath,
  allowedIds,
  allowedGroupIds,
  allowedIdsFile: path.resolve(process.env.ALLOWED_TELEGRAM_IDS_FILE || "data/allowed-telegram-ids.txt"),
  headless: toBoolean(process.env.HEADLESS, true),
  timeoutMs: toNumber(process.env.ACTION_TIMEOUT_MS, 45000),
  transport: normalizeTransport(process.env.IHR_TRANSPORT),
  startupNotify: toBoolean(process.env.STARTUP_NOTIFY, true),
  enableHermes: toBoolean(process.env.ENABLE_HERMES, true),
  ihrStatusCheckIntervalMinutes: toInteger(process.env.IHR_STATUS_CHECK_INTERVAL_MINUTES, 5),
  salaryCheckIntervalMinutes: toInteger(process.env.SALARY_CHECK_INTERVAL_MINUTES, 30),
  salaryNotifyCloseDay: toInteger(process.env.SALARY_NOTIFY_CLOSE_DAY, 10),
  heartbeatUrl: (process.env.HEARTBEAT_URL || "").trim(),
  heartbeatIntervalMinutes: toInteger(process.env.HEARTBEAT_INTERVAL_MINUTES, 5),
  githubVersionCheckEnabled: toBoolean(process.env.GITHUB_VERSION_CHECK_ENABLED, true),
  githubPackageUrl: (process.env.GITHUB_PACKAGE_URL || defaultGithubPackageUrl).trim(),
  githubVersionCheckIntervalMinutes: toInteger(process.env.GITHUB_VERSION_CHECK_INTERVAL_MINUTES, 30),
  lockPort: toInteger(process.env.BOT_LOCK_PORT, 47831),
  locale: (process.env.IHR_LOCALE || "vi-VN").trim(),
  timezoneId: (process.env.IHR_TIMEZONE || "Asia/Ho_Chi_Minh").trim(),
  loginUrl: `${baseUrl}${loginPath}`,
  checkInUrl: `${baseUrl}${checkInPath}`,
  baseUrl,
  hermesBaseUrl,
  hermesLoginUrl: hermesBaseUrl ? `${hermesBaseUrl}${hermesLoginPath}` : "",
  hermesOtpTimeoutMs,
  geo: hasGeo
    ? {
        latitude: Number(lat),
        longitude: Number(lng)
      }
    : null
};

export function assertBotConfig() {
  if (!config.telegramToken) {
    throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  }
  if (!config.botSecretKey) {
    throw new Error("Missing required environment variable: BOT_SECRET_KEY");
  }
}
