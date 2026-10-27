// Daemon: dono do único Chrome desta pasta. Fala JSON-por-linha num unix socket
// dentro de .brow/. Sem porta, sem nome global — dois repos nunca se enxergam.
//
// Comandos são SERIALIZADOS: uma aba só, então intercalar ações de dois
// clientes daria corrida silenciosa. A fila torna isso impossível.
import { createServer } from "node:net";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { Browser } from "./browser.js";
import { PID_FILE, SOCKET_PATH, STATE_DIR, ensureStateDir } from "./paths.js";

const IDLE_MS = (Number(process.env.BROW_IDLE ?? 1800) || 0) * 1000;
const HEADLESS = process.env.BROW_HEADED === "1" ? false : true;

let browser = null;
let queue = Promise.resolve();
let lastActivity = Date.now();
let shuttingDown = false;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Serializa: cada comando espera o anterior terminar. */
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

const HANDLERS = {
  ping: () => "pong",
  info: async () => ({
    tabs: browser ? await browser.pageTargets().catch(() => null) : null,
    pid: process.pid,
    chromePid: browser?.child.pid ?? null,
    headless: HEADLESS,
    stateDir: STATE_DIR,
    socket: SOCKET_PATH,
    startedAt: browser?.startedAt ?? null,
    uptimeSec: browser ? Math.round((Date.now() - browser.startedAt) / 1000) : 0,
    idleSec: Math.round((Date.now() - lastActivity) / 1000),
  }),
  shutdown: () => {
    setTimeout(() => shutdown("shutdown cmd"), 30);
    return "bye";
  },

  navigate: (b, p) => b.navigate(p.url, { noWait: p.noWait }),
  url: (b) => b.url(),
  title: (b) => b.title(),
  status: (b) => b.status(),
  snapshot: (b) => b.snapshot(),
  exec: (b, p) => b.eval(p.expression),
  upload: (b, p) => b.upload(p.selector, p.files),

  click: (b, p) => b.click(p.ref, { noWait: p.noWait }),
  clickLabel: (b, p) => b.clickLabel(p.pattern, { strict: p.strict, noWait: p.noWait }),
  hover: (b, p) => b.hover(p.ref),
  type: (b, p) => b.type(p.ref, p.text, { clear: p.clear !== false, noWait: p.noWait }),
  paste: (b, p) => b.paste(p.ref, p.text, { noWait: p.noWait }),
  press: (b, p) => b.press(p.key, { noWait: p.noWait }),

  wait: async (b, p) => {
    if (p.ms == null) return b.settled();
    await new Promise((r) => setTimeout(r, p.ms));
    return { ok: true, ms: p.ms };
  },
  waitUntil: (b, p) => b.waitUntil(p.expression, { timeout: p.timeoutMs }),
  waitLabel: (b, p) => b.waitLabel(p.pattern, { timeout: p.timeoutMs }),
  waitRequest: (b, p) =>
    b.waitRequest(p.pattern, { method: p.method, timeoutMs: p.timeoutMs, matchRecentMs: p.matchRecentMs }),
  findLabel: (b, p) => b.findLabel(p.pattern),

  see: (b, p) => b.see({ ref: p.ref, maxPx: p.maxPx, quality: p.quality }),
  screenshot: (b, p) => b.screenshot({ path: p.path, fullPage: p.fullPage }),

  back: (b, p) => b.back({ noWait: p.noWait }),
  forward: (b, p) => b.forward({ noWait: p.noWait }),
  reload: (b, p) => b.reload({ noWait: p.noWait }),
};

const NO_BROWSER = new Set(["ping", "info", "shutdown"]);

async function handle(req) {
  lastActivity = Date.now();
  const fn = HANDLERS[req.cmd];
  if (!fn) throw new Error(`comando desconhecido: ${req.cmd}`);
  if (NO_BROWSER.has(req.cmd)) return fn(browser, req);
  if (!browser || !browser.alive) throw new Error("chrome não está vivo");
  return fn(browser, req);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown:", reason);
  const done = () => {
    for (const f of [SOCKET_PATH, PID_FILE]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    process.exit(0);
  };
  const b = browser;
  browser = null;
  if (!b) return done();
  b.close().then(done, done);
  setTimeout(done, 3000).unref();
}

async function main() {
  ensureStateDir();
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
  }

  browser = await Browser.launch({
    headless: HEADLESS,
    width: Number(process.env.BROW_WIDTH ?? 1280),
    height: Number(process.env.BROW_HEIGHT ?? 800),
  });
  log(`chrome up pid=${browser.child.pid} headless=${HEADLESS} profile=${STATE_DIR}/profile`);
  browser.child.once("exit", (code) => shutdown(`chrome exited (${code})`));

  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch (e) {
          socket.write(JSON.stringify({ id: -1, ok: false, error: `bad json: ${e.message}` }) + "\n");
          continue;
        }
        enqueue(() => handle(req)).then(
          (result) => socket.write(JSON.stringify({ id: req.id, ok: true, result: result ?? null }) + "\n"),
          (e) => socket.write(JSON.stringify({ id: req.id, ok: false, error: e?.message ?? String(e) }) + "\n")
        );
      }
    });
    socket.on("error", () => {});
  });

  server.on("error", (e) => {
    log("server error", e.message);
    process.exit(1);
  });
  server.listen(SOCKET_PATH, () => {
    writeFileSync(PID_FILE, String(process.pid));
    log("listening", SOCKET_PATH);
  });

  if (IDLE_MS > 0) {
    const tick = Math.min(30_000, Math.max(2_000, Math.floor(IDLE_MS / 4)));
    setInterval(() => {
      if (Date.now() - lastActivity > IDLE_MS) shutdown(`ocioso > ${IDLE_MS / 1000}s`);
    }, tick).unref();
  }

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
  process.on("uncaughtException", (e) => log("uncaught", e?.stack ?? e));
  process.on("unhandledRejection", (e) => log("unhandled", e?.stack ?? e));
}

main().catch((e) => {
  log("boot falhou:", e?.stack ?? e);
  process.exit(1);
});
