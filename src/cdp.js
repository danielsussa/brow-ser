// Transporte CDP por PIPE (fd 3 = nós escrevemos, fd 4 = nós lemos), mensagens
// JSON terminadas em NUL. Sem WebSocket, sem HTTP, sem porta TCP aberta.
//
// Por que pipe e não `--remote-debugging-port`: a porta é um endpoint que
// QUALQUER processo da máquina pode conectar. O pipe só existe entre nós e o
// nosso Chrome — é o que faz o isolamento por pasta ser real e não convenção.

const NUL = 0;

export class CdpError extends Error {
  constructor(message, data) {
    super(data ? `${message} — ${data}` : message);
    this.name = "CdpError";
  }
}

export class Cdp {
  /** @param {import('node:child_process').ChildProcess} child */
  constructor(child) {
    this.child = child;
    this.write = child.stdio[3];
    this.read = child.stdio[4];
    if (!this.write || !this.read) throw new Error("chrome pipe fds 3/4 missing");

    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    this.closeReason = null;

    let buf = Buffer.alloc(0);
    this.read.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let i;
      while ((i = buf.indexOf(NUL)) >= 0) {
        const raw = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (raw.length) this.#dispatch(raw);
      }
    });
    this.read.on("error", () => this.#die("cdp read pipe error"));
    this.read.on("end", () => this.#die("chrome closed the cdp pipe"));
    this.write.on("error", () => this.#die("cdp write pipe error"));
    child.once("exit", (code, signal) =>
      this.#die(`chrome exited (code=${code} signal=${signal})`)
    );
  }

  #dispatch(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(msg.error.message, msg.error.data));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (const h of this.handlers) {
      try {
        h(msg.method, msg.params ?? {}, msg.sessionId);
      } catch {
        /* handler não derruba o loop */
      }
    }
  }

  #die(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, p] of this.pending) p.reject(new CdpError(reason));
    this.pending.clear();
  }

  /** Assina eventos CDP. Retorna a função de unsubscribe. */
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Espera um evento específico. `predicate` opcional filtra por params.
   * Resolve com params; rejeita no timeout.
   */
  once(method, { timeout = 30_000, sessionId, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`timeout waiting for ${method}`));
      }, timeout);
      const off = this.on((m, params, sid) => {
        if (m !== method) return;
        if (sessionId !== undefined && sid !== sessionId) return;
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** Envia um comando. `sessionId` ausente = domínio de browser. */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new CdpError(this.closeReason ?? "cdp closed"));
    const id = ++this.seq;
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write.write(JSON.stringify(msg) + "\0", (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(new CdpError(`cdp write failed: ${err.message}`));
      });
    });
  }
}
