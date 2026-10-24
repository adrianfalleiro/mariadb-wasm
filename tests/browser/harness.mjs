import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "../../package/node_modules/playwright/index.mjs";

export async function withBrowser(fn) {
  const root = new URL("../../", import.meta.url);
  const server = createServer(async (req, res) => {
    if (req.url !== "/unisolated") res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (path === "/" || path === "/unisolated") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>MariaDB worker test</title>");
      return;
    }
    if (!path.startsWith("/dist/") && !path.startsWith("/bench/")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const file = await readFile(new URL("." + path, root));
      res.setHeader(
        "Content-Type",
        path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      );
      res.end(file);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("browser:", error.message));
    page.on("console", (msg) => {
      if (process.env.DEBUG_BROWSER || msg.type() === "error") console.error(msg.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    let timer;
    try {
      await Promise.race([
        fn(page, browser),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("browser test timed out")), 45000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
