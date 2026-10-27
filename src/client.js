// Cliente: conecta no daemon da pasta ou sobe um. Auto-spawn com lock de
// arquivo pra dois comandos simultâneos não subirem dois Chromes.
import { createConnection } from "node:net";
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { LOCK_FILE, LOG_FILE, PKG_ROOT, SOCKET_PATH, STATE_DIR, ensureStateDir } from "./paths.js";

const DAEMON = join(PKG_ROOT, "src", "daemon.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(path, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    // O timer PRECISA morrer no sucesso: sem isso ele segura o event loop e
    // todo comando de CLI ficava ~500ms mais lento do que a resposta real.
    const timer = setTimeout(() => {
      if (done) return;
      sock.destroy();
      finish(null);
    }, timeoutMs);
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const sock = createConnection(path);
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      sock.on("error", () => {});
      finish(sock);
    });
    sock.once("error", () => {
      sock.destroy();
      finish(null);
    });
  });
}

function spawnDaemon() {
  ensureStateDir();
  const fd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", fd, fd],
    // BROW_HOME explícito: o daemon roda com cwd dentro de .brow/, então se ele
    // re-derivasse a pasta pelo cwd acabaria criando .brow/.brow. Quem decide
    // qual é a pasta é o cliente, uma vez só.
    env: { ...process.env, BROW_HOME: STATE_DIR },
    cwd: STATE_DIR,
  });
  child.unref();
  closeSync(fd);
  // Enquanto ESTE processo viver ainda recebemos o exit do filho — usamos pra
  // falhar em 1s em vez de esperar o timeout inteiro quando o boot quebra.
  const died = { code: null };
  child.once("exit", (code) => {
    died.code = code ?? 1;
  });
  child.once("error", () => {
    died.code = 1;
  });
  return died;
}

/** Lock cru: quem cria o arquivo sobe o daemon; o resto só espera. */
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE) && Date.now() - statSync(LOCK_FILE).mtimeMs > 60_000) unlinkSync(LOCK_FILE);
  } catch {}
  try {
    closeSync(openSync(LOCK_FILE, "wx"));
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e; // ENOENT/EACCES é bug de setup, não concorrência — não engolir
  }
}
const releaseLock = () => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
};

async function ensureDaemon({ timeoutMs = 45_000 } = {}) {
  ensureStateDir();
  let sock = await connect(SOCKET_PATH, 500);
  if (sock) return sock;

  let died = null;
  const mine = acquireLock();
  if (mine) {
    try {
      if (existsSync(SOCKET_PATH)) {
        // Socket fantasma (daemon morreu sem limpar): remove antes de subir.
        try {
          unlinkSync(SOCKET_PATH);
        } catch {}
      }
      died = spawnDaemon();
    } catch (e) {
      releaseLock();
      throw e;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    sock = await connect(SOCKET_PATH, 500);
    if (sock) {
      if (mine) releaseLock();
      return sock;
    }
    if (died?.code != null) {
      releaseLock();
      throw new Error(`daemon morreu no boot (code=${died.code}) — veja ${LOG_FILE}`);
    }
  }
  if (mine) releaseLock();
  throw new Error(`daemon não subiu em ${timeoutMs / 1000}s — veja ${LOG_FILE}`);
}

/** Conexão persistente: um socket serve N comandos (usado pela lib e pelo MCP). */
export class Session {
  constructor() {
    this.sock = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
  }

  async #ensure() {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const sock = await ensureDaemon();
    sock.setNoDelay(true);
    sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let res;
        try {
          res = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.pending.get(res.id);
        if (!p) continue;
        this.pending.delete(res.id);
        res.ok ? p.resolve(res.result) : p.reject(new Error(res.error));
      }
    });
    const fail = () => {
      for (const [, p] of this.pending) p.reject(new Error("conexão com o daemon caiu"));
      this.pending.clear();
      this.sock = null;
      this.buf = "";
    };
    sock.on("close", fail);
    sock.on("error", fail);
    this.sock = sock;
    return sock;
  }

  async call(cmd, params = {}) {
    const sock = await this.#ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sock.write(JSON.stringify({ id, cmd, ...params }) + "\n");
    });
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }
}

/** Testa se o daemon da pasta está de pé SEM subir um. */
export async function probe() {
  const sock = await connect(SOCKET_PATH, 400);
  if (!sock) return false;
  sock.destroy();
  return true;
}

const shared = new Session();
/** Chamada avulsa contra o daemon da pasta (sobe se preciso). */
export const call = (cmd, params) => shared.call(cmd, params);
export const closeShared = () => shared.close();
export { SOCKET_PATH, LOG_FILE, STATE_DIR };
