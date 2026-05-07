import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { decryptText, encryptText } from "./crypto.js";

const dataDir = path.resolve("data");
const ihrUsersFile = path.join(dataDir, "users.json");
const hermesUsersFile = path.join(dataDir, "hermes-users.json");

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function loadRawData(filePath, defaultData = { users: {} }) {
  await ensureDataDir();
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultData;
    }
    throw error;
  }
}

async function saveRawData(filePath, data) {
  await ensureDataDir();
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function buildTelegramProfile({ chatId, telegramUser, existing = {} }) {
  return {
    chatId: String(chatId),
    telegramId: telegramUser?.id ? String(telegramUser.id) : existing.telegramId || null,
    telegramUsername: telegramUser?.username || existing.telegramUsername || null,
    telegramName: [telegramUser?.first_name, telegramUser?.last_name].filter(Boolean).join(" ") || existing.telegramName || null
  };
}

export async function saveUserAccount({ secret, chatId, telegramUser, ihrUsername, ihrPassword }) {
  const data = await loadRawData(ihrUsersFile);
  const now = new Date().toISOString();
  const existing = data.users[String(chatId)] || {};
  data.users[String(chatId)] = {
    ...existing,
    ...buildTelegramProfile({ chatId, telegramUser, existing }),
    ihrUsername,
    ihrPassword: encryptText(secret, ihrPassword),
    updatedAt: now,
    createdAt: existing.createdAt || now
  };
  await saveRawData(ihrUsersFile, data);
  return data.users[String(chatId)];
}

export async function saveHermesAccount({ secret, chatId, telegramUser, hermesUsername, hermesPassword }) {
  const data = await loadRawData(hermesUsersFile);
  const now = new Date().toISOString();
  const existing = data.users[String(chatId)] || {};
  data.users[String(chatId)] = {
    ...existing,
    ...buildTelegramProfile({ chatId, telegramUser, existing }),
    hermesUsername,
    hermesPassword: encryptText(secret, hermesPassword),
    updatedAt: now,
    createdAt: existing.createdAt || now
  };
  await saveRawData(hermesUsersFile, data);
  return data.users[String(chatId)];
}

export async function saveHermesSession({ secret, chatId, storageState, expiresAt = null }) {
  const data = await loadRawData(hermesUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  data.users[key].hermesSession = encryptText(secret, JSON.stringify(storageState || {}));
  data.users[key].hermesSessionSavedAt = new Date().toISOString();
  data.users[key].hermesSessionExpiresAt = expiresAt;
  
  // Clear notification state when session is renewed
  if (data.users[key].notificationState) {
    data.users[key].notificationState.hermesSessionExpired = false;
  }
  
  await saveRawData(hermesUsersFile, data);
  return true;
}

export async function clearHermesSession(chatId) {
  const data = await loadRawData(hermesUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  delete data.users[key].hermesSession;
  delete data.users[key].hermesSessionSavedAt;
  delete data.users[key].hermesSessionExpiresAt;
  await saveRawData(hermesUsersFile, data);
  return true;
}

export async function getUserAccount({ secret, chatId }) {
  const data = await loadRawData(ihrUsersFile);
  const record = data.users[String(chatId)];
  if (!record) {
    return null;
  }
  const { hermesUsername, hermesPassword, hermesUpdatedAt, ...ihrRecord } = record;
  return {
    ...ihrRecord,
    ihrPassword: record.ihrPassword ? decryptText(secret, record.ihrPassword) : ""
  };
}

export async function getHermesAccount({ secret, chatId }) {
  const data = await loadRawData(hermesUsersFile);
  const record = data.users[String(chatId)];
  if (!record) {
    return null;
  }
  const { ihrUsername, ihrPassword, salaryMonitorState, ...hermesRecord } = record;
  let hermesSession = null;
  if (record.hermesSession) {
    try {
      hermesSession = JSON.parse(decryptText(secret, record.hermesSession));
    } catch {
      hermesSession = null;
    }
  }
  return {
    ...hermesRecord,
    hermesPassword: record.hermesPassword ? decryptText(secret, record.hermesPassword) : "",
    hermesSession
  };
}

export async function deleteUserAccount(chatId) {
  const data = await loadRawData(ihrUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  delete data.users[key];
  await saveRawData(ihrUsersFile, data);
  return true;
}

export async function deleteHermesAccount(chatId) {
  const data = await loadRawData(hermesUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  delete data.users[key];
  await saveRawData(hermesUsersFile, data);
  return true;
}

export async function updateHermesNotificationState(chatId, state = {}) {
  const data = await loadRawData(hermesUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  data.users[key].notificationState = {
    ...(data.users[key].notificationState || {}),
    ...state,
    updatedAt: new Date().toISOString()
  };
  await saveRawData(hermesUsersFile, data);
  return true;
}

export async function updateSalaryMonitorState(chatId, monitorState = {}) {
  const data = await loadRawData(ihrUsersFile);
  const key = String(chatId);
  if (!data.users[key]) {
    return false;
  }
  data.users[key].salaryMonitorState = {
    ...(data.users[key].salaryMonitorState || {}),
    ...monitorState,
    updatedAt: new Date().toISOString()
  };
  await saveRawData(ihrUsersFile, data);
  return true;
}

export async function getAllUserAccounts({ secret }) {
  const data = await loadRawData(ihrUsersFile);
  return Object.values(data.users || {}).map((record) => {
    const { hermesUsername, hermesPassword, hermesUpdatedAt, ...ihrRecord } = record;
    return {
      ...ihrRecord,
      ihrPassword: record.ihrPassword ? decryptText(secret, record.ihrPassword) : ""
    };
  });
}

export async function getAllHermesAccounts({ secret }) {
  const data = await loadRawData(hermesUsersFile);
  return Object.values(data.users || {}).map((record) => {
    const { ihrUsername, ihrPassword, salaryMonitorState, ...hermesRecord } = record;
    let hermesSession = null;
    if (record.hermesSession) {
      try {
        hermesSession = JSON.parse(decryptText(secret, record.hermesSession));
      } catch {
        hermesSession = null;
      }
    }
    return {
      ...hermesRecord,
      hermesPassword: record.hermesPassword ? decryptText(secret, record.hermesPassword) : "",
      hermesSession
    };
  });
}
