// A aba. UMA. Toda a superfície do protocolo mora aqui.
//
// Regras que definem esse browser:
//  - Uma aba só. Popup/target=_blank viram navegação na mesma aba (guard em JS)
//    e o que escapar é fechado pelo watchdog de Target.targetCreated.
//  - Input REAL (Input.dispatchMouseEvent/KeyEvent) como caminho primário, com
//    fallback pra dispatch JS quando o hit-test falha (overlay, elemento fora
//    da viewport). Isso é o que faz clique em card JSF/SPA funcionar sem
//    conhecer o framework.
//  - Nada de estado global: perfil, downloads e screenshots dentro de .brow/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp } from "./cdp.js";
import { launchChrome } from "./chrome.js";
import { DOWNLOADS_DIR, SHOTS_DIR } from "./paths.js";
import {
  BOOTSTRAP,
  SNAPSHOT,
  TRACKER_WORLD,
  boxJs,
  clickJs,
  findByLabelJs,
  focusJs,
  hoverJs,
  pasteJs,
  probeJs,
  readValueJs,
  setValueJs,
} from "./scripts.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

// Tunáveis por env: o default serve o caso comum, página estranha se ajusta
// sem mexer em código.
const SETTLE_TIMEOUT = Number(process.env.BROW_SETTLE_TIMEOUT ?? 8000);
const QUIET_MS = Number(process.env.BROW_QUIET_MS ?? 250);
const DOM_GRACE_MS = Number(process.env.BROW_DOM_GRACE_MS ?? 600);
// Depois do último fetch/XHR, o render costuma vir num setTimeout curto. Sem
// poder instrumentar timers da página (seria detectável), a rede só conta como
// quieta depois desse eco.
const NET_ECHO_MS = Number(process.env.BROW_NET_ECHO_MS ?? 500);
const LOAD_TIMEOUT = Number(process.env.BROW_LOAD_TIMEOUT ?? 15000);

const TRACKER_READ = "window.__brow ? window.__brow.lastMutation : null";
const isApi = (r) => r.type === "XHR" || r.type === "Fetch";

const DESTROYED = /Execution context was destroyed|Cannot find context|Inspected target navigated|Session with given id not found/i;

/** glob (ex: `*` + `/api/`) ou /regex/flags → RegExp */
export function toRegExp(pattern) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (m) return new RegExp(m[1], m[2]);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

export class Browser {
  constructor(cdp, child, opts) {
    this.cdp = cdp;
    this.child = child;
    this.opts = opts;
    this.sessionId = null;
    this.targetId = null;
    this.startedAt = Date.now();
    /** ring buffer de requests terminados */
    this.finished = [];
    this.inflight = new Map();
    this.netWaiters = new Set();
    /** fim do último fetch/XHR (base do eco de rede no settled) */
    this.lastApiEnd = 0;
    /** executionContextId do mundo isolado no frame principal (cache) */
    this.trackerCtx = null;
    /** commit do documento atual: request de antes disso é do doc anterior */
    this.docStart = 0;
  }

  static async launch(opts = {}) {
    const { child } = await launchChrome(opts);
    const cdp = new Cdp(child);
    const b = new Browser(cdp, child, opts);
    await b.#attach();
    return b;
  }

  get alive() {
    return !this.cdp.closed && this.child.exitCode === null;
  }

  // --- setup ---------------------------------------------------------------

  async #attach() {
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    if (!page) throw new Error("chrome subiu sem nenhuma aba");
    this.targetId = page.targetId;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    this.sessionId = sessionId;

