// API de biblioteca. Mesma superfície do CLI, pra o agente escrever script em
// vez de encadear shell. Conecta no daemon da pasta (sobe se preciso).
//
//   new Brow()          sessão default (ou $BROW_SESSION)
//   new Brow("login")   outro Chrome, outro perfil, em .brow/sessions/login/
import { Session, probe, sessions, stopSession } from "./client.js";
import { STATE_DIR, SOCKET_PATH, LOG_FILE, PROFILE_DIR, DOWNLOADS_DIR } from "./paths.js";

export class Brow {
  /** @param {Session | string} [session] instância pronta ou nome da sessão */
  constructor(session) {
    this.session = session instanceof Session ? session : new Session(session);
  }

  /** Nome normalizado da sessão ("default" quando omitida). */
  get name() {
    return this.session.name;
  }
  /** Caminhos da pasta de estado desta sessão. */
  get paths() {
    return this.session.paths;
  }

  /** Escotilha: qualquer comando do protocolo, cru. */
  call(cmd, params) {
    return this.session.call(cmd, params);
  }

  info() {
    return this.call("info");
  }
  running() {
    return probe(this.name);
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
   * Mata o Chrome e o daemon desta sessão, e só volta quando o socket
   * sumiu de verdade — senão o próximo comando reconecta num daemon que
   * está morrendo e leva "conexão caiu" na cara.
   */
  async shutdown(opts) {
    this.session.close();
    await stopSession(this.name, opts);
  }
}

/** Instância pronta, ligada à sessão default da pasta corrente. */
export const brow = new Brow();

export { Session, probe, sessions, stopSession };
export const paths = { STATE_DIR, SOCKET_PATH, LOG_FILE, PROFILE_DIR, DOWNLOADS_DIR };
