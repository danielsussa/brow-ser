#!/usr/bin/env node
// Servidor MCP (stdio, JSON-RPC 2.0 por linha). Zero deps — o SDK do MCP não
// paga o próprio peso pra 16 tools sem prompts nem resources.
//
// Registrar no .mcp.json do repo que usa o browser:
//   { "mcpServers": { "brow": { "command": "node", "args": ["<path>/src/mcp.js"] } } }
import { createInterface } from "node:readline";
import { Session, sessions, stopSession } from "./client.js";
import { STATE_DIR, sessionName } from "./paths.js";

// Uma conexão por sessão. Cada sessão é um daemon/Chrome/perfil separado, então
// dois agentes (ou duas tarefas) não brigam pela mesma aba.
const conns = new Map();
function conn(name) {
  const key = sessionName(name);
  let c = conns.get(key);
  if (!c) conns.set(key, (c = new Session(key)));
  return c;
}
const s = (desc, extra = {}) => ({ type: "string", description: desc, ...extra });
const b = (desc) => ({ type: "boolean", description: desc });
const n = (desc) => ({ type: "number", description: desc });

const REF = s("ref do elemento: o `id` sequencial ou o `sid` estável vindos de browser_snapshot");

const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navega a aba única para uma URL e espera a página assentar.",
    inputSchema: { type: "object", properties: { url: s("URL (aceita 'example.com')"), noWait: b("pula a espera de settle") }, required: ["url"] },
    cmd: (a) => ["navigate", { url: a.url, noWait: a.noWait }],
  },
  {
    name: "browser_snapshot",
    description:
      "Estado da página para o agente: elementos interativos (com id sequencial e sid estável que sobrevive a re-render) mais o texto visível. Chame isto antes de clicar/digitar.",
    inputSchema: { type: "object", properties: {} },
    cmd: () => ["snapshot", {}],
  },
  {
    name: "browser_click",
    description: "Clica um elemento por ref. Usa mouse real; cai em dispatch JS se o ponto estiver coberto.",
    inputSchema: { type: "object", properties: { ref: REF, noWait: b("pula a espera de settle") }, required: ["ref"] },
    cmd: (a) => ["click", { ref: a.ref, noWait: a.noWait }],
  },
  {
    name: "browser_click_label",
    description: "Clica o elemento cujo label casa com o regex. Entre empates prefere o label mais curto.",
    inputSchema: {
      type: "object",
      properties: { pattern: s("regex, ex: '^Continuar$'"), strict: b("erra se houver mais de um match"), noWait: b("") },
      required: ["pattern"],
    },
    cmd: (a) => ["clickLabel", { pattern: a.pattern, strict: a.strict, noWait: a.noWait }],
  },
  {
    name: "browser_type",
    description: "Digita num campo. Input real (React/Vue/Lexical enxergam como digitação humana).",
    inputSchema: {
      type: "object",
      properties: { ref: REF, text: s("texto"), clear: b("limpa antes (default true)"), noWait: b("") },
      required: ["ref", "text"],
    },
    cmd: (a) => ["type", { ref: a.ref, text: a.text, clear: a.clear, noWait: a.noWait }],
  },
  {
    name: "browser_press",
    description: "Pressiona uma tecla: Enter, Tab, Escape, Arrow*, Space, Home, End, PageUp/Down, ou um único caractere.",
    inputSchema: { type: "object", properties: { key: s("tecla"), noWait: b("") }, required: ["key"] },
    cmd: (a) => ["press", { key: a.key, noWait: a.noWait }],
  },
  {
    name: "browser_hover",
    description: "Passa o mouse sobre um elemento (revela menu/tooltip que só aparece no hover).",
    inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"] },
    cmd: (a) => ["hover", { ref: a.ref }],
  },
  {
    name: "browser_see",
    description: "Screenshot da viewport (ou de um elemento) já redimensionado, para você OLHAR a página.",
    inputSchema: { type: "object", properties: { ref: s("opcional: recorta neste elemento"), maxPx: n("lado maior, default 512") } },
    cmd: (a) => ["see", { ref: a.ref, maxPx: a.maxPx }],
    image: true,
  },
  {
    name: "browser_wait_label",
    description: "Espera um elemento com este label aparecer. Use no lugar de sleep depois de uma ação que muda de tela.",
    inputSchema: { type: "object", properties: { pattern: s("regex do label"), timeoutMs: n("default 15000") }, required: ["pattern"] },
    cmd: (a) => ["waitLabel", { pattern: a.pattern, timeoutMs: a.timeoutMs }],
  },
  {
    name: "browser_wait_until",
    description: "Faz polling de uma expressão JS até virar truthy. Tolera navegação no meio.",
    inputSchema: { type: "object", properties: { expression: s("expressão JS"), timeoutMs: n("default 15000") }, required: ["expression"] },
    cmd: (a) => ["waitUntil", { expression: a.expression, timeoutMs: a.timeoutMs }],
  },
  {
    name: "browser_wait_request",
    description:
      "Espera uma chamada de rede terminar e devolve o status HTTP. Padrão glob ('*/api/submit*') ou /regex/. Pega também requests que acabaram de terminar.",
    inputSchema: {
      type: "object",
      properties: { pattern: s("glob ou /regex/"), method: s("filtro de método HTTP"), timeoutMs: n("default 30000"), matchRecentMs: n("default 3000") },
      required: ["pattern"],
    },
    cmd: (a) => ["waitRequest", { pattern: a.pattern, method: a.method, timeoutMs: a.timeoutMs, matchRecentMs: a.matchRecentMs }],
  },
  {
    name: "browser_exec",
    description: "Avalia uma expressão JS na página e devolve o resultado em JSON.",
    inputSchema: { type: "object", properties: { expression: s("expressão JS") }, required: ["expression"] },
    cmd: (a) => ["exec", { expression: a.expression }],
  },
  {
    name: "browser_history",
    description: "Volta, avança ou recarrega a aba.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["back", "forward", "reload"] } }, required: ["action"] },
    cmd: (a) => [a.action, {}],
  },
  {
    name: "browser_status",
    description: "URL, título e quantas requisições estão em voo agora.",
    inputSchema: { type: "object", properties: {} },
    cmd: () => ["status", {}],
  },
  {
    name: "browser_sessions",
    description: "Lista as sessões desta pasta (cada uma é um Chrome separado, com perfil e aba próprios) e quais estão de pé.",
    inputSchema: { type: "object", properties: {} },
    run: () => sessions(),
    global: true,
  },
  {
    name: "browser_close",
    description: "Fecha o Chrome de uma sessão. O perfil (cookies, logins) fica no disco; a próxima chamada sobe de novo.",
    inputSchema: { type: "object", properties: {} },
    run: async (a) => {
      const name = sessionName(a.session);
      conns.get(name)?.close();
      conns.delete(name);
      return (await stopSession(name)) ? `sessão ${name} fechada` : `sessão ${name} não estava rodando`;
    },
  },
];

