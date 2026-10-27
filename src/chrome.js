// Localiza e sobe UM Chrome, com tudo apontando pra dentro da pasta:
// perfil, cache, downloads, crash dumps. Sem porta de debug — só o pipe.
import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CHROME_HOME,
  CHROME_RUN,
  CHROME_TMP,
  CRASH_DIR,
  PROFILE_DIR,
  ensureStateDir,
} from "./paths.js";

const CANDIDATES = [
  process.env.BROW_CHROME,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function playwrightCacheChrome() {
  // Se o Playwright já baixou um Chromium nesta máquina, serve de fallback.
  const base = join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = join(base, d, rel);
        try {
          accessSync(p, constants.X_OK);
          return p;
        } catch {}
      }
    }
  } catch {}
  return null;
}

export function findChrome() {
  for (const p of CANDIDATES) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  const pw = playwrightCacheChrome();
  if (pw) return pw;
  throw new Error(
    "chrome não encontrado. Instale google-chrome/chromium ou aponte $BROW_CHROME pro binário."
  );
}

function baseArgs({ headless, width, height }) {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${PROFILE_DIR}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    "--disable-popup-blocking",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--hide-crash-restore-bubble",
    // Sem isto o crashpad grava numa base compartilhada em ~/.config/google-chrome.
    "--disable-crash-reporter",
    `--crash-dumps-dir=${CRASH_DIR}`,
    `--disk-cache-dir=${join(PROFILE_DIR, "Cache")}`,
    "--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,BackForwardCache",
    "--propagate-iph-for-testing",
  ];
  if (headless) args.push("--headless=new");
  if (process.env.BROW_NO_SANDBOX === "1") args.push("--no-sandbox");
  if (process.env.BROW_CHROME_ARGS) args.push(...process.env.BROW_CHROME_ARGS.split(/\s+/).filter(Boolean));
  args.push("about:blank");
  return args;
}

/**
 * Ambiente do Chrome apontando inteiro pra dentro de `.brow/`. Flag de linha de
 * comando não cobre tudo: crashpad, NSS cert DB, cache do dconf e scoped dirs
 * saem por HOME/XDG/TMPDIR. Redirecionando a raiz, todos caem na pasta.
 * DBUS também sai da jogada — sem ele o Chrome não encosta no bus da sessão do
 * usuário (e já usamos password-store=basic, então não faz falta).
 */
function containedEnv() {
  const env = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  return {
    ...env,
    HOME: CHROME_HOME,
    XDG_CONFIG_HOME: join(CHROME_HOME, ".config"),
    XDG_CACHE_HOME: join(CHROME_HOME, ".cache"),
    XDG_DATA_HOME: join(CHROME_HOME, ".local", "share"),
    XDG_STATE_HOME: join(CHROME_HOME, ".local", "state"),
    XDG_RUNTIME_DIR: CHROME_RUN,
    TMPDIR: CHROME_TMP,
    TMP: CHROME_TMP,
    TEMP: CHROME_TMP,
  };
}

function spawnChrome(bin, args) {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: false,
    env: containedEnv(),
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  child.stdout.resume();
  return { child, getStderr: () => stderr };
}

/**
 * Sobe o Chrome. Se morrer nos primeiros segundos por sandbox (comum em
 * WSL/container sem user namespaces), tenta de novo com --no-sandbox.
 */
export async function launchChrome({ headless = true, width = 1280, height = 800 } = {}) {
  ensureStateDir();
  const bin = findChrome();

  const attempt = (extra) =>
    new Promise((resolve, reject) => {
      const args = [...baseArgs({ headless, width, height })];
      if (extra) args.unshift(extra);
      const { child, getStderr } = spawnChrome(bin, args);
      let settled = false;
      const onExit = (code) => {
        if (settled) return;
        settled = true;
        const err = new Error(`chrome morreu no boot (code=${code})\n${getStderr().trim()}`);
        err.stderr = getStderr();
        reject(err);
      };
      child.once("exit", onExit);
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      });
      // Sem exit imediato = subiu. O pipe CDP confirma logo depois.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
        resolve({ child, bin });
      }, 250);
    });

  try {
    return await attempt(null);
  } catch (e) {
    const s = String(e.stderr ?? e.message);
    if (/sandbox|SUID|namespace|Operation not permitted/i.test(s)) {
      return attempt("--no-sandbox");
    }
    throw e;
  }
}
