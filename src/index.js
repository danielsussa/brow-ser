// API de biblioteca. Mesma superfície do CLI, pra o agente escrever script em
// vez de encadear shell. Conecta no daemon da pasta (sobe se preciso).
import { Session, probe } from "./client.js";
import { STATE_DIR, SOCKET_PATH, LOG_FILE, PROFILE_DIR, DOWNLOADS_DIR } from "./paths.js";

export class Brow {
  constructor(session = new Session()) {
    this.session = session;
  }

  /** Escotilha: qualquer comando do protocolo, cru. */
  call(cmd, params) {
    return this.session.call(cmd, params);
  }

  info() {
    return this.call("info");
  }
  running() {
    return probe();
  }

  nav(url, opts = {}) {
    return this.call("navigate", { url, ...opts });
  }
  url() {
    return this.call("url");
  }
  title() {
    return this.call("title");
  }
  status() {
    return this.call("status");
  }
  back(opts = {}) {
    return this.call("back", opts);
  }
  forward(opts = {}) {
    return this.call("forward", opts);
  }
  reload(opts = {}) {
    return this.call("reload", opts);
  }

  snap() {
    return this.call("snapshot");
  }
  find(pattern) {
    return this.call("findLabel", { pattern });
  }
  exec(expression) {
    return this.call("exec", { expression });
  }

  click(ref, opts = {}) {
    return this.call("click", { ref, ...opts });
  }
  clickLabel(pattern, opts = {}) {
    return this.call("clickLabel", { pattern, ...opts });
  }
  hover(ref) {
    return this.call("hover", { ref });
  }
  type(ref, text, opts = {}) {
    return this.call("type", { ref, text, ...opts });
  }
  paste(ref, text, opts = {}) {
    return this.call("paste", { ref, text, ...opts });
  }
  press(key, opts = {}) {
    return this.call("press", { key, ...opts });
  }

  /** Sem ms: espera a página assentar. Com ms: dorme. */
  wait(ms) {
    return this.call("wait", ms == null ? {} : { ms });
  }
  waitLabel(pattern, opts = {}) {
    return this.call("waitLabel", { pattern, timeoutMs: opts.timeout });
  }
  waitUntil(expression, opts = {}) {
    return this.call("waitUntil", { expression, timeoutMs: opts.timeout });
  }
  waitRequest(pattern, opts = {}) {
    return this.call("waitRequest", {
      pattern,
      method: opts.method,
      timeoutMs: opts.timeout,
      matchRecentMs: opts.matchRecent,
    });
  }

  see(opts = {}) {
    return this.call("see", opts);
  }
  screenshot(opts = {}) {
    return this.call("screenshot", opts);
  }

  /** Fecha só a conexão — o Chrome continua de pé pro próximo comando. */
  disconnect() {
    this.session.close();
  }
  /**
   * Mata o Chrome e o daemon desta pasta, e só volta quando o socket
   * sumiu de verdade — senão o próximo comando reconecta num daemon que
   * está morrendo e leva "conexão caiu" na cara.
   */
  async shutdown({ timeoutMs = 10_000 } = {}) {
    if (!(await probe())) {
      this.session.close();
      return;
    }
    await this.call("shutdown").catch(() => {});
    this.session.close();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await probe())) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("daemon não desligou no tempo esperado");
  }
}

/** Instância pronta, ligada ao daemon da pasta corrente. */
export const brow = new Brow();

export { Session, probe };
export const paths = { STATE_DIR, SOCKET_PATH, LOG_FILE, PROFILE_DIR, DOWNLOADS_DIR };
