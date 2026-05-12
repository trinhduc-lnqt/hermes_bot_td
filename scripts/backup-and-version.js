import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const backupRoot = path.join(rootDir, "backups");
const includeEntries = [
  ".env.example",
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "scripts",
  "src",
  "data/hermes-users.json.example"
];
const skipNames = new Set(["node_modules", ".git", "backups"]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function bumpPatch(version) {
  const parts = String(version || "1.0.0").split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 1;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] + 1 : 1;
  return `${major}.${minor}.${patch}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function copyRecursive(source, target) {
  if (!existsSync(source)) return;
  const stats = statSync(source);
  if (stats.isDirectory()) {
    ensureDir(target);
    for (const item of readdirSync(source)) {
      if (skipNames.has(item)) continue;
      copyRecursive(path.join(source, item), path.join(target, item));
    }
    return;
  }
  ensureDir(path.dirname(target));
  copyFileSync(source, target);
}

function createBackup({ oldVersion, newVersion }) {
  const dirName = `${timestamp()}_v${oldVersion}_to_v${newVersion}`;
  const backupDir = path.join(backupRoot, dirName);
  ensureDir(backupDir);
  for (const entry of includeEntries) {
    copyRecursive(path.join(rootDir, entry), path.join(backupDir, entry));
  }
  writeJson(path.join(backupDir, "version-manifest.json"), {
    oldVersion,
    newVersion,
    createdAt: new Date().toISOString(),
    source: "scripts/backup-and-version.js"
  });
  return backupDir;
}

function updatePackageVersion(newVersion) {
  const packagePath = path.join(rootDir, "package.json");
  const packageJson = readJson(packagePath);
  const oldVersion = packageJson.version || "1.0.0";
  packageJson.version = newVersion;
  writeJson(packagePath, packageJson);

  const lockPath = path.join(rootDir, "package-lock.json");
  if (existsSync(lockPath)) {
    const lockJson = readJson(lockPath);
    lockJson.version = newVersion;
    if (lockJson.packages?.[""]) {
      lockJson.packages[""].version = newVersion;
    }
    writeJson(lockPath, lockJson);
  }

  return oldVersion;
}

const backupOnly = process.argv.includes("--backup-only");
const versionArg = process.argv.find((arg) => /^\d+\.\d+\.\d+/.test(arg));
const packageJson = readJson(path.join(rootDir, "package.json"));
const oldVersion = packageJson.version || "1.0.0";
const newVersion = versionArg || bumpPatch(oldVersion);
const backupDir = createBackup({ oldVersion, newVersion });

if (!backupOnly) {
  updatePackageVersion(newVersion);
}

writeJson(path.join(rootDir, "version-manifest.json"), {
  oldVersion,
  newVersion: backupOnly ? oldVersion : newVersion,
  backupDir,
  backupOnly,
  updatedAt: new Date().toISOString()
});

console.log(`Backup created: ${backupDir}`);
console.log(backupOnly ? `Version unchanged: ${oldVersion}` : `Version bumped: ${oldVersion} -> ${newVersion}`);
