// Onde TODO o estado do browser mora. A regra é literal: nada fora desta pasta.
//
// `.brow/` nasce no diretório de onde você rodou o brow — sem procurar pra cima,
// sem herdar o daemon de um repo pai. Rodou em outra pasta, é outro browser:
// outro processo, outro perfil, outro socket. `$BROW_HOME` sobrescreve.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveStateDir(cwd = process.cwd()) {
  return process.env.BROW_HOME ? resolve(process.env.BROW_HOME) : join(resolve(cwd), ".brow");
}

export const STATE_DIR = resolveStateDir();

export const PROFILE_DIR = join(STATE_DIR, "profile");
export const SOCKET_PATH = join(STATE_DIR, "daemon.sock");
export const PID_FILE = join(STATE_DIR, "daemon.pid");
export const LOCK_FILE = join(STATE_DIR, "daemon.lock");
export const LOG_FILE = join(STATE_DIR, "daemon.log");
export const SHOTS_DIR = join(STATE_DIR, "shots");
export const DOWNLOADS_DIR = join(STATE_DIR, "downloads");

// Sandbox de ambiente do Chrome: sem isso ele escreve crashpad em
// ~/.config/google-chrome, cert DB em ~/.local/share/pki, cache do dconf e um
// scoped dir em /tmp — tudo compartilhado com qualquer outro Chrome da máquina.
export const CHROME_HOME = join(STATE_DIR, "home");
export const CHROME_TMP = join(STATE_DIR, "tmp");
export const CHROME_RUN = join(STATE_DIR, "run");
export const CRASH_DIR = join(STATE_DIR, "crash");

/** Cria a árvore de `.brow/`. Idempotente. */
export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const d of [PROFILE_DIR, DOWNLOADS_DIR, SHOTS_DIR, CHROME_HOME, CHROME_TMP, CRASH_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(CHROME_RUN, { recursive: true, mode: 0o700 });
  return STATE_DIR;
}
