/**
 * Test end-to-end della PWA: verifica che Babyl sia installabile in schermata
 * Home su Android e iOS.
 *
 * Controlla, sulla build di produzione servita da `vite preview`:
 *  - il manifest è collegato, valido e con le icone (incl. maskable);
 *  - le icone e i meta iOS (apple-touch-icon, standalone) sono serviti;
 *  - il service worker si registra (requisito di installabilità);
 *  - il banner d'installazione compare e si comporta correttamente su entrambi
 *    i percorsi: Android/desktop (pulsante nativo via `beforeinstallprompt`) e
 *    iOS/Safari (istruzioni manuali, nessun pulsante — l'evento non esiste).
 *
 * Non serve il signaling server: l'invito compare in onboarding, prima di
 * entrare in una stanza (nessun WebSocket aperto).
 *
 * Prerequisito: `npm run build` (usa vite preview su web/dist).
 * Chromium: risolto da Playwright, oppure via env CHROMIUM_PATH.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_PORT = 4184; // porta dedicata, distinta da quella dell'altro e2e
const BASE = `http://localhost:${WEB_PORT}/`;

// UA iPhone/Safari: attiva il percorso iOS (installazione manuale).
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

if (!existsSync(join(ROOT, "web/dist/index.html"))) {
  console.error("web/dist mancante: esegui prima `npm run build`");
  process.exit(1);
}

const children = [];
function spawnChild(command, args, options) {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
  children.push(child);
  return child;
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // non ancora in ascolto
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout in attesa di ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

spawnChild(
  process.execPath,
  [
    join(ROOT, "node_modules/vite/bin/vite.js"),
    "preview",
    "--port",
    String(WEB_PORT),
    "--strictPort",
  ],
  { cwd: join(ROOT, "web"), env: { ...process.env } },
);
await waitForHttp(BASE);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

let failed = false;
try {
  // --- Manifest e icone (serviti dalla build) ---
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load" });

  const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
  assert(manifestHref === "/manifest.webmanifest", `link manifest inatteso: ${manifestHref}`);

  const manifest = await page.evaluate(() =>
    fetch("/manifest.webmanifest").then((r) => r.json()),
  );
  assert(manifest.display === "standalone", "manifest: display non standalone");
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, "manifest: icone insufficienti");
  const sizes = manifest.icons.map((i) => i.sizes);
  assert(sizes.includes("192x192") && sizes.includes("512x512"), "manifest: mancano 192/512");
  assert(
    manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "manifest: manca l'icona maskable",
  );
  console.log("✔ manifest valido (standalone, 192/512 + maskable)");

  const iconStatuses = await page.evaluate(() =>
    Promise.all(
      ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"].map(
        (u) => fetch(u).then((r) => `${u}:${r.status}`),
      ),
    ),
  );
  assert(iconStatuses.every((s) => s.endsWith(":200")), `icone non servite: ${iconStatuses}`);
  console.log("✔ icone (Android + apple-touch-icon iOS) servite 200");

  const appleCapable = await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content");
  assert(appleCapable === "yes", "meta apple-mobile-web-app-capable assente");
  console.log("✔ meta iOS per avvio a tutto schermo presenti");

  // --- Service worker (requisito di installabilità) ---
  const scope = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then((r) => r.scope),
      new Promise((res) => setTimeout(() => res("timeout"), 10000)),
    ]);
    return reg;
  });
  assert(typeof scope === "string" && scope.endsWith("/"), `service worker non registrato (scope=${scope})`);
  console.log("✔ service worker registrato (scope /)");

  // --- Percorso Android/desktop: beforeinstallprompt → pulsante Installa ---
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt");
    e.prompt = async () => {};
    Object.defineProperty(e, "userChoice", {
      value: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(e);
  });
  await page.waitForSelector(".install-banner", { timeout: 5000 });
  const cta = await page.textContent(".install-cta");
  assert(cta && cta.trim().length > 0, "pulsante Installa assente nel banner Android");
  const iconLoaded = await page.evaluate(() => {
    const img = document.querySelector(".install-icon");
    return !!(img && img.complete && img.naturalWidth > 0);
  });
  assert(iconLoaded, "icona del banner non caricata");
  console.log(`✔ Android/desktop: banner con pulsante «${cta.trim()}» e icona`);

  // "Non ora" chiude e ricorda in sessione (nessun localStorage).
  await page.click(".install-dismiss");
  await page.waitForSelector(".install-banner", { state: "detached", timeout: 5000 });
  const dismissed = await page.evaluate(() =>
    sessionStorage.getItem("babyl-install-dismissed"),
  );
  assert(dismissed === "1", "chiusura banner non ricordata in sessionStorage");
  const noLocalStorage = await page.evaluate(() => localStorage.length === 0);
  assert(noLocalStorage, "il banner ha scritto in localStorage (deve restare stateless)");
  console.log("✔ «Non ora» chiude il banner e lo ricorda solo in sessionStorage");

  await ctx.close();

  // --- Percorso iOS/Safari: istruzioni manuali, nessun pulsante ---
  const iosCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: IPHONE_UA,
  });
  const iosPage = await iosCtx.newPage();
  await iosPage.goto(BASE, { waitUntil: "load" });
  // Su iOS non c'è beforeinstallprompt: il banner compare da solo (dopo il
  // breve ritardo del componente) con le istruzioni "Aggiungi a Home".
  await iosPage.waitForSelector(".install-banner", { timeout: 5000 });
  const hasCta = await iosPage.$(".install-cta");
  assert(hasCta === null, "iOS: non deve esserci il pulsante Installa (evento assente)");
  const iosBody = await iosPage.textContent(".install-text span");
  assert(/home/i.test(iosBody || ""), `iOS: istruzioni d'installazione mancanti (${iosBody})`);
  console.log("✔ iOS/Safari: banner con istruzioni manuali, senza pulsante nativo");

  await iosCtx.close();
  console.log("PWA E2E COMPLETATO");
} catch (error) {
  failed = true;
  console.error("PWA E2E FALLITO:", error);
} finally {
  await browser.close().catch(() => {});
  for (const child of children) child.kill();
}

process.exit(failed ? 1 : 0);
