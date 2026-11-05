export interface SnapshotElement {
  /** Índice sequencial. Vale só até o próximo snapshot. */
  id: string;
  /** Hash determinístico de role|label|ancestrais|posição. Sobrevive a re-render. */
  sid: string;
  tag: string;
  role: string;
  label: string;
  type?: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: { value: string; label: string }[];
}

export interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** innerText do body, cortado em 4000 chars. */
  text: string;
}

/** Heurística declarada: por que o wait parou, e quanto esperou. */
export interface Settled {
  reason: "quiet" | "timeout" | "no-tracker";
  waitedMs: number;
}

export interface ActionResult {
  ok: true;
  /** "real" = Input.dispatchMouseEvent/KeyEvent. "js" = fallback por dispatch. */
  via?: "real" | "js";
  label?: string;
  settled?: Settled;
}

export interface NetRecord {
  url: string;
  method: string;
  status: number | null;
  durationMs: number;
  end: number;
  failed?: string | true;
  source: "recent" | "live";
}

export interface SeeResult {
  width: number;
  height: number;
  bytes: number;
  /** JPEG em base64, pronto pra colar num prompt. */
  base64: string;
}

export interface Info {
  tabs: string[] | null;
  pid: number;
  chromePid: number | null;
  headless: boolean;
  stateDir: string;
  socket: string;
  startedAt: number | null;
  uptimeSec: number;
  idleSec: number;
}

export interface LabelHit {
  ref: string;
  label: string;
  tag: string;
}

/** ref = `id` ou `sid` do snapshot (ou o ref efêmero devolvido por find). */
export type Ref = string;

export interface SessionInfo {
  name: string;
  running: boolean;
  /** Pasta de estado da sessão: `.brow/` (default) ou `.brow/sessions/<nome>/`. */
  dir: string;
}

/** Conexão persistente com o daemon de uma sessão. */
export declare class Session {
  /** Omitido = `$BROW_SESSION` ou "default". */
  constructor(name?: string);
  readonly name: string;
  readonly paths: Record<string, string>;
  call(cmd: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export declare class Brow {
  /** Instância de Session ou nome da sessão. Cada sessão é um Chrome separado. */
  constructor(session?: Session | string);
  readonly name: string;
  readonly paths: Record<string, string>;
  call(cmd: string, params?: Record<string, unknown>): Promise<unknown>;
  info(): Promise<Info>;
  running(): Promise<boolean>;

  nav(url: string, opts?: { noWait?: boolean }): Promise<{ url: string; title: string; settled?: Settled }>;
  url(): Promise<string>;
  title(): Promise<string>;
  status(): Promise<{ url: string; title: string; inFlight: number | null }>;
  back(opts?: { noWait?: boolean }): Promise<ActionResult>;
  forward(opts?: { noWait?: boolean }): Promise<ActionResult>;
  reload(opts?: { noWait?: boolean }): Promise<ActionResult>;

  snap(): Promise<Snapshot>;
  find(pattern: string): Promise<LabelHit[]>;
  exec<T = unknown>(expression: string): Promise<T>;

  click(ref: Ref, opts?: { noWait?: boolean }): Promise<ActionResult>;
  clickLabel(pattern: string, opts?: { strict?: boolean; noWait?: boolean }): Promise<ActionResult & { matches: number }>;
  hover(ref: Ref): Promise<ActionResult>;
  type(ref: Ref, text: string, opts?: { clear?: boolean; noWait?: boolean }): Promise<ActionResult>;
  paste(ref: Ref, text: string, opts?: { noWait?: boolean }): Promise<ActionResult>;
  press(key: string, opts?: { noWait?: boolean }): Promise<ActionResult>;

  wait(ms?: number): Promise<Settled | { ok: true; ms: number }>;
  waitLabel(pattern: string, opts?: { timeout?: number }): Promise<LabelHit & { ok: true; waitedMs: number }>;
  waitUntil<T = unknown>(expression: string, opts?: { timeout?: number }): Promise<{ ok: true; value: T; waitedMs: number }>;
  waitRequest(pattern: string, opts?: { method?: string; timeout?: number; matchRecent?: number }): Promise<NetRecord>;

  see(opts?: { ref?: Ref; maxPx?: number; quality?: number }): Promise<SeeResult>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<{ path: string; bytes: number }>;

  disconnect(): void;
  shutdown(opts?: { timeoutMs?: number }): Promise<void>;
}

export declare const brow: Brow;
/** Daemon da sessão está de pé? Não sobe um. Omitida = default. */
export declare function probe(session?: string): Promise<boolean>;
/** Sessões em disco desta pasta ("default" sempre primeiro). */
export declare function sessions(): Promise<SessionInfo[]>;
/** Derruba a sessão; false se já não estava rodando. */
export declare function stopSession(session?: string, opts?: { timeoutMs?: number }): Promise<boolean>;
export declare const paths: {
  STATE_DIR: string;
  SOCKET_PATH: string;
  LOG_FILE: string;
  PROFILE_DIR: string;
  DOWNLOADS_DIR: string;
};
