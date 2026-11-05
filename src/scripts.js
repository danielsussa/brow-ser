// JS injetado na página. Isto é o coração "AI-friendly" do handoff, portado pra
// rodar sob CDP puro: nada aqui depende de Playwright/Electron.
//
//  - BOOTSTRAP: __brow.lastMutation (MutationObserver), num mundo isolado =
//    metade DOM do contrato "página pronta" (a metade rede vem do daemon).
//    Mais o guard de single-tab pra target=_blank.
//  - SNAPSHOT: elementos interativos com `id` sequencial + `sid` determinístico
//    (FNV-1a de role|label|ancestor-chain|sibling-index) que sobrevive a
//    re-render de SPA.
//  - probeJs/clickJs/typeJs/...: resolução de ref e ações de fallback.

// Roda num MUNDO ISOLADO (worldName TRACKER_WORLD), não no mundo da página:
// nada aqui pode alterar globais do site. Wrapper de fetch/XHR/setTimeout e
// window.open sobrescrito são detectáveis (o anti-bot do YouTube corta o vídeo
// em ~40s quando vê fetch não-nativo). Requests em voo vêm dos eventos Network
// no daemon; aqui fica só o que se vê pelo DOM (compartilhado entre mundos).
export const TRACKER_WORLD = "__brow";

export const BOOTSTRAP = /* js */ `
(() => {
  if (window.__brow) return;
  let lastMutation = Date.now();

  const startObserver = () => {
    if (!document.documentElement) { setTimeout(startObserver, 10); return; }
    try {
      new MutationObserver(() => { lastMutation = Date.now(); }).observe(
        document.documentElement,
        { childList: true, subtree: true, attributes: true, characterData: true }
      );
    } catch (e) { /* ignore */ }
  };
  startObserver();

  // --- single tab -----------------------------------------------------------
  // target=_blank vira navegação aqui mesmo (o DOM é compartilhado, então dá
  // pra fazer do mundo isolado). window.open não dá sem tocar no global do
  // site: fica com o watchdog de Target.targetCreated no daemon.
  try {
    document.addEventListener('click', (e) => {
      const t = e.target;
      const a = t && t.closest ? t.closest('a[target]') : null;
      if (a && a.target && a.target !== '_self') a.target = '_self';
    }, true);
  } catch (e) { /* ignore */ }

  window.__brow = {
    get lastMutation() { return lastMutation; },
  };
})();
`;

export const SNAPSHOT = /* js */ `
(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="combobox"]', '[role="checkbox"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="tab"]', '[role="option"]', '[role="switch"]', '[role="radio"]',
    '[role="searchbox"]', '[role="slider"]', '[role="spinbutton"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]', '[contenteditable=""]'
  ].join(',');

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  };

  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText || n.textContent || '');
      if (parts.length) return parts.join(' ');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.labels && el.labels.length) return el.labels[0].innerText;
      const ph = el.getAttribute('placeholder');
      if (ph) return ph;
      const title = el.getAttribute('title');
      if (title) return title;
      return el.getAttribute('name') || el.getAttribute('type') || '';
    }
    const txt = (el.innerText || el.textContent || '').trim();
    if (txt) return txt;
    return el.getAttribute('title') || el.getAttribute('alt') || '';
  };

  // FNV-1a → 8 hex. Determinístico, sem deps, sem async.
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  const siblingIndex = (el) => {
    if (!el.parentElement) return 0;
    const peers = Array.prototype.filter.call(
      el.parentElement.children,
      (c) => c.tagName === el.tagName && c.getAttribute('role') === el.getAttribute('role')
    );
    return peers.indexOf(el);
  };

  const ancestorSig = (el) => {
    const parts = [];
    let cur = el.parentElement;
    for (let d = 0; cur && d < 4; d++) {
      parts.push(cur.tagName.toLowerCase() + '[' + siblingIndex(cur) + ']');
      cur = cur.parentElement;
    }
    return parts.join('/');
  };

  // Limpa marcas do snapshot anterior: um elemento que saiu do selector (ficou
  // escondido, mudou de role) não pode continuar respondendo por um ref antigo.
  document.querySelectorAll('[data-brow-id],[data-brow-sid],[data-brow-ref]').forEach((n) => {
    n.removeAttribute('data-brow-id');
    n.removeAttribute('data-brow-sid');
    n.removeAttribute('data-brow-ref');
  });

  const els = Array.prototype.filter.call(document.querySelectorAll(SELECTOR), isVisible);
  els.forEach((el, i) => el.setAttribute('data-brow-id', String(i)));

  const seen = new Map();
  const elements = els.map((el) => {
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = (labelFor(el) || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
    let sid = hash(role + '|' + label.slice(0, 80) + '|' + ancestorSig(el) + '|' + siblingIndex(el));
    const n = (seen.get(sid) || 0) + 1;
    seen.set(sid, n);
    if (n > 1) sid = sid + '_' + n;
    el.setAttribute('data-brow-sid', sid);

    const out = {
      id: el.getAttribute('data-brow-id'),
      sid: sid,
      tag: el.tagName.toLowerCase(),
      role: role,
      label: label,
    };
    const type = el.getAttribute('type');
    if (type) out.type = type;
    if (el.tagName === 'A' && el.getAttribute('href')) out.href = el.href.slice(0, 300);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      out.value = type === 'password' && (el.value || '').length ? '***' : (el.value || '').slice(0, 140);
    }
    if (el.tagName === 'SELECT') {
      out.value = el.value || '';
      out.options = Array.prototype.map.call(el.options, (o) => ({ value: o.value, label: o.text }));
    }
    if (el.disabled) out.disabled = true;
    if (el.checked != null && (type === 'checkbox' || type === 'radio')) out.checked = !!el.checked;
    return out;
  });

  const text = (document.body ? document.body.innerText || '' : '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .slice(0, 4000);

  return { url: location.href, title: document.title, elements: elements, text: text };
})();
`;

