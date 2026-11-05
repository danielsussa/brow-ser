// Smoke end-to-end: sobe um servidor local, um daemon isolado, e exercita o
// caminho todo. `node test/smoke.mjs`. Usa BROW_HOME próprio pra não encostar
// na sessão de trabalho da pasta.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BROW_HOME = mkdtempSync(join(tmpdir(), "brow-smoke-"));
const { Brow, sessions } = await import("../src/index.js");
const brow = new Brow();

const PAGE = `<!doctype html><meta charset=utf-8><title>smoke</title>
<input id=nome placeholder="Nome">
<button id=go onclick="log('submit:'+nome.value)">Continuar</button>
<div id=card onclick="log('card')"><span>Cartao</span></div>
<div style="position:relative;width:180px">
  <button onclick="log('veiled')">Sob veu</button>
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.05)"></div>
</div>
<a id=blank href="/other" target="_blank">nova aba</a>
<button onclick="window.open('/other')">popup</button>
<button onclick="slow()">fetch lento</button>
<ul id=list></ul><pre id=out></pre>
<script>
function log(m){out.textContent += m + "\\n"}
async function slow(){ await fetch('/slow'); setTimeout(()=>{const p=document.createElement('p');p.id='tardio';p.textContent='tardio';document.body.appendChild(p)},400) }
function render(){ list.innerHTML=''; ['Salvar','Excluir'].forEach(t=>{const li=document.createElement('li');const b=document.createElement('button');b.textContent=t;li.appendChild(b);list.appendChild(li)}) }
render(); window.render = render;
</script>`;

// Página que mexe no DOM pra sempre: sem a janela de grace, cada ação aqui
// esperaria o timeout inteiro de settle.
const TICKER = `<!doctype html><meta charset=utf-8><title>ticker</title>
<button onclick="n++">bump</button><span id=t></span>
<script>let n=0;(function tick(){t.textContent=n+' '+Date.now();setTimeout(tick,100)})()</script>`;

const T0 = Date.now();

