import { appVersion } from "./version.js";

function parseVersion(version) {
  return String(version || "0.0.0")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0)
    .slice(0, 3);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

export async function fetchRemotePackageVersion(packageUrl) {
  const response = await fetch(packageUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GitHub package check failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  return String(data.version || "").trim();
}

export async function checkGithubVersion(packageUrl) {
  const remoteVersion = await fetchRemotePackageVersion(packageUrl);
  const hasNewVersion = compareVersions(remoteVersion, appVersion) > 0;
  return {
    localVersion: appVersion,
    remoteVersion,
    hasNewVersion
  };
}