// --- helpers de ref ---------------------------------------------------------
// `ref` é o `id` (data-brow-id) OU o `sid` (data-brow-sid) do último snapshot.
const LOOKUP = `
  const q = (s) => document.querySelector(s);
  const esc = (v) => String(v).replace(/"/g, '\\\\"');
  const el = q('[data-brow-ref="' + esc(ref) + '"]')
    || q('[data-brow-id="' + esc(ref) + '"]')
    || q('[data-brow-sid="' + esc(ref) + '"]');
`;

// Resolução do alvo clicável: um wrapper visual sem handler (card JSF, div de
// SPA) resolve pro descendente que realmente clica. Regra do handoff.
const RESOLVE_TARGET = `
  const directly = (n) => (
    /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL)$/.test(n.tagName) ||
    n.hasAttribute('onclick') ||
    ['button','link','menuitem','tab','option','checkbox','radio','switch'].includes(n.getAttribute('role') || '')
  );
  const resolveTarget = (n) => {
    if (directly(n)) return n;
    const inner = n.querySelector('a[href], button, input[type="submit"], input[type="button"], [onclick], [role="button"], [role="link"]');
    return inner || n;
  };
`;

/** Mede o elemento e diz se um clique REAL naquele ponto acerta ele. */
export function probeJs(ref) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { found: false };
    ${RESOLVE_TARGET}
    const target = resolveTarget(el);
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = target.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
    const inView = r.width > 0 && r.height > 0 && x > 0 && y > 0 && x < vw && y < vh;
    const hit = inView ? document.elementFromPoint(x, y) : null;
    const hitOk = !!hit && (hit === target || target.contains(hit) || hit.contains(target));
    return {
      found: true, x: x, y: y, inView: inView, hitOk: hitOk,
      tag: target.tagName.toLowerCase(),
      label: (target.innerText || target.value || target.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      disabled: !!target.disabled,
    };
  })()`;
}

/** Fallback de click por dispatch JS (quando o hit-test real falha). */
export function clickJs(ref) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    ${RESOLVE_TARGET}
    const target = resolveTarget(el);
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    target.click();
    return { ok: true, via: 'js' };
  })()`;
}

/** Foca o elemento (pré-requisito do type via input real). */
export function focusJs(ref, { clear = false } = {}) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    el.focus();
    const typable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    if (!typable) return { ok: false, error: 'element is not typable: ' + el.tagName.toLowerCase() };
    if (${clear ? "true" : "false"}) {
      if (el.isContentEditable) {
        el.textContent = '';
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, focused: document.activeElement === el };
  })()`;
}

/** Fallback de type: setter nativo + input/change (React-safe). */
export function setValueJs(ref, text) {
  const lit = JSON.stringify(text);
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    if (el.isContentEditable) {
      el.textContent = ${lit};
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${lit}); else el.value = ${lit};
    } else {
      return { ok: false, error: 'element is not typable' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, via: 'js' };
  })()`;
}

/** Lê o valor atual — usado pra verificar se o input real "pegou". */
export function readValueJs(ref) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return null;
    return el.isContentEditable ? (el.textContent || '') : (el.value || '');
  })()`;
}

/** Paste sintético: ClipboardEvent + DataTransfer. Lexical/Slate/ProseMirror. */
export function pasteJs(ref, text) {
  const lit = JSON.stringify(text);
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', ${lit});
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    // Editor rico (Lexical/ProseMirror/Quill) trata o paste e chama
    // preventDefault. Input/textarea comum ignora ClipboardEvent sintetico:
    // handled=false ali e o esperado -- nesse caso use type.
    const delivered = el.dispatchEvent(ev);
    return { ok: true, handled: !delivered };
  })()`;
}

export function hoverJs(ref) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return { ok: false, error: 'ref not found: ' + ref };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mouseenter', o));
    el.dispatchEvent(new MouseEvent('mousemove', o));
    return { ok: true };
  })()`;
}

/** Bounding box em coordenadas de PÁGINA (pro clip do screenshot). */
export function boxJs(ref) {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    ${LOOKUP}
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  })()`;
}

/**
 * Acha elementos interativos cujo label casa com o regex. Entre empates prefere
 * o label MAIS CURTO — wrappers (JSF, cards) concatenam o texto dos filhos, e o
 * match curto é quase sempre o elemento real.
 */
export function findByLabelJs(pattern, flags) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
    const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
    };
    const labelOf = (el) => (
      el.getAttribute('aria-label') ||
      (el.tagName === 'INPUT' ? (el.getAttribute('placeholder') || el.value || el.getAttribute('name') || '') : '') ||
      el.innerText || el.textContent || ''
    ).replace(/\\s+/g, ' ').trim();
    document.querySelectorAll('[data-brow-ref]').forEach((n) => n.removeAttribute('data-brow-ref'));
    const hits = [];
    const nodes = document.querySelectorAll(SELECTOR);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      if (!label || !re.test(label)) continue;
      hits.push({ el: el, label: label });
    }
    hits.sort((a, b) => a.label.length - b.label.length);
    // marca só os que interessam, sem re-numerar o snapshot inteiro
    return hits.slice(0, 8).map((h, i) => {
      const key = '@' + i;
      h.el.setAttribute('data-brow-ref', key);
      return { ref: key, label: h.label.slice(0, 140), tag: h.el.tagName.toLowerCase() };
    });
  })()`;
}
