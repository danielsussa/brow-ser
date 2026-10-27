// CLI. Saída pensada pra caber em prompt: densa, sem enfeite, sem cor.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { call, closeShared, probe, LOG_FILE, STATE_DIR } from "./client.js";
import { SHOTS_DIR } from "./paths.js";

const HELP = `brow — browser de aba única, contido na pasta, pra agentes

Estado (perfil, socket, downloads, screenshots): ${STATE_DIR}

  brow start [--headed]        Sobe o daemon + Chrome desta pasta
  brow stop                    Fecha o Chrome e o daemon desta pasta
  brow info                    pid, uptime, ocioso, onde mora o estado
  brow log [-n 50]             Últimas linhas do log do daemon

  brow nav <url> [--no-wait]   Navega (aceita "example.com")
  brow url | brow title | brow status
  brow back | forward | reload

  brow snap [--json]           Elementos interativos + texto visível
  brow find <regex>            Só lista o que casa com o label (sem clicar)

  brow click <ref> [--no-wait]
  brow click-label <regex> [--strict] [--no-wait]
  brow hover <ref>
  brow type <ref> <texto> [--keep] [--no-wait]     --keep = não limpa antes
  brow paste <ref> <texto>     ClipboardEvent sintético (Lexical/ProseMirror)
  brow press <tecla>           Enter Tab Escape Arrow* Space Home End ... ou 1 char

  brow wait [ms]               Sem ms: espera a página assentar (settled)
  brow wait-label <regex> [--timeout 15000]
  brow wait-until '<js>' [--timeout 15000]
  brow wait-request <glob|/re/> [--method POST] [--timeout 30000] [--match-recent 3000]

  brow see [--ref X] [--max 512] [--quality 80] [--inline] [--out P]
  brow shot [--out P] [--full]
  brow upload <css> <arquivo...>   Arquivos locais num <input type=file>
  brow exec '<js>'

ref = o "id" (sequencial, vale só até o próximo snapshot) ou o "sid" (hash
estável de role+label+ancestrais, sobrevive a re-render) impresso pelo snap.

--no-wait pula o settled implícito depois da ação. Use quando você já tem um
wait-label/wait-request logo em seguida.

Env: BROW_HOME (onde fica o estado) · BROW_HEADED=1 · BROW_CHROME (binário)
     BROW_IDLE=segundos (auto-desliga ocioso; 0 desliga; default 1800)
     BROW_WIDTH/BROW_HEIGHT · BROW_NO_SANDBOX=1 · BROW_CHROME_ARGS
`;

// --- parsing ---------------------------------------------------------------
function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return { flags, pos };
}

const num = (v, d) => (v == null || v === true ? d : Number(v));
const has = (f, ...names) => names.some((n) => f[n] === true || f[n] === "true");

function die(msg, code = 1) {
  process.stderr.write(`erro: ${msg}\n`);
  process.exit(code);
}

// --- render ----------------------------------------------------------------
function renderSnapshot(s) {
  const out = [`URL   ${s.url}`, `TITLE ${s.title}`, "", `ELEMENTS (${s.elements.length})`];
  if (!s.elements.length) out.push("  (nenhum)");
  for (const e of s.elements) {
    const bits = [`${String(e.id).padStart(3)} ${e.sid}`, `${e.role}`];
    if (e.type) bits.push(`[${e.type}]`);
    bits.push(JSON.stringify(e.label));
    if (e.value) bits.push(`= ${JSON.stringify(e.value)}`);
    if (e.checked != null) bits.push(e.checked ? "✓" : "✗");
    if (e.disabled) bits.push("(disabled)");
    if (e.href) bits.push(`-> ${e.href}`);
    out.push("  " + bits.join(" "));
    if (e.options) {
      out.push("      opções: " + e.options.map((o) => o.label).slice(0, 12).join(" | "));
    }
  }
  out.push("", "TEXT", s.text || "(vazio)");
  return out.join("\n");
}

