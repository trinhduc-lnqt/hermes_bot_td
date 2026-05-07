import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WG_EXE = "wg-quick";
const WG_CLI = "wg";

const WG_CONF_SEARCH_DIRS = [
  "/etc/wireguard",
  path.resolve("vpn-configs"),
  path.resolve("data", "wireguard")
];

function buildVpnMessage(tunnelName, running) {
  return running
    ? `WireGuard (${tunnelName}): Dang ket noi (ON)`
    : `WireGuard (${tunnelName}): Da ngat ket noi (OFF)`;
}

export function findConfPath(tunnelName, overridePath = "") {
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath;
  }

  for (const dir of WG_CONF_SEARCH_DIRS) {
    const candidate = path.join(dir, `${tunnelName}.conf`);
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return null;
}

export function diagnoseConfPaths(tunnelName, overridePath = "") {
  const candidates = overridePath
    ? [overridePath, ...WG_CONF_SEARCH_DIRS.map((dir) => path.join(dir, `${tunnelName}.conf`))]
    : WG_CONF_SEARCH_DIRS.map((dir) => path.join(dir, `${tunnelName}.conf`));

  return candidates.map((candidatePath) => {
    let status;
    try {
      status = fs.existsSync(candidatePath) ? "[TIM THAY]" : "[KHONG CO]";
    } catch {
      status = "[KHONG CO QUYEN]";
    }
    return `${status}: ${candidatePath}`;
  });
}

async function exec(exePath, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, args, { timeout: 20000 });
    return { ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: (error.stdout || "").trim(),
      stderr: (error.stderr || "").trim(),
      exitCode: error.status ?? error.exitCode ?? null,
      message: error.message || ""
    };
  }
}

export async function getVpnStatus(tunnelName) {
  if (!tunnelName) {
    return { ok: false, running: false, message: "Chua cau hinh WG_TUNNEL_NAME." };
  }

  const wgResult = await exec(WG_CLI, ["show", "interfaces"]);
  if (wgResult.ok) {
    const ifaces = wgResult.stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    const running = ifaces.includes(tunnelName);
    return { ok: true, running, message: buildVpnMessage(tunnelName, running) };
  }

  return {
    ok: false,
    running: false,
    message: `Khong xac dinh duoc trang thai VPN (${tunnelName}). ${wgResult.stderr || wgResult.message}`.trim()
  };
}

export async function connectVpn(tunnelName, overridePath = "") {
  if (!tunnelName) {
    return { ok: false, message: "Chua cau hinh WG_TUNNEL_NAME." };
  }

  const status = await getVpnStatus(tunnelName);
  if (status.running) {
    return { ok: true, message: `VPN da dang ket noi, khong can bat lai.\n${status.message}` };
  }

  const confPath = findConfPath(tunnelName, overridePath);
  if (!confPath) {
    const searched = WG_CONF_SEARCH_DIRS.map((dir) => path.join(dir, `${tunnelName}.conf`)).join("\n  - ");
    return {
      ok: false,
      message: [
        `Khong tim thay file config WireGuard cho \"${tunnelName}\".`,
        "",
        "Da tim trong:",
        `  - ${searched}`,
        "",
        "Giai phap: Them vao .env:",
        `WG_CONF_PATH=/duong/dan/den/${tunnelName}.conf`
      ].join("\n")
    };
  }

  const result = await exec("sudo", [WG_EXE, "up", confPath]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await getVpnStatus(tunnelName);

  if (after.running) {
    return { ok: true, message: `Da bat VPN thanh cong.\n${after.message}` };
  }

  const errDetail = [result.stderr, result.stdout].filter(Boolean).join(" | ") || result.message;
  return {
    ok: false,
    message: [
      `Khong the bat VPN \"${tunnelName}\".`,
      errDetail ? `Loi: ${errDetail}` : "",
      `File conf: ${confPath}`,
      "",
      "Goi y: Can cai wireguard-tools va cap quyen sudo cho wg-quick."
    ].filter(Boolean).join("\n")
  };
}

export async function disconnectVpn(tunnelName, overridePath = "") {
  if (!tunnelName) {
    return { ok: false, message: "Chua cau hinh WG_TUNNEL_NAME." };
  }

  const confPath = findConfPath(tunnelName, overridePath) || tunnelName;
  const result = await exec("sudo", [WG_EXE, "down", String(confPath)]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await getVpnStatus(tunnelName);

  if (!after.running) {
    return { ok: true, message: `Da tat VPN thanh cong.\n${after.message}` };
  }

  const errDetail = [result.stderr, result.stdout].filter(Boolean).join(" | ") || result.message;
  return {
    ok: false,
    message: [
      `Khong the tat VPN \"${tunnelName}\".`,
      errDetail ? `Loi: ${errDetail}` : "",
      "Bot co the thieu quyen sudo."
    ].filter(Boolean).join("\n")
  };
}
