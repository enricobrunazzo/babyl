/**
 * Test end-to-end: due utenti nella stessa stanza, verifica di roster,
 * lock Push-to-Talk half-duplex, relay audio attraverso il server
 * (voce originale, senza API key di traduzione) e riconnessione
 * automatica dopo un riavvio del server.
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
const WEB_PORT = 4183;
const WS_PORT = 8797; // porta dedicata: non collide con un eventuale dev server
const BASE = `http://localhost:${WEB_PORT}/?room=demo`;

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

// Niente wrapper npx: kill() deve raggiungere il processo node vero,
// altrimenti il test di riconnessione non spegne davvero il server.
function startServer() {
  const child = spawnChild(
    process.execPath,
    ["--import", "tsx", "server/src/index.ts"],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(WS_PORT) },
    },
  );
  child.on("exit", (code) => {
    // Un'uscita non richiesta (es. EADDRINUSE) deve far fallire subito il
    // test invece di lasciarlo proseguire contro un processo estraneo.
    if (!child.expectedExit && code !== 0 && code !== null) {
      console.error(`signaling server terminato inaspettatamente (code ${code})`);
      process.exit(1);
    }
  });
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

let server = startServer();
spawnChild(
  process.execPath,
  [
    join(ROOT, "node_modules/vite/bin/vite.js"),
    "preview",
    "--port",
    String(WEB_PORT),
    "--strictPort",
  ],
  {
    cwd: join(ROOT, "web"),
    env: {
      ...process.env,
      SIGNALING_PROXY_TARGET: `ws://localhost:${WS_PORT}`,
    },
  },
);
await waitForHttp(`http://localhost:${WS_PORT}/healthz`);
await waitForHttp(`http://localhost:${WEB_PORT}/`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let failed = false;
try {
  const join2 = async (nickname, lang) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await context.grantPermissions(["microphone"], {
      origin: `http://localhost:${WEB_PORT}`,
    });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.selectOption("select", lang);
    await page.fill('input[name="nickname"]', nickname);
    await page.check('input[type="checkbox"]');
    await page.click("button.enter-button");
    await page.waitForSelector(".status-connected", { timeout: 15000 });
    return { context, page };
  };

  const waitRoster = (page, count) =>
    page.waitForFunction(
      (expected) =>
        document.querySelectorAll(".participant").length === expected,
      count,
      { timeout: 15000 },
    );

  // --- Join e roster ---
  const a = await join2("Marco", "it");
  const b = await join2("Anna", "de");
  await waitRoster(a.page, 2);
  await waitRoster(b.page, 2);
  console.log("✔ join e roster 2/2 su entrambi");

  await a.page.waitForSelector(".ptt-free", { timeout: 15000 });
  await b.page.waitForSelector(".ptt-free", { timeout: 15000 });
  console.log("✔ canale Libero (verde) su entrambi");

  // --- Lock half-duplex ---
  await a.page.dispatchEvent("button.ptt-button", "pointerdown", {
    pointerId: 1,
  });
  await a.page.waitForSelector(".ptt-talking", { timeout: 5000 });
  await b.page.waitForSelector(".ptt-blocked", { timeout: 5000 });
  const label = await b.page.textContent(".ptt-label");
  if (!label.includes("Marco")) {
    throw new Error(`label Bloccato senza nome speaker: ${label}`);
  }
  console.log("✔ A trasmette (rosso), B bloccato (grigio) con nome speaker");

  // --- Relay audio: mentre A parla (tono del microfono finto di Chromium),
  //     B deve ricevere chunk audio attraverso il server ---
  await b.page.waitForFunction(
    () =>
      Number(
        document.querySelector(".room")?.getAttribute("data-audio-frames"),
      ) > 0,
    undefined,
    { timeout: 15000 },
  );
  console.log("✔ relay audio: B riceve l'audio di A attraverso il server");

  await a.page.dispatchEvent("button.ptt-button", "pointerup", {
    pointerId: 1,
  });
  await a.page.waitForSelector(".ptt-free", { timeout: 5000 });
  await b.page.waitForSelector(".ptt-free", { timeout: 5000 });
  console.log("✔ rilascio: canale di nuovo Libero");

  // --- Inversione ruoli ---
  await b.page.dispatchEvent("button.ptt-button", "pointerdown", {
    pointerId: 1,
  });
  await a.page.waitForSelector(".ptt-blocked", { timeout: 5000 });
  await b.page.dispatchEvent("button.ptt-button", "pointerup", {
    pointerId: 1,
  });
  await a.page.waitForSelector(".ptt-free", { timeout: 5000 });
  console.log("✔ inversione ruoli B → A");

  // --- Riconnessione automatica dopo riavvio del server ---
  server.expectedExit = true;
  server.kill();
  await a.page.waitForSelector(".status-reconnecting", { timeout: 15000 });
  console.log("✔ caduta server rilevata, stato Riconnessione…");
  server = startServer();
  await waitForHttp(`http://localhost:${WS_PORT}/healthz`);
  await a.page.waitForSelector(".status-connected", { timeout: 20000 });
  await b.page.waitForSelector(".status-connected", { timeout: 20000 });
  await waitRoster(a.page, 2);
  await waitRoster(b.page, 2);
  console.log("✔ riconnessione automatica: entrambi di nuovo in stanza");

  // --- Uscita peer ---
  await b.context.close();
  await waitRoster(a.page, 1);
  console.log("✔ uscita peer: roster aggiornato");

  console.log("E2E COMPLETATO");
} catch (error) {
  failed = true;
  console.error("E2E FALLITO:", error);
} finally {
  await browser.close().catch(() => {});
  for (const child of children) child.kill();
}

process.exit(failed ? 1 : 0);
