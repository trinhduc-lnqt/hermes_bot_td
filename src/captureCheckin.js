import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { config } from "./config.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function shouldCapture(url) {
  if (!url.startsWith(config.baseUrl)) {
    return false;
  }
  const ignored = ["/Scripts/", "/libs/", "/Content/", "/JsonFile/"];
  return !ignored.some((item) => url.includes(item));
}

async function main() {
  const artifactsDir = path.resolve("artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const safeMode = process.env.CAPTURE_ALLOW_POSTS !== "true";
  let captureArmed = false;
  let step = 0;

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: 1365, height: 900 },
    permissions: config.geo ? ["geolocation"] : []
  });

  if (config.geo) {
    await context.setGeolocation(config.geo);
  }

  const page = await context.newPage();
  const requests = [];

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const isWrite = WRITE_METHODS.has(method);
    const shouldBlock = safeMode && captureArmed && isWrite && shouldCapture(url);

    if (shouldBlock) {
      requests.push({
        time: new Date().toISOString(),
        method,
        url,
        headers: request.headers(),
        postData: request.postData(),
        resourceType: request.resourceType(),
        status: "BLOCKED_BY_CAPTURE",
        responsePreview: ""
      });
      console.log(`[SAFE CAPTURE] Da chan ${method} ${url}`);
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });

  page.on("requestfinished", async (request) => {
    if (!shouldCapture(request.url())) {
      return;
    }
    const response = await request.response();
    let responsePreview = "";
    try {
      responsePreview = (await response.text()).slice(0, 1500);
    } catch {
      responsePreview = "";
    }
    requests.push({
      time: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
      resourceType: request.resourceType(),
      status: response?.status(),
      responsePreview
    });
  });

  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });

  console.log("");
  console.log("Browser da mo.");
  console.log("1. Tu dang nhap IHR.");
  console.log("2. Tu vao man hinh Check In.");
  if (safeMode) {
    console.log("3. Khi da o dung man hinh va san sang test, quay lai terminal nhan Enter lan 1 de BAT che do chan request ghi du lieu.");
    console.log("4. Quay lai browser, bam Check In/Check Out, sau do bam Save. Request ghi du lieu se bi chan truoc khi len he thong.");
    console.log("5. Quay lai terminal, nhan Enter lan 2 de luu log.");
  } else {
    console.log("3. Thu bam Check In/Check Out, sau do bam Save mot lan.");
    console.log("4. Quay lai cua so terminal va nhan Enter de luu log.");
  }
  console.log("");

  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async () => {
    if (safeMode && step === 0) {
      captureArmed = true;
      step = 1;
      console.log("");
      console.log("[SAFE CAPTURE] Da bat che do chan request ghi du lieu.");
      console.log("[SAFE CAPTURE] Gio may quay lai browser va bam Check In/Check Out, sau do bam Save. He thong se KHONG nhan request ghi.");
      console.log("");
      return;
    }

    const filePath = path.join(artifactsDir, `network-${Date.now()}.json`);
    await writeFile(filePath, JSON.stringify(requests, null, 2), "utf8");
    console.log(`Da luu network log tai: ${filePath}`);
    await browser.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