const server = createServer((req, res) => {
  if (req.url.startsWith("/slow")) {
    return setTimeout(() => res.end("{}"), 800);
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url.startsWith("/other")) return res.end("<title>outra</title><h1>outra</h1>");
  if (req.url.startsWith("/ticker")) return res.end(TICKER);
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`smoke em ${process.env.BROW_HOME}`);

await check("boot + navigate", async () => {
  const r = await brow.nav(BASE);
  assert(r.title === "smoke", `title=${r.title}`);
  return r.settled.reason;
});

await check("nada é escrito fora de .brow", async () => {
  const home = process.env.BROW_HOME;
  // O redirect de HOME/XDG/TMPDIR pegou? Estes só existem se pegou.
  assert(existsSync(join(home, "home", ".config", "google-chrome")), "crashpad não caiu dentro da pasta");
  assert(readdirSync(join(home, "tmp")).some((d) => d.includes("Chrome")), "scoped dir não caiu dentro da pasta");
  // E nada novo do Chrome apareceu no /tmp do sistema nem no HOME real.
  const strays = readdirSync(tmpdir())
    .filter((d) => /^\.?(com\.google\.Chrome|org\.chromium)/.test(d))
    .filter((d) => {
      try {
        return statSync(join(tmpdir(), d)).mtimeMs >= T0;
      } catch {
        return false;
      }
    });
  assert(strays.length === 0, `vazou pro /tmp: ${strays.join(", ")}`);
  return `home/, tmp/, run/ contidos`;
});

await check("snapshot com sid estável", async () => {
  const a = await brow.snap();
  assert(a.elements.length >= 7, `${a.elements.length} elementos`);
  await brow.exec("render()");
  const b = await brow.snap();
  const sids = (s) => s.elements.filter((e) => ["Salvar", "Excluir"].includes(e.label)).map((e) => e.sid);
  assert(JSON.stringify(sids(a)) === JSON.stringify(sids(b)), "sid mudou após re-render");
  return `${a.elements.length} elems, sids ${sids(a).join(",")}`;
});

await check("type real + click por label", async () => {
  const el = (await brow.snap()).elements.find((e) => e.tag === "input");
  await brow.type(el.sid, "Daniel");
  const r = await brow.clickLabel("^Continuar$");
  assert(r.via === "real", `via=${r.via}`);
  const out = await brow.exec("out.textContent");
  assert(out.includes("submit:Daniel"), out);
  return "via real";
});

await check("click em wrapper resolve descendente", async () => {
  await brow.clickLabel("^Cartao$");
  assert((await brow.exec("out.textContent")).includes("card"));
});

await check("click ocluso cai no fallback js", async () => {
  const r = await brow.clickLabel("Sob veu");
  assert(r.via === "js", `esperava fallback js, veio ${r.via}`);
  assert((await brow.exec("out.textContent")).includes("veiled"));
  return "via js";
});

// Anti-bot (ex.: YouTube) checa se fetch/XHR/timers são nativos. O tracker vive
// num mundo isolado: o mundo da página não pode ver nada do brow.
await check("página intocada (sem __brow, globais nativos)", async () => {
  await brow.nav(BASE);
  const r = await brow.exec(
    `[typeof window.__brow, ...[fetch, XMLHttpRequest.prototype.send, setTimeout, clearTimeout, window.open].map((f) => /\\[native code\\]/.test(Function.prototype.toString.call(f)))]`
  );
  assert(r[0] === "undefined", "window.__brow visível na página");
  assert(r.slice(1).every(Boolean), `global não-nativo: ${JSON.stringify(r)}`);
});

await check("target=_blank navega na mesma aba", async () => {
  await brow.nav(BASE);
  await brow.clickLabel("nova aba");
  await brow.waitUntil("location.pathname === '/other'", { timeout: 5000 });
  assert((await brow.info()).tabs.length === 1, "abriu mais de uma aba");
});

await check("window.open navega na mesma aba", async () => {
  await brow.nav(BASE);
  await brow.clickLabel("^popup$");
  await brow.waitUntil("location.pathname === '/other'", { timeout: 5000 });
  assert((await brow.info()).tabs.length === 1, "abriu mais de uma aba");
});

await check("settled espera render tardio pós-fetch", async () => {
  await brow.nav(BASE);
  const r = await brow.clickLabel("fetch lento");
  assert(await brow.exec("!!document.getElementById('tardio')"), "settled voltou antes do render tardio");
  return `${r.settled.waitedMs}ms`;
});

await check("página com ticker não paga o timeout inteiro", async () => {
  await brow.nav(`${BASE}/ticker`);
  const r = await brow.clickLabel("bump");
  assert(r.settled.reason === "dom-busy", `reason=${r.settled.reason}`);
  assert(r.settled.waitedMs < 2000, `${r.settled.waitedMs}ms — grace de DOM não aplicou`);
  return `${r.settled.waitedMs}ms (${r.settled.reason})`;
});

await check("wait-request pega o request", async () => {
  await brow.nav(BASE);
  brow.clickLabel("fetch lento", { noWait: true }).catch(() => {});
  const r = await brow.waitRequest("*/slow", { timeout: 8000 });
  assert(r.status === 200, `status=${r.status}`);
  return `${r.source} ${r.durationMs}ms`;
});

await check("see devolve jpeg pequeno", async () => {
  const r = await brow.see({ maxPx: 320 });
  assert(r.base64.length > 500 && r.bytes < 60_000, `${r.bytes} bytes`);
  return `${r.width}x${r.height} ${(r.bytes / 1024).toFixed(1)}KB`;
});

await check("sessão persiste entre restarts", async () => {
  await brow.exec("localStorage.setItem('k','v')");
  await brow.shutdown();
  await brow.nav(BASE);
  assert((await brow.exec("localStorage.getItem('k')")) === "v", "localStorage sumiu");
});

await check("erro é limpo e não derruba o daemon", async () => {
  await brow.click("ref-que-nao-existe").then(
    () => {
      throw new Error("devia ter falhado");
    },
    (e) => assert(/não encontrado/.test(e.message), e.message)
  );
  assert((await brow.title()) === "smoke");
});

await check("sessões paralelas são isoladas", async () => {
  const other = new Brow("paralela");
  try {
    await Promise.all([other.nav(`${BASE}/other`), brow.exec("localStorage.setItem('quem','default')")]);
    // Os dois Chromes de pé ao mesmo tempo, cada um na sua aba.
    const [a, b] = await Promise.all([brow.info(), other.info()]);
    assert(a.chromePid !== b.chromePid, "mesmo Chrome nas duas sessões");
    assert(b.stateDir === join(process.env.BROW_HOME, "sessions", "paralela"), `stateDir=${b.stateDir}`);
    assert((await brow.title()) === "smoke" && (await other.title()) === "outra", "uma sessão mexeu na aba da outra");
    // Mesma origem, perfis diferentes: localStorage não vaza.
    assert((await other.exec("localStorage.getItem('quem')")) === null, "localStorage vazou entre sessões");
    const up = (await sessions()).filter((x) => x.running).map((x) => x.name);
    assert(up.includes("default") && up.includes("paralela"), `rodando: ${up}`);
  } finally {
    await other.shutdown();
  }
  assert(!(await other.running()), "sessão paralela não desligou");
  assert(await brow.running(), "derrubar a paralela derrubou a default");
});

await brow.shutdown();
brow.disconnect();
server.close();
rmSync(process.env.BROW_HOME, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
