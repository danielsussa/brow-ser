# brow

Browser de **uma aba só**, **contido na pasta**, feito pra agente dirigir.

Deriva do [handoff](https://github.com/danielsussa/handoff) — mesma tese de camada
AI-friendly, mas com o modelo operacional invertido: em vez de **um** daemon global
que todos os agentes da máquina compartilham, aqui **cada pasta tem o seu**.

```bash
./brow nav example.com
./brow snap
./brow click-label "Learn more"
./brow see --inline        # JPEG base64, cola no prompt
```

## O contrato de isolamento

Rodar o `brow` cria `.brow/` **no diretório de onde você rodou**, e é ali que
tudo vive — sem procurar pasta pra cima, sem herdar daemon de repo pai:

```
.brow/
├── profile/      user-data-dir do Chrome (cookies, localStorage, logins)
├── daemon.sock   unix socket — não é porta TCP, ninguém de fora alcança
├── daemon.pid
├── daemon.log
├── downloads/
├── shots/
├── home/         $HOME do Chrome: crashpad, cert DB, cache de fontconfig
├── tmp/          $TMPDIR do Chrome: scoped dirs, singleton lock
├── run/          $XDG_RUNTIME_DIR do Chrome: dconf
└── crash/        --crash-dumps-dir
```

Consequências, que são o ponto:

- **Processo próprio.** O daemon spawna o Chrome dele. `brow stop` mata a árvore
  inteira. Nenhum outro agente na máquina divide processo, memória ou perfil.
- **Sem porta de debug.** O CDP vai por `--remote-debugging-pipe` (fd 3/4). Com
  `--remote-debugging-port` qualquer processo da máquina poderia conectar; com
  pipe, o canal existe só entre o daemon e o Chrome dele.
- **Nem `$HOME` escapa.** Flag de linha de comando não contém tudo: por padrão o
  Chrome grava crashpad em `~/.config/google-chrome/Crash Reports`, cert DB em
  `~/.local/share/pki`, cache do dconf em `~/.cache`, e um scoped dir em `/tmp` —
  todos compartilhados com qualquer outro Chrome da máquina. Aqui o processo
  nasce com `HOME`, `XDG_*` e `TMPDIR` apontando pra dentro de `.brow/`, e sem
  `DBUS_SESSION_BUS_ADDRESS`, então não encosta no bus da sessão do usuário.
- **Sessão é da pasta.** Login feito no repo A não aparece no repo B. Reiniciar
  o daemon não perde nada — o perfil está no disco, dentro da pasta.
- **Rodou em outra pasta, é outro browser.** Inclusive um subdiretório: ele cria
  o `.brow/` dele e sobe o daemon dele. Pra apontar dois lugares pro mesmo
  estado, use `$BROW_HOME`.

O único recurso compartilhado que sobra é o **binário** do Chrome em
`/opt/google/chrome` — read-only, aberto por todo mundo. Nenhum arquivo fora de
`.brow/` é criado ou modificado; dá pra conferir com:

```bash
rm -rf .brow && T=$(date +%s) && ./brow nav example.com
find ~/.config ~/.cache ~/.local /tmp -maxdepth 4 -newermt "@$T" 2>/dev/null
```

O daemon se desliga sozinho depois de `BROW_IDLE` segundos ocioso (default 1800).
`BROW_IDLE=0` desliga esse comportamento.

## Sessões

Cada daemon continua com **uma aba só**. Pra rodar várias coisas em paralelo na
mesma pasta (dois agentes, duas contas, dois fluxos), use **sessões nomeadas**:
cada uma é outro daemon, outro Chrome e outro perfil, em
`.brow/sessions/<nome>/`, com o mesmo layout da raiz.

```bash
./brow nav app.com                      # sessão default = a própria .brow/
./brow --session admin nav app.com/admin
./brow --session cliente nav app.com
./brow sessions                         # quem existe e quem está de pé
./brow --session admin stop             # ou: ./brow stop --all
```

- Sem `--session` (nem `$BROW_SESSION`), nada muda: é a sessão default.
- O login de uma sessão **não** aparece na outra; cada perfil é separado.
- O nome aceita letras, números, `_ . -`, até 32 caracteres.
- `$BROW_SESSION` define a sessão padrão do processo. Serve pra fixar cada
  agente na sua sessão sem passar o parâmetro em toda chamada.

## Instalação

Zero dependências. Precisa de Node ≥ 20 e um Chrome/Chromium no sistema
(`google-chrome`, `chromium`, ou `$BROW_CHROME` apontando pro binário; um Chromium
do cache do Playwright serve de fallback).

```bash
git clone <este repo> && cd brow-ser
./brow nav example.com     # sobe o daemon na primeira chamada
```

Pra usar de outro repo, aponte o binário — o `.brow/` nasce no cwd:

```bash
cd /meu/outro/repo
/caminho/pra/brow-ser/brow nav example.com   # cria /meu/outro/repo/.brow/
```

Adicione `.brow/` ao `.gitignore` do repo que usar.

## CLI

```
brow start [--headed]      brow stop [--all]      brow info      brow log [-n 50]
brow sessions              --session <nome> em qualquer comando

brow nav <url> [--no-wait]         brow url | title | status
brow back | forward | reload

brow snap [--json]                 elementos interativos + texto visível
brow find <regex>                  lista o que casa com o label, sem clicar

brow click <ref> [--no-wait]
brow click-label <regex> [--strict] [--no-wait]
brow hover <ref>
brow type <ref> <texto> [--keep] [--no-wait]
brow paste <ref> <texto>           ClipboardEvent sintético (editor rico)
brow press <tecla>                 Enter Tab Escape Arrow* Space ... ou 1 char

brow wait [ms]                     sem ms = espera a página assentar
brow wait-label <regex> [--timeout 15000]
brow wait-until '<js>' [--timeout 15000]
brow wait-request <glob|/re/> [--method POST] [--timeout] [--match-recent]

brow see [--ref X] [--max 512] [--quality 80] [--inline] [--out P]
brow shot [--out P] [--full]
brow upload <css> <arquivo...>   # arquivos locais num <input type=file> (DOM.setFileInputFiles)
brow exec '<js>'
```

### ref: o `id` e o `sid`

`brow snap` numera os elementos e também dá a cada um um `sid` — hash
determinístico de `role | label | cadeia de ancestrais | posição entre irmãos`.

```
    0 f3c2775c input "Nome"
    3 e40ec193 button [button] "Continuar"
   ^^ ^^^^^^^^
   id sid
```

O `id` vale até o próximo snapshot. O **`sid` sobrevive a re-render** — a SPA pode
destruir e recriar o botão que o `sid` continua o mesmo. Guarde `sid` quando for
referenciar um elemento entre turnos.

Todo comando que recebe `ref` aceita os dois. E se o ref não existir na página,
o browser re-marca sozinho antes de desistir — então `nav` seguido direto de
`click <sid>` funciona, sem `snap` no meio.

## Biblioteca

```js
import { brow } from "./src/index.js";

await brow.nav("https://exemplo.com/login");
const { elements } = await brow.snap();
const user = elements.find((e) => /usuário/i.test(e.label));

await brow.type(user.sid, "daniel");
await brow.clickLabel("^Entrar$", { noWait: true });
await brow.waitRequest("*/api/session", { method: "POST" });   // status HTTP cirúrgico
await brow.waitLabel("Minha conta");

// outra sessão = outro Chrome, roda em paralelo com a de cima
const admin = new Brow("admin");
await admin.nav("https://exemplo.com/admin");
await admin.shutdown();
```

Tipos em `src/index.d.ts`. `brow.call(cmd, params)` é a escotilha pro protocolo cru.

## MCP

Servidor stdio, 16 tools, sem dependência. No `.mcp.json` do repo que vai usar:

```json
{
  "mcpServers": {
    "brow": { "command": "node", "args": ["/caminho/pra/brow-ser/src/mcp.js"] }
  }
}
```

`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_click_label`,
`browser_type`, `browser_press`, `browser_hover`, `browser_see` (devolve a imagem
inline), `browser_wait_label`, `browser_wait_until`, `browser_wait_request`,
`browser_exec`, `browser_history`, `browser_status`, `browser_sessions`,
`browser_close`.

Toda tool de browser aceita um `session` opcional. O servidor mantém uma conexão
por sessão, então um agente pode tocar `session: "a"` e `session: "b"` em
paralelo sem uma pisar na aba da outra. `browser_close` fecha o Chrome de uma
sessão (o perfil fica no disco). Pra dar a cada agente a sua sessão por padrão:

```json
{ "brow": { "command": "node", "args": ["…/src/mcp.js"], "env": { "BROW_SESSION": "agente-1" } } }
```

## Como funciona

```
  CLI / lib / MCP
        │  JSON por linha
        ▼
  .brow/daemon.sock  ──►  daemon.js   (fila serial: uma aba, um comando por vez)
                              │  JSON terminado em NUL, fd 3/4
                              ▼
                         Chrome (--remote-debugging-pipe)
                              │  Runtime.evaluate / Input.dispatch*
                              ▼
                         a página
```

Os primitivos que fazem a camada ser "AI-friendly" são **JS injetado**, não mágica
de engine (`src/scripts.js`):

- **`__brow`** — um `MutationObserver` instalado no início de todo documento, num
  **mundo isolado** (`worldName`): o site não enxerga nada do brow e nenhum global
  dele é tocado. A metade "rede" do contrato de página pronta (fetch/XHR em voo)
  vem dos eventos `Network.*` no daemon. Wrapper de `fetch`/XHR/`setTimeout` no
  mundo da página é detectável — o YouTube corta o vídeo em ~40s quando vê
  `fetch` não-nativo.
- **snapshot** — varre os elementos interativos visíveis, marca `data-brow-id` /
  `data-brow-sid`, devolve role/label/valor/opções + o texto visível.
- **guard de aba única** — `target=_blank` vira navegação na mesma aba (pelo DOM,
  do mundo isolado). `window.open` não é sobrescrito: o popup é fechado pelo
  watchdog de `Target.targetCreated`, que adota a URL na aba de verdade.

### Input real, com queda pra JS

`click`/`type`/`press` usam `Input.dispatchMouseEvent` / `dispatchKeyEvent` /
`insertText` — input **real**, que passa por hit-test e dispara handler
proprietário que só escuta evento nativo.

Antes de clicar, o browser mede o elemento e checa `elementFromPoint`. Se o ponto
estiver coberto (modal, véu) ou o elemento fora da viewport, cai no dispatch JS,
resolvendo wrapper visual → descendente clicável. O resultado diz qual caminho
foi usado (`via: "real" | "js"`), então você nunca fica no escuro.

### Contrato de "página pronta"

`settled` = fontes carregadas **+** zero fetch/XHR em voo **+** nenhum timer curto
agendado na esteira de um request **+** DOM sem mutação — tudo isso sustentado por
250ms. Toda ação mutativa espera isso por padrão (`--no-wait` pula).

O rastreio de timer fecha o padrão "o fetch terminou e o render local vem num
`setTimeout(400)`": rede e DOM ficam os dois quietos nesse buraco, e um settled
ingênuo devolveria cedo. Só contam timers agendados **enquanto tem request em voo
ou logo depois de um terminar** — o ticker de uma página ociosa não entra, então
isso não custa latência no caso comum.

Toda espera devolve **por que** parou, nunca só "ok":

| `reason` | significado |
|---|---|
| `quiet` | rede e DOM assentaram de verdade |
| `dom-busy` | rede assentou, mas o DOM não para (ticker, animação). Devolveu depois da janela de tolerância em vez de travar |
| `timeout` | estourou o teto — a página não para (site cheio de anúncio) |
| `no-tracker` | sem `__brow` no mundo isolado (`about:blank`, documento trocando) |

## O que veio do handoff, e o que mudou

Herdado: snapshot com stableId, tracker de settled, ações por intenção
(`click-label`/`wait-label`/`wait-until`), `wait-request`, `see`, paste sintético.

Mudou:

| handoff | brow |
|---|---|
| daemon global em `~/.me/`, socket compartilhado | daemon por pasta, tudo em `<repo>/.brow/` |
| multi-tab com claim de sessão (`eval "$(handoff session)"`) | uma aba por sessão; sessões são Chromes separados, sem claim, sem `--tab` |
| Playwright + playwright-extra + stealth + sharp | CDP cru por pipe, **zero dependências** |
| click/press por dispatch JS | input real, com queda pra JS quando o hit-test falha |
| settled cego pra render em `setTimeout` (limitação documentada) | timer pós-request entra no contrato |
| settled trava até o timeout em página que muta sempre | janela de tolerância → `dom-busy` |

Ficou de fora de propósito: multi-tab, replay log, Live View / handoff humano,
stealth anti-bot, plugins de site.

## Limitações declaradas

- **`paste` só serve pra editor rico.** Lexical/ProseMirror/Quill leem o
  `clipboardData` do evento; `<input>` comum ignora `ClipboardEvent` sintético.
  O retorno traz `handled: false` quando ninguém tratou — nesse caso use `type`.
- **Sem stealth.** É Chrome de verdade com perfil persistente, o que já passa em
  muito site, mas não tem `playwright-extra`/stealth plugin. Cloudflare Turnstile
  vai barrar.
- **`--headed` precisa de display.** No WSL sem X/Wayland, só headless.
- **Site que nunca para de carregar** gasta o teto de settle (8s) em toda ação.
  Nesses, use `--no-wait` + `wait-label`/`wait-request`.
- **`iframe` cross-origin** não entra no snapshot (a sessão CDP é do frame
  principal).

## Env

| var | default | o quê |
|---|---|---|
| `BROW_HOME` | `<cwd>/.brow` | onde mora o estado (todo o resto é derivado daqui) |
| `BROW_SESSION` | `default` | sessão usada quando nenhuma é passada |
| `BROW_CHROME` | autodetect | binário do Chrome |
| `BROW_HEADED` | `0` | `1` abre janela |
| `BROW_IDLE` | `1800` | segundos até desligar sozinho (`0` = nunca) |
| `BROW_WIDTH` / `BROW_HEIGHT` | `1280` / `800` | viewport |
| `BROW_SETTLE_TIMEOUT` | `8000` | teto do settle (ms) |
| `BROW_QUIET_MS` | `250` | janela de silêncio exigida |
| `BROW_DOM_GRACE_MS` | `600` | tolerância pra DOM que não para |
| `BROW_NET_ECHO_MS` | `500` | depois do último fetch/XHR, quanto a rede ainda conta como ocupada (render que vem num timer curto) |
| `BROW_LOAD_TIMEOUT` | `15000` | teto do DOMContentLoaded no `nav` |
| `BROW_NO_SANDBOX` | — | `1` força `--no-sandbox` (o boot já tenta sozinho se o sandbox falhar) |
| `BROW_CHROME_ARGS` | — | flags extras pro Chrome |

## Testes

```bash
node test/smoke.mjs
```

Sobe servidor e daemon próprios (`BROW_HOME` temporário, não encosta na sua
sessão) e cobre: boot, **contenção do estado dentro da pasta**, sid estável entre
re-renders, input real, fallback de clique ocluso, guard de aba única nos dois
caminhos, render tardio pós-fetch, página com ticker, `wait-request`, `see`,
persistência de sessão entre restarts, erro limpo sem derrubar o daemon, e
sessões paralelas isoladas (Chromes e localStorage separados).
