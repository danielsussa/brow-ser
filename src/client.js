// Cliente: conecta no daemon da pasta ou sobe um. Auto-spawn com lock de
// arquivo pra dois comandos simultâneos não subirem dois Chromes.
import { createConnection } from "node:net";
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { LOG_FILE, PKG_ROOT, SOCKET_PATH, STATE_DIR, ensureStateDir, listSessions, sessionPaths } from "./paths.js";

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

function spawnDaemon(p) {
  ensureStateDir(p.STATE_DIR);
  const fd = openSync(p.LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", fd, fd],
    // BROW_HOME explícito: o daemon roda com cwd dentro de .brow/, então se ele
    // re-derivasse a pasta pelo cwd acabaria criando .brow/.brow. Quem decide
    // qual é a pasta é o cliente, uma vez só — inclusive a da sessão.
    env: { ...process.env, BROW_HOME: p.STATE_DIR, BROW_SESSION: "" },
    cwd: p.STATE_DIR,
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
function acquireLock(p) {
  try {
    if (existsSync(p.LOCK_FILE) && Date.now() - statSync(p.LOCK_FILE).mtimeMs > 60_000) unlinkSync(p.LOCK_FILE);
  } catch {}
  try {
    closeSync(openSync(p.LOCK_FILE, "wx"));
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e; // ENOENT/EACCES é bug de setup, não concorrência — não engolir
  }
}
const releaseLock = (p) => {
  try {
    unlinkSync(p.LOCK_FILE);
  } catch {}
};

async function ensureDaemon(p, { timeoutMs = 45_000 } = {}) {
  ensureStateDir(p.STATE_DIR);
  let sock = await connect(p.SOCKET_PATH, 500);
  if (sock) return sock;

  let died = null;
  const mine = acquireLock(p);
  if (mine) {
    try {
      if (existsSync(p.SOCKET_PATH)) {
        // Socket fantasma (daemon morreu sem limpar): remove antes de subir.
        try {
          unlinkSync(p.SOCKET_PATH);
        } catch {}
      }
      died = spawnDaemon(p);
    } catch (e) {
      releaseLock(p);
      throw e;
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    sock = await connect(p.SOCKET_PATH, 500);
    if (sock) {
      if (mine) releaseLock(p);
      return sock;
    }
    if (died?.code != null) {
      releaseLock(p);
      throw new Error(`daemon morreu no boot (code=${died.code}) — veja ${p.LOG_FILE}`);
    }
  }
  if (mine) releaseLock(p);
  throw new Error(`daemon não subiu em ${timeoutMs / 1000}s — veja ${p.LOG_FILE}`);
}

/**
 * Conexão persistente: um socket serve N comandos (usado pela lib e pelo MCP).
 * `name` escolhe a sessão — cada uma é um daemon/Chrome/perfil separado.
 * Omitido = `$BROW_SESSION` ou "default" (a própria `.brow/`).
 */
export class Session {
  constructor(name) {
    this.paths = sessionPaths(name);
    this.name = this.paths.session;
    this.sock = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
  }

  async #ensure() {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const sock = await ensureDaemon(this.paths);
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

/** Testa se o daemon da sessão está de pé SEM subir um. */
export async function probe(name) {
  const sock = await connect(sessionPaths(name).SOCKET_PATH, 400);
  if (!sock) return false;
  sock.destroy();
  return true;
}

/**
 * Derruba o daemon da sessão e só volta quando o socket sumiu de verdade —
 * senão o próximo comando reconecta num daemon que está morrendo.
 * Devolve false se ela já não estava rodando.
 */
export async function stopSession(name, { timeoutMs = 10_000 } = {}) {
  if (!(await probe(name))) return false;
  const s = new Session(name);
  await s.call("shutdown").catch(() => {});
  s.close();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(name))) return true;
    await sleep(100);
  }
  throw new Error(`sessão ${s.name}: daemon não desligou no tempo esperado`);
}

/** Sessões em disco desta pasta, com quem está de pé agora. */
export async function sessions() {
  return Promise.all(
    listSessions().map(async (name) => ({ name, running: await probe(name), dir: sessionPaths(name).STATE_DIR }))
  );
}

// Preguiçoso: um $BROW_SESSION inválido vira erro na chamada, não no import.
let shared = null;
/** Chamada avulsa contra o daemon da sessão default (sobe se preciso). */
export const call = (cmd, params) => (shared ??= new Session()).call(cmd, params);
export const closeShared = () => shared?.close();
export { SOCKET_PATH, LOG_FILE, STATE_DIR };
