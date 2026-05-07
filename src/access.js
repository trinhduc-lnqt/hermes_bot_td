import { readFile } from "node:fs/promises";

import { config } from "./config.js";

function normalizeIds(values) {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

async function readIdsFromFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getAllowedTelegramIds() {
  const envIds = normalizeIds(config.allowedIds);
  const fileIds = normalizeIds(await readIdsFromFile(config.allowedIdsFile));
  return new Set([...envIds, ...fileIds]);
}

export async function isAuthorizedTelegramId(telegramId) {
  if (telegramId === undefined || telegramId === null || telegramId === "") {
    return false;
  }
  const allowedIds = await getAllowedTelegramIds();
  return allowedIds.has(String(telegramId));
}
