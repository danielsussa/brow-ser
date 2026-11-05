// Onde TODO o estado do browser mora. A regra é literal: nada fora desta pasta.
//
// `.brow/` nasce no diretório de onde você rodou o brow — sem procurar pra cima,
// sem herdar o daemon de um repo pai. Rodou em outra pasta, é outro browser:
// outro processo, outro perfil, outro socket. `$BROW_HOME` sobrescreve.
//
// Sessões nomeadas moram em `.brow/sessions/<nome>/`, com o mesmo layout da
// raiz: cada uma é outro daemon, outro Chrome, outro perfil. A sessão
// "default" é a própria `.brow/` — quem nunca passa sessão não vê diferença.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveStateDir(cwd = process.cwd()) {
  return process.env.BROW_HOME ? resolve(process.env.BROW_HOME) : join(resolve(cwd), ".brow");
}

export const STATE_DIR = resolveStateDir();
export const SESSIONS_DIR = join(STATE_DIR, "sessions");

/** Layout de uma pasta de estado. Vale pra raiz e pra cada sessão. */
export function layout(dir) {
  return {
    STATE_DIR: dir,
    PROFILE_DIR: join(dir, "profile"),
    SOCKET_PATH: join(dir, "daemon.sock"),
    PID_FILE: join(dir, "daemon.pid"),
    LOCK_FILE: join(dir, "daemon.lock"),
    LOG_FILE: join(dir, "daemon.log"),
    SHOTS_DIR: join(dir, "shots"),
    DOWNLOADS_DIR: join(dir, "downloads"),
    // Sandbox de ambiente do Chrome: sem isso ele escreve crashpad em
    // ~/.config/google-chrome, cert DB em ~/.local/share/pki, cache do dconf e um
    // scoped dir em /tmp — tudo compartilhado com qualquer outro Chrome da máquina.
    CHROME_HOME: join(dir, "home"),
    CHROME_TMP: join(dir, "tmp"),
    CHROME_RUN: join(dir, "run"),
    CRASH_DIR: join(dir, "crash"),
  };
}

export const {
  PROFILE_DIR,
  SOCKET_PATH,
  PID_FILE,
  LOCK_FILE,
  LOG_FILE,
  SHOTS_DIR,
  DOWNLOADS_DIR,
  CHROME_HOME,
  CHROME_TMP,
  CHROME_RUN,
  CRASH_DIR,
} = layout(STATE_DIR);

// Curto de propósito: o caminho do unix socket tem teto de ~108 bytes.
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** Normaliza o nome da sessão. Vazio/omitido = `$BROW_SESSION` ou "default". */
export function sessionName(name) {
  const n = name == null || name === "" ? process.env.BROW_SESSION || "default" : String(name);
  if (!SESSION_RE.test(n)) {
    throw new Error(`nome de sessão inválido: ${JSON.stringify(n)} (letras, números, _ . -; até 32 chars)`);
  }
  return n;
}

/** Caminhos de uma sessão, mais o nome já normalizado. */
export function sessionPaths(name) {
  const session = sessionName(name);
  return { session, ...layout(session === "default" ? STATE_DIR : join(SESSIONS_DIR, session)) };
}

/** Sessões que já existem em disco ("default" sempre vem primeiro). */
export function listSessions() {
  const names = ["default"];
  if (existsSync(SESSIONS_DIR)) {
    for (const d of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && SESSION_RE.test(d.name) && d.name !== "default") names.push(d.name);
    }
  }
  return names;
}

/** Cria a árvore de uma pasta de estado. Idempotente. */
export function ensureStateDir(dir = STATE_DIR) {
  const p = layout(dir);
  mkdirSync(dir, { recursive: true });
  for (const d of [p.PROFILE_DIR, p.DOWNLOADS_DIR, p.SHOTS_DIR, p.CHROME_HOME, p.CHROME_TMP, p.CRASH_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(p.CHROME_RUN, { recursive: true, mode: 0o700 });
  return dir;
}
