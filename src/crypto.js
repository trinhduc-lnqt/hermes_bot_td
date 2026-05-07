import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getKey(secret) {
  return createHash("sha256").update(secret).digest();
}

export function encryptText(secret, plainText) {
  const iv = randomBytes(12);
  const key = getKey(secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptText(secret, payload) {
  const [ivB64, tagB64, dataB64] = String(payload || "").split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted payload");
  }
  const key = getKey(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