const SESSION = s(
  "opcional: nome da sessão (letras, números, _ . -). Cada sessão é um Chrome separado, com perfil, cookies e aba próprios — use uma por tarefa paralela. Omitido = sessão default"
);
for (const t of TOOLS) if (!t.global) t.inputSchema.properties.session = SESSION;

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// stdin pode fechar com chamadas ainda em voo (o daemon leva segundos num
// wait-request). Só saímos quando não há nada pendente.
let pending = 0;
let stdinClosed = false;
const maybeExit = () => {
  if (stdinClosed && pending === 0) process.exit(0);
};
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(id, params) {
  const tool = BY_NAME.get(params?.name);
  if (!tool) return fail(id, -32602, `tool desconhecida: ${params?.name}`);
  const args = params.arguments ?? {};
  pending++;
  try {
    let result;
    if (tool.run) {
      result = await tool.run(args);
    } else {
      const [cmd, payload] = tool.cmd(args);
      result = await conn(args.session).call(cmd, payload);
    }
    if (tool.image && result?.base64) {
      return reply(id, {
        content: [
          { type: "image", data: result.base64, mimeType: "image/jpeg" },
          { type: "text", text: `${result.width}x${result.height}, ${(result.bytes / 1024).toFixed(1)}KB` },
        ],
      });
    }
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return reply(id, { content: [{ type: "text", text: text ?? "null" }] });
  } catch (e) {
    return reply(id, { content: [{ type: "text", text: `erro: ${e?.message ?? e}` }], isError: true });
  } finally {
    pending--;
    maybeExit();
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id == null) return; // notificação: nada a responder

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "brow", version: "0.1.0", description: `browser contido em ${STATE_DIR}: uma aba por sessão, sessões isoladas entre si` },
      });
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call":
      return callTool(id, params);
    case "ping":
      return reply(id, {});
    default:
      return fail(id, -32601, `método não suportado: ${method}`);
  }
});

process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});