function show(v) {
  if (v == null) return;
  if (typeof v === "string") process.stdout.write(v.endsWith("\n") ? v : v + "\n");
  else process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

// --- comandos --------------------------------------------------------------
async function run(cmd, pos, flags) {
  const noWait = has(flags, "no-wait");
  const asJson = has(flags, "json");

  switch (cmd) {
    case "start": {
      if (has(flags, "headed")) process.env.BROW_HEADED = "1";
      const info = await call("info");
      if (has(flags, "headed") && info.headless) {
        process.stderr.write("aviso: já havia um daemon headless nesta pasta. `brow stop` antes pra trocar de modo.\n");
      }
      return show(info);
    }
    case "stop": {
      if (!(await probe())) return show("não estava rodando");
      await call("shutdown").catch(() => {});
      return show("parado");
    }
    case "info":
      return show(await call("info"));
    case "log": {
      if (!existsSync(LOG_FILE)) return show("(sem log ainda)");
      const n = num(flags.n ?? flags.lines, 50);
      return show(readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-n).join("\n"));
    }

    case "nav":
    case "navigate": {
      if (!pos[0]) die("uso: brow nav <url>");
      return show(await call("navigate", { url: pos[0], noWait }));
    }
    case "url":
      return show(await call("url"));
    case "title":
      return show(await call("title"));
    case "status":
      return show(await call("status"));
    case "back":
    case "forward":
    case "reload":
      return show(await call(cmd, { noWait }));

    case "snap":
    case "snapshot": {
      const s = await call("snapshot");
      return show(asJson ? s : renderSnapshot(s));
    }
    case "find": {
      if (!pos[0]) die("uso: brow find <regex>");
      return show(await call("findLabel", { pattern: pos[0] }));
    }

    case "click": {
      if (!pos[0]) die("uso: brow click <ref>");
      return show(await call("click", { ref: pos[0], noWait }));
    }
    case "click-label": {
      if (!pos[0]) die("uso: brow click-label <regex>");
      return show(await call("clickLabel", { pattern: pos[0], strict: has(flags, "strict"), noWait }));
    }
    case "hover": {
      if (!pos[0]) die("uso: brow hover <ref>");
      return show(await call("hover", { ref: pos[0] }));
    }
    case "type": {
      if (pos.length < 2) die("uso: brow type <ref> <texto>");
      return show(await call("type", { ref: pos[0], text: pos.slice(1).join(" "), clear: !has(flags, "keep"), noWait }));
    }
    case "paste": {
      if (pos.length < 2) die("uso: brow paste <ref> <texto>");
      return show(await call("paste", { ref: pos[0], text: pos.slice(1).join(" "), noWait }));
    }
    case "press": {
      if (!pos[0]) die("uso: brow press <tecla>");
      return show(await call("press", { key: pos[0], noWait }));
    }

    case "wait": {
      const ms = pos[0] != null ? Number(pos[0]) : null;
      return show(await call("wait", ms != null ? { ms } : {}));
    }
    case "wait-until": {
      if (!pos[0]) die("uso: brow wait-until '<js>'");
      return show(await call("waitUntil", { expression: pos[0], timeoutMs: num(flags.timeout, 15000) }));
    }
    case "wait-label": {
      if (!pos[0]) die("uso: brow wait-label <regex>");
      return show(await call("waitLabel", { pattern: pos[0], timeoutMs: num(flags.timeout, 15000) }));
    }
    case "wait-request": {
      if (!pos[0]) die("uso: brow wait-request <glob|/regex/>");
      return show(
        await call("waitRequest", {
          pattern: pos[0],
          method: typeof flags.method === "string" ? flags.method : undefined,
          timeoutMs: num(flags.timeout, 30000),
          matchRecentMs: num(flags["match-recent"], 3000),
        })
      );
    }

    case "see": {
      const r = await call("see", {
        ref: typeof flags.ref === "string" ? flags.ref : pos[0],
        maxPx: num(flags.max, 512),
        quality: num(flags.quality, 80),
      });
      if (has(flags, "inline")) return show(`data:image/jpeg;base64,${r.base64}`);
      const out = typeof flags.out === "string" ? flags.out : join(SHOTS_DIR, `see-${Date.now()}.jpg`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(r.base64, "base64"));
      return show(`${out}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(1)}KB`);
    }
    case "shot": {
      const r = await call("screenshot", {
        path: typeof flags.out === "string" ? flags.out : undefined,
        fullPage: has(flags, "full"),
      });
      return show(`${r.path}  ${(r.bytes / 1024).toFixed(1)}KB`);
    }
    case "upload": {
      if (!pos[0] || !pos[1]) die("uso: brow upload <css do input> <arquivo...>");
      return show(await call("upload", { selector: pos[0], files: pos.slice(1).map((f) => resolve(f)) }));
    }
    case "exec": {
      if (!pos[0]) die("uso: brow exec '<js>'");
      return show(await call("exec", { expression: pos[0] }));
    }

    default:
      die(`comando desconhecido: ${cmd}\n\n${HELP}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, pos } = parse(argv);
  const cmd = pos.shift();
  if (!cmd || cmd === "help" || has(flags, "help") || flags.h) {
    process.stdout.write(HELP);
    return;
  }
  try {
    await run(cmd, pos, flags);
    closeShared();
  } catch (e) {
    closeShared();
    die(e?.message ?? String(e));
  }
}
