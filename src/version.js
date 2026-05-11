import { readFileSync } from "node:fs";
import path from "node:path";

function readPackageVersion() {
  try {
    const packagePath = path.resolve("package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    return String(packageJson.version || "1.0.0");
  } catch {
    return "1.0.0";
  }
}

export const appVersion = readPackageVersion();
export const appName = "Hermes Bot";
export const appVersionLabel = `${appName} v${appVersion}`;
