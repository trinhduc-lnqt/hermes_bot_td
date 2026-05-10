import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_LENGTH = 3500;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function trimOutput(value = "") {
  const text = String(value || "").trim();
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  return `${text.slice(0, MAX_OUTPUT_LENGTH)}\n...`; 
}

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: options.timeoutMs || 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      command: `${command} ${args.join(" ")}`,
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr)
    };
  } catch (error) {
    return {
      ok: false,
      command: `${command} ${args.join(" ")}`,
      stdout: trimOutput(error.stdout),
      stderr: trimOutput(error.stderr || error.message),
      code: error.code
    };
  }
}

function formatStep(result) {
  const status = result.ok ? "✅" : "❌";
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return [`${status} ${result.command}`, output ? `\n${output}` : ""].join("");
}

async function getCurrentBranch() {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 30000 });
  if (!result.ok) return null;
  return result.stdout.trim();
}

async function hasPackageLockChanged(beforeRevision, afterRevision) {
  if (!beforeRevision || !afterRevision || beforeRevision === afterRevision) return false;
  const result = await run("git", ["diff", "--name-only", `${beforeRevision}..${afterRevision}`], { timeoutMs: 30000 });
  if (!result.ok) return false;
  return result.stdout.split(/\r?\n/).some((file) => ["package.json", "package-lock.json"].includes(file.trim()));
}

export async function updateFromGitHub() {
  const steps = [];

  const status = await run("git", ["status", "--porcelain"], { timeoutMs: 30000 });
  steps.push(status);
  if (!status.ok) return { ok: false, changed: false, steps, message: "Không kiểm tra được trạng thái Git." };
  if (status.stdout.trim()) {
    return {
      ok: false,
      changed: false,
      steps,
      message: "Repo đang có thay đổi local chưa commit, em không tự pull để tránh ghi đè."
    };
  }

  const branch = await getCurrentBranch();
  if (!branch || branch === "HEAD") {
    return { ok: false, changed: false, steps, message: "Repo không đứng trên branch Git hợp lệ." };
  }

  const before = await run("git", ["rev-parse", "HEAD"], { timeoutMs: 30000 });
  steps.push(before);
  if (!before.ok) return { ok: false, changed: false, steps, message: "Không đọc được commit hiện tại." };

  const fetch = await run("git", ["fetch", "origin", branch], { timeoutMs: 120000 });
  steps.push(fetch);
  if (!fetch.ok) return { ok: false, changed: false, steps, message: "Fetch GitHub thất bại." };

  const remote = await run("git", ["rev-parse", `origin/${branch}`], { timeoutMs: 30000 });
  steps.push(remote);
  if (!remote.ok) return { ok: false, changed: false, steps, message: `Không tìm thấy origin/${branch}.` };

  const beforeRevision = before.stdout.trim();
  const remoteRevision = remote.stdout.trim();
  if (beforeRevision === remoteRevision) {
    return { ok: true, changed: false, branch, beforeRevision, afterRevision: beforeRevision, steps, message: "Bot đã ở bản mới nhất." };
  }

  const pull = await run("git", ["pull", "--ff-only", "origin", branch], { timeoutMs: 120000 });
  steps.push(pull);
  if (!pull.ok) return { ok: false, changed: false, steps, message: "Pull thất bại, có thể cần xử lý merge thủ công." };

  const after = await run("git", ["rev-parse", "HEAD"], { timeoutMs: 30000 });
  steps.push(after);
  if (!after.ok) return { ok: false, changed: true, steps, message: "Đã pull nhưng không đọc được commit mới." };

  const afterRevision = after.stdout.trim();
  if (await hasPackageLockChanged(beforeRevision, afterRevision)) {
    const install = await run(npmCommand, ["install"], { timeoutMs: 300000 });
    steps.push(install);
    if (!install.ok) return { ok: false, changed: true, branch, beforeRevision, afterRevision, steps, message: "Đã pull code mới nhưng npm install thất bại." };
  }

  return {
    ok: true,
    changed: true,
    branch,
    beforeRevision,
    afterRevision,
    steps,
    message: "Đã cập nhật code mới từ GitHub."
  };
}

export function formatUpdateResult(result) {
  const title = result.ok ? "✅ Cập nhật hoàn tất" : "❌ Cập nhật thất bại";
  const lines = [title, "", result.message];

  if (result.branch) lines.push(`Branch: ${result.branch}`);
  if (result.beforeRevision && result.afterRevision && result.beforeRevision !== result.afterRevision) {
    lines.push(`Commit: ${result.beforeRevision.slice(0, 7)} → ${result.afterRevision.slice(0, 7)}`);
  }

  lines.push("", "Chi tiết:", ...result.steps.map(formatStep));
  return lines.join("\n");
}