    await this.send("Page.enable");
    await this.send("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 500_000 });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: BOOTSTRAP, worldName: TRACKER_WORLD });
    await this.#evalTracker(BOOTSTRAP).catch(() => {});

    await this.cdp
      .send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS_DIR })
      .catch(() => {});

    this.cdp.on((method, params, sid) => this.#onEvent(method, params, sid));
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
  }

  #onEvent(method, params, sid) {
    if (method === "Target.targetCreated") this.#guardSingleTab(params.targetInfo);
    if (sid !== this.sessionId) return;
    // o "sair da página?" trava a aba (e todo comando seguinte) até alguém responder: nav já é a resposta
    if (method === "Page.javascriptDialogOpening" && params.type === "beforeunload") {
      this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      return;
    }
    if (method === "Page.frameNavigated" && !params.frame.parentId) {
      this.trackerCtx = null;
      this.docStart = Date.now();
      return;
    }
    if (method === "Network.requestWillBeSent") {
      this.inflight.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        start: Date.now(),
        status: null,
      });
    } else if (method === "Network.responseReceived") {
      const r = this.inflight.get(params.requestId);
      if (r) r.status = params.response.status;
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const r = this.inflight.get(params.requestId);
      if (!r) return;
      this.inflight.delete(params.requestId);
      if (isApi(r)) this.lastApiEnd = Date.now();
      const rec = {
        url: r.url,
        method: r.method,
        status: r.status,
        durationMs: Date.now() - r.start,
        end: Date.now(),
        failed: method === "Network.loadingFailed" ? params.errorText || true : undefined,
      };
      this.finished.push(rec);
      if (this.finished.length > 200) this.finished.shift();
      for (const w of [...this.netWaiters]) w(rec);
    }
  }

  /** Aba nova é estado não-endereçável: adota a URL e fecha o alvo. */
  async #guardSingleTab(info) {
    if (!info || info.type !== "page" || info.targetId === this.targetId) return;
    try {
      let url = info.url;
      for (let i = 0; i < 20 && (!url || url === "about:blank"); i++) {
        await sleep(100);
        const r = await this.cdp.send("Target.getTargetInfo", { targetId: info.targetId }).catch(() => null);
        if (!r) break;
        url = r.targetInfo.url;
      }
      await this.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
      if (url && url !== "about:blank") await this.navigate(url, { noWait: true });
    } catch {
      /* watchdog nunca derruba o daemon */
    }
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** Quantas abas o Chrome tem de fato. Deve ser sempre 1 — é o invariante. */
  async pageTargets() {
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page").map((t) => t.url);
  }

  // --- eval ----------------------------------------------------------------

  /** Runtime.evaluate com unwrap de exceção e tolerância a navegação no meio. */
  async eval(expression, { awaitPromise = true, retries = 1 } = {}) {
    try {
      const r = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(d.exception?.description || d.text || "js exception");
      }
      return r.result?.value;
    } catch (e) {
      if (retries > 0 && DESTROYED.test(String(e.message))) {
        await sleep(150);
        return this.eval(expression, { awaitPromise, retries: retries - 1 });
      }
      throw e;
    }
  }

  /**
   * Runtime.evaluate no mundo isolado do tracker. O contexto vem de
   * Page.createIsolatedWorld com o mesmo worldName do
   * addScriptToEvaluateOnNewDocument — o Chrome reusa o mundo pelo nome, então
   * o `window.__brow` de lá é o que o BOOTSTRAP instalou. Sem Runtime.enable.
   */
  async #evalTracker(expression) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.trackerCtx) {
          const { frameTree } = await this.send("Page.getFrameTree");
          const { executionContextId } = await this.send("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: TRACKER_WORLD,
          });
          this.trackerCtx = executionContextId;
        }
        const r = await this.send("Runtime.evaluate", {
          expression,
          contextId: this.trackerCtx,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "js exception");
        return r.result?.value;
      } catch (e) {
        this.trackerCtx = null;
        if (attempt > 0 || !DESTROYED.test(String(e.message))) throw e;
        await sleep(150);
      }
    }
  }

  /** fetch/XHR em voo (o que o site espera antes de renderizar) */
  apiInFlight() {
    let n = 0;
    for (const r of this.inflight.values()) if (isApi(r) && r.start >= this.docStart) n++;
    return n;
  }

  /** Entrega arquivos locais a um <input type=file> (o 1º que casa com `selector`), como o seletor do sistema. */
  async upload(selector, files) {
    const r = await this.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const objectId = r.result?.objectId;
    if (!objectId) throw new Error(`nenhum elemento casa com ${selector}`);
    await this.send("DOM.setFileInputFiles", { files, objectId });
    return { ok: true, files: files.length };
  }

  // --- contrato "página pronta" -------------------------------------------

  /**
   * Settled = fontes carregadas + zero fetch/XHR em voo por `quietMs` (e
   * `NET_ECHO_MS` desde o último terminar, pro render que vem num timer curto)
   * + zero mutação de DOM por `quietMs`. Heurística declarada: devolve o motivo
   * da saída em vez de fingir certeza.
   */
  async settled({ timeout = SETTLE_TIMEOUT, quietMs = QUIET_MS, domGraceMs = DOM_GRACE_MS } = {}) {
    const start = Date.now();
    await this.eval(
      `new Promise((res)=>{if(!document.fonts||!document.fonts.ready)return res();const t=setTimeout(res,3000);document.fonts.ready.then(()=>{clearTimeout(t);res();});})`
    ).catch(() => {});

    let quietSince = null;
    let reason = "timeout";
    while (Date.now() - start < timeout) {
      let lastMut = await this.#evalTracker(TRACKER_READ).catch(() => null);
      if (lastMut == null) {
        // documento que nasceu antes do attach (ou mundo recriado): instala agora
        await this.#evalTracker(BOOTSTRAP).catch(() => {});
        lastMut = await this.#evalTracker(TRACKER_READ).catch(() => null);
      }
      if (lastMut == null) {
        reason = "no-tracker";
        break;
      }
      const now = Date.now();
      const busy = this.apiInFlight() > 0 || now - this.lastApiEnd < NET_ECHO_MS;
      quietSince = busy ? null : (quietSince ?? now);
      const netQuiet = quietSince !== null && now - quietSince >= quietMs;
      const domQuiet = now - lastMut >= quietMs;
      if (netQuiet && domQuiet) {
        reason = "quiet";
        break;
      }
      // Página com ticker/animação nunca deixa o DOM quieto. Sem esse teto,
      // toda ação pagaria o timeout inteiro. Com a rede quieta já esperamos o
      // que dava: devolve com o motivo na cara em vez de travar 8s.
      if (netQuiet && now - quietSince >= quietMs + domGraceMs) {
        reason = "dom-busy";
        break;
      }
      await sleep(60);
    }
    return { reason, waitedMs: Date.now() - start };
  }

  async #afterAction(noWait) {
    if (noWait) return undefined;
    return this.settled();
  }

  // --- navegação -----------------------------------------------------------

  /**
   * Esperamos DOMContentLoaded, não o evento `load`: em site cheio de anúncio o
   * `load` fica pendurado por dezenas de segundos sem que a página esteja menos
   * pronta. O que de fato diz "dá pra agir" é o settled logo depois.
   */
  async navigate(url, { noWait = false, timeout = LOAD_TIMEOUT } = {}) {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const ready = noWait
      ? null
      : this.cdp
          .once("Page.domContentEventFired", { sessionId: this.sessionId, timeout })
          .then(() => "dom")
          .catch(() => "load-timeout");
    const r = await this.send("Page.navigate", { url: target });
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") {
      throw new Error(`navigate falhou: ${r.errorText} (${target})`);
    }
    const loaded = ready ? await ready : "skipped";
    const settled = await this.#afterAction(noWait);
    return { url: await this.url(), title: await this.title(), loaded, settled };
  }

  async back({ noWait = false } = {}) {
    return this.#history(-1, noWait);
  }
  async forward({ noWait = false } = {}) {
    return this.#history(1, noWait);
  }
  async #history(delta, noWait) {
    const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
    const target = entries[currentIndex + delta];
    if (!target) return { ok: false, error: delta < 0 ? "no history back" : "no history forward" };
    await this.send("Page.navigateToHistoryEntry", { entryId: target.id });
    const settled = await this.#afterAction(noWait);
    return { ok: true, url: await this.url(), settled };
  }
  async reload({ noWait = false } = {}) {
    await this.send("Page.reload");
    const settled = await this.#afterAction(noWait);
    return { ok: true, settled };
  }

  url() {
    return this.eval("location.href").catch(() => "");
  }
  title() {
    return this.eval("document.title").catch(() => "");
  }
  async status() {
    return {
      url: await this.url(),
      title: await this.title(),
      inFlight: this.apiInFlight(),
    };
  }

  // --- snapshot ------------------------------------------------------------

  snapshot() {
    return this.eval(SNAPSHOT, { awaitPromise: false });
  }

  /**
   * Roda o lookup; se o ref não existir, re-marca a página (snapshot é
   * idempotente e só escreve atributos) e tenta de novo. Isso deixa
   * `nav` → `click <sid>` funcionar sem um `snap` explícito no meio: o sid é
   * determinístico, então ele resolve assim que a marcação existe.
   */
  async #lookup(js, ref) {
    const first = await this.eval(js, { awaitPromise: false });
    if (first && first.found !== false && first.ok !== false) return first;
    await this.eval(SNAPSHOT, { awaitPromise: false }).catch(() => {});
    return this.eval(js, { awaitPromise: false });
  }

  // --- ações ---------------------------------------------------------------

  /**
   * Click. Caminho primário = mouse REAL no centro do elemento (passa por
   * hit-test, dispara handlers proprietários que só ouvem input nativo).
   * Se o ponto estiver ocupado por outro elemento ou fora da viewport, cai no
   * dispatch JS com resolução de wrapper→descendente clicável.
   */
  async click(ref, { noWait = false } = {}) {
    const probe = await this.#lookup(probeJs(ref), ref);
    if (!probe || !probe.found) throw new Error(`ref não encontrado: ${ref}`);
    let via = "real";
    if (probe.inView && probe.hitOk) {
      await this.#mouse(probe.x, probe.y);
    } else {
      const r = await this.eval(clickJs(ref), { awaitPromise: false });
      if (!r?.ok) throw new Error(r?.error ?? "click falhou");
      via = "js";
    }
    const settled = await this.#afterAction(noWait);
    return { ok: true, via, label: probe.label, settled };
  }

  async #mouse(x, y) {
    const base = { x, y, button: "left", buttons: 1, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  async hover(ref) {
    const probe = await this.#lookup(probeJs(ref), ref);
    if (!probe || !probe.found) throw new Error(`ref não encontrado: ${ref}`);
    if (probe.inView) {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: probe.x, y: probe.y, buttons: 0 });
      return { ok: true, via: "real", label: probe.label };
    }
    const r = await this.eval(hoverJs(ref), { awaitPromise: false });
    if (!r?.ok) throw new Error(r?.error ?? "hover falhou");
    return { ok: true, via: "js", label: probe.label };
  }

  /**
   * Type. Foca via JS, insere via Input.insertText (input real — React/Vue/
   * Lexical enxergam como digitação de gente). Se o valor não bater no fim,
   * cai no setter nativo + input/change.
   */
  async type(ref, text, { clear = true, noWait = false } = {}) {
    const f = await this.#lookup(focusJs(ref, { clear }), ref);
    if (!f?.ok) throw new Error(f?.error ?? `ref não encontrado: ${ref}`);
    let via = "real";
    if (text) await this.send("Input.insertText", { text });
    const got = await this.eval(readValueJs(ref), { awaitPromise: false }).catch(() => null);
    const expected = clear ? text : null;
    if (expected !== null && got !== null && got !== expected) {
      const r = await this.eval(setValueJs(ref, text), { awaitPromise: false });
      if (!r?.ok) throw new Error(r?.error ?? "type falhou");
      via = "js";
    }
    const settled = await this.#afterAction(noWait);
    return { ok: true, via, settled };
  }

  async paste(ref, text, { noWait = false } = {}) {
    const r = await this.#lookup(pasteJs(ref, text), ref);
    if (!r?.ok) throw new Error(r?.error ?? "paste falhou");
    const settled = await this.#afterAction(noWait);
    return { ...r, settled };
  }

  async press(key, { noWait = false } = {}) {
    const info = KEYS[key] ?? (key.length === 1 ? { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!info) throw new Error(`tecla desconhecida: ${key} (use ${Object.keys(KEYS).join(", ")} ou um único caractere)`);
    const common = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", text: info.text, ...common });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    const settled = await this.#afterAction(noWait);
    return { ok: true, settled };
  }

  // --- ações por intenção --------------------------------------------------

  #labelRe(pattern) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    return m ? { source: m[1], flags: m[2] || "i" } : { source: pattern, flags: "i" };
  }

  async findLabel(pattern) {
    const { source, flags } = this.#labelRe(pattern);
    return (await this.eval(findByLabelJs(source, flags), { awaitPromise: false })) ?? [];
  }

  async clickLabel(pattern, { strict = false, noWait = false } = {}) {
    const hits = await this.findLabel(pattern);
    if (!hits.length) throw new Error(`nenhum elemento com label casando /${pattern}/`);
    if (strict && hits.length > 1) {
      throw new Error(`ambíguo (${hits.length}): ${hits.map((h) => JSON.stringify(h.label)).join(", ")}`);
    }
    const res = await this.click(hits[0].ref, { noWait });
    return { ...res, label: hits[0].label, matches: hits.length };
  }

  async waitUntil(expression, { timeout = 15_000, pollMs = 120 } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      try {
        const v = await this.eval(`(() => { try { return (${expression}); } catch (e) { return null; } })()`, {
          awaitPromise: false,
          retries: 0,
        });
        if (v) return { ok: true, value: v, waitedMs: Date.now() - start };
        last = v;
      } catch (e) {
        if (!DESTROYED.test(String(e.message))) last = e.message;
      }
      await sleep(pollMs);
    }
    throw new Error(`wait-until esgotou ${timeout}ms: ${expression} (último: ${JSON.stringify(last)})`);
  }

  async waitLabel(pattern, { timeout = 15_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hits = await this.findLabel(pattern).catch(() => []);
      if (hits.length) return { ok: true, ...hits[0], waitedMs: Date.now() - start };
      await sleep(120);
    }
    throw new Error(`wait-label esgotou ${timeout}ms: /${pattern}/`);
  }

  /**
   * Espera uma chamada de rede. `matchRecentMs` cobre a corrida clássica: o
   * request disparou ANTES do comando chegar aqui — olha o buffer recente e os
   * requests em voo antes de assinar os novos.
   */
  waitRequest(pattern, { method, timeoutMs = 30_000, matchRecentMs = 3_000 } = {}) {
    const re = toRegExp(pattern);
    const ok = (r) => re.test(r.url) && (!method || r.method.toUpperCase() === method.toUpperCase());
    const cutoff = Date.now() - matchRecentMs;

    for (let i = this.finished.length - 1; i >= 0; i--) {
      const r = this.finished[i];
      if (r.end >= cutoff && ok(r)) return Promise.resolve({ ...r, source: "recent" });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.netWaiters.delete(w);
        reject(new Error(`wait-request esgotou ${timeoutMs}ms: ${pattern}${method ? ` [${method}]` : ""}`));
      }, timeoutMs);
      const w = (rec) => {
        if (!ok(rec)) return;
        clearTimeout(timer);
        this.netWaiters.delete(w);
        resolve({ ...rec, source: "live" });
      };
      this.netWaiters.add(w);
    });
  }

  // --- visão ---------------------------------------------------------------

  /** Screenshot vision-friendly: JPEG já redimensionado pelo próprio Chrome. */
  async see({ ref, maxPx = 512, quality = 80 } = {}) {
    let clip;
    if (ref) {
      let box = await this.eval(boxJs(ref), { awaitPromise: false });
      if (!box) {
        await this.eval(SNAPSHOT, { awaitPromise: false }).catch(() => {});
        box = await this.eval(boxJs(ref), { awaitPromise: false });
      }
      if (!box) throw new Error(`ref não encontrado: ${ref}`);
      clip = { x: box.x, y: box.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1) };
    } else {
      const m = await this.send("Page.getLayoutMetrics");
      const vp = m.cssVisualViewport ?? m.visualViewport;
      clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight };
    }
    const longest = Math.max(clip.width, clip.height);
    clip.scale = longest > maxPx ? maxPx / longest : 1;
    const { data } = await this.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip,
      captureBeyondViewport: !!ref,
      fromSurface: true,
    });
    return {
      width: Math.round(clip.width * clip.scale),
      height: Math.round(clip.height * clip.scale),
      bytes: Math.round((data.length * 3) / 4),
      base64: data,
    };
  }

  async screenshot({ path, fullPage = false } = {}) {
    const params = { format: "png", fromSurface: true };
    if (fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const c = m.cssContentSize ?? m.contentSize;
      params.clip = { x: 0, y: 0, width: c.width, height: c.height, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    mkdirSync(SHOTS_DIR, { recursive: true });
    const out = path ?? join(SHOTS_DIR, `shot-${Date.now()}.png`);
    writeFileSync(out, Buffer.from(data, "base64"));
    return { path: out, bytes: Buffer.byteLength(data, "base64") };
  }

  // --- fim -----------------------------------------------------------------

  async close() {
    try {
      await this.cdp.send("Browser.close");
    } catch {
      /* já morreu */
    }
    await sleep(50);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}
