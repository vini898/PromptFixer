// Content script do Prompt Fixer.
//
// Injeta uma caixinha flutuante na página do Claude / ChatGPT / Gemini.
// O usuário escreve o prompt ali, a extensão manda pro backend otimizar,
// e o resultado já é inserido e enviado no campo de texto da própria IA.
// Também mostra a economia de tokens acumulada nessa conversa.

(() => {
  // Evita injetar duas vezes (ex.: navegação SPA disparando o content script de novo)
  if (window.__promptOtimizadorInjetado) return;
  window.__promptOtimizadorInjetado = true;

  const COST_PER_1K_TOKENS_USD = 0.03; // mesma estimativa ilustrativa do backend

  // ---------- Detecção do site ----------

  function getSite() {
    const host = location.hostname;
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "chatgpt";
    if (host.includes("gemini.google.com")) return "gemini";
    if (host.includes("deepseek.com")) return "deepseek";
    if (host.includes("perplexity.ai")) return "perplexity";
    return "generic";
  }

  const SITE_LABEL = {
    claude: "Claude",
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    perplexity: "Perplexity",
    generic: "IA",
  };

  const COMPOSER_SELECTORS = {
    claude: [
      'div[contenteditable="true"].ProseMirror',
      'div[aria-label="Write your prompt to Claude"]',
    ],
    chatgpt: [
      "#prompt-textarea",
      'div#prompt-textarea[contenteditable="true"]',
      "textarea#prompt-textarea",
    ],
    gemini: ["rich-textarea .ql-editor", 'div.ql-editor[contenteditable="true"]'],
    deepseek: ["#chat-input", 'textarea[placeholder*="DeepSeek"]', 'div[contenteditable="true"]'],
    perplexity: ['textarea[placeholder*="Ask"]', 'textarea[placeholder*="Pergunta"]', "textarea"],
    generic: [],
  };

  const SEND_BUTTON_SELECTORS = {
    claude: ['button[aria-label="Send Message"]', 'button[aria-label="Send message"]'],
    chatgpt: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
    gemini: ['button[aria-label="Send message"]', "button.send-button"],
    deepseek: ['div[role="button"][aria-label*="send"]', 'button[aria-label*="Send"]', 'div._send_button'],
    perplexity: ['button[aria-label="Submit"]', 'button[aria-label="Send"]', 'button[aria-label*="Enviar"]'],
    generic: [],
  };

  const FALLBACK_SELECTORS = ['div[contenteditable="true"]', "textarea"];

  function findComposer(site) {
    const candidates = [...(COMPOSER_SELECTORS[site] || []), ...FALLBACK_SELECTORS];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findSendButton(site) {
    for (const sel of SEND_BUTTON_SELECTORS[site] || []) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Insere texto no campo da IA de um jeito que React/ProseMirror/Lexical
  // reconhecem como digitação de verdade (não só um `.value = ...` mudo).
  function insertText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  async function insertAndSend(text, site) {
    const composer = findComposer(site);
    if (!composer) {
      return { inserted: false, sent: false };
    }

    insertText(composer, text);
    await sleep(200); // dá tempo da UI habilitar o botão de enviar

    const sendBtn = findSendButton(site);
    if (sendBtn) {
      sendBtn.click();
      return { inserted: true, sent: true };
    }

    // fallback: simula Enter (a maioria dessas caixas envia com Enter e
    // quebra linha com Shift+Enter)
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
    );
    composer.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
    );
    return { inserted: true, sent: false };
  }

  // ---------- Persistência de estatísticas por conversa ----------

  function statsKey() {
    return `stats:${location.hostname}${location.pathname}`;
  }

  async function loadStats() {
    const key = statsKey();
    const data = await chrome.storage.local.get(key);
    return data[key] || { tokensSaved: 0, requests: 0, costSaved: 0 };
  }

  async function addStats(tokensSaved) {
    const key = statsKey();
    const prev = await loadStats();
    const updated = {
      tokensSaved: prev.tokensSaved + tokensSaved,
      requests: prev.requests + 1,
      costSaved: prev.costSaved + (tokensSaved / 1000) * COST_PER_1K_TOKENS_USD,
    };
    await chrome.storage.local.set({ [key]: updated });
    return updated;
  }

  // ---------- Chamada ao backend (via background, ver background.js) ----------

  function optimizePrompt(prompt, mode) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "OPTIMIZE_PROMPT", prompt, mode }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  // ---------- Widget (Shadow DOM para não brigar com o CSS do site) ----------

  function buildWidget(site) {
    const host = document.createElement("div");
    host.id = "prompt-fixer-widget-host";
    host.style.all = "initial";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }

      :host {
        --bg-surface:   #13151c;
        --bg-card:      #181a23;
        --bg-input:     #1c1e28;
        --border:       rgba(255,255,255,0.07);
        --border-focus: rgba(99,102,241,0.5);

        --text:         #eef0fc;
        --text-2:       #7b7f9a;
        --text-3:       #3d4055;

        --accent:       #6366f1;
        --accent-glow:  rgba(99,102,241,0.28);
        --green:        #10b981;
        --green-bg:     rgba(16,185,129,0.12);
        --red:          #ef4444;

        --grad:         linear-gradient(135deg, #6366f1, #8b5cf6);

        --radius:       10px;
        --radius-sm:    6px;
        --radius-lg:    14px;

        --trans:        0.18s cubic-bezier(0.4,0,0.2,1);
      }

      * {
        box-sizing: border-box;
        font-family: 'Inter', -apple-system, "Segoe UI", Roboto, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      /* ── FAB ─────────────────────────────────── */
      .fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: var(--grad);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        cursor: pointer;
        box-shadow: 0 4px 20px var(--accent-glow);
        z-index: 2147483000;
        user-select: none;
        transition: var(--trans);
        border: 1px solid rgba(255,255,255,0.12);
      }
      .fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 28px var(--accent-glow);
      }
      .fab:active { transform: scale(0.96); }

      .badge {
        position: absolute;
        top: -5px;
        right: -5px;
        background: var(--green);
        color: #06281c;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        padding: 2px 5px;
        min-width: 16px;
        text-align: center;
        line-height: 1.3;
        display: none;
        border: 2px solid #0d0f14;
      }
      .badge.show { display: block; }

      /* ── Panel ───────────────────────────────── */
      .panel {
        position: fixed;
        bottom: 88px;
        right: 24px;
        width: 320px;
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: 0 20px 50px rgba(0,0,0,.45);
        z-index: 2147483000;
        display: none;
        overflow: hidden;
        animation: pf-fade-in 0.18s ease-out;
      }
      .panel.open { display: block; }

      @keyframes pf-fade-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .panel header {
        background: rgba(255,255,255,0.02);
        border-bottom: 1px solid var(--border);
        color: var(--text);
        padding: 12px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .brand-icon {
        font-size: 15px;
        background: var(--grad);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        line-height: 1;
      }
      .brand-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-2);
        letter-spacing: -0.2px;
      }
      .brand-name strong {
        font-weight: 800;
        background: var(--grad);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .brand-site {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--text-3);
      }

      .panel header button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-2);
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        transition: var(--trans);
      }
      .panel header button:hover {
        background: rgba(255,255,255,0.1);
        color: var(--text);
      }

      .panel main {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      textarea, select {
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-input);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        font-size: 12.5px;
        color: var(--text);
        resize: vertical;
        font-family: inherit;
        outline: none;
        transition: var(--trans);
      }
      textarea { min-height: 74px; line-height: 1.55; }
      textarea::placeholder { color: var(--text-3); }
      textarea:focus, select:focus {
        border-color: var(--border-focus);
        background: rgba(99,102,241,0.05);
        box-shadow: 0 0 0 3px var(--accent-glow);
      }

      select {
        appearance: none;
        -webkit-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M6 8L1 3h10z' fill='%237b7f9a'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 12px center;
        padding-right: 32px;
        cursor: pointer;
      }
      select option { background: var(--bg-card); color: var(--text); }

      .send-btn {
        width: 100%;
        padding: 11px;
        border: none;
        border-radius: var(--radius);
        background: var(--grad);
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        font-family: inherit;
        letter-spacing: 0.02em;
        cursor: pointer;
        box-shadow: 0 4px 18px var(--accent-glow);
        transition: var(--trans);
      }
      .send-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 26px var(--accent-glow);
      }
      .send-btn:active { transform: scale(0.98); }
      .send-btn:disabled {
        background: linear-gradient(135deg, #2d2f3d, #232535);
        color: var(--text-3);
        cursor: not-allowed;
        box-shadow: none;
        transform: none;
      }

      .status {
        font-size: 11.5px;
        color: var(--text-2);
        min-height: 14px;
        line-height: 1.5;
      }
      .status.error { color: #fca5a5; }

      .stats {
        padding: 10px 12px;
        background: var(--green-bg);
        border: 1px solid rgba(16,185,129,0.28);
        border-radius: var(--radius);
        font-size: 11.5px;
        color: #6ee7b7;
        line-height: 1.55;
      }
      .stats strong { font-size: 13px; color: var(--green); }

      /* ── Scrollbar ───────────────────────────── */
      ::-webkit-scrollbar { width: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 2px; }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <header>
        <div class="brand">
          <span class="brand-icon">✦</span>
          <span class="brand-name">Prompt<strong>AI</strong></span>
          <span class="brand-site">· ${SITE_LABEL[site]}</span>
        </div>
        <button data-action="close" title="Minimizar">✕</button>
      </header>
      <main>
        <textarea data-el="input" placeholder="Escreva seu prompt aqui..."></textarea>
        <select data-el="mode">
          <option value="otimizar">⚡ Otimizar — mais claro e curto</option>
          <option value="enriquecimento">✨ Enriquecer — mais detalhado</option>
          <option value="resumir">📋 Resumir</option>
          <option value="traduzir">🌍 Traduzir para inglês</option>
          <option value="codigo">💻 Formatar para assistente de código</option>
        </select>
        <button class="send-btn" data-action="send">Otimizar e enviar</button>
        <div class="status" data-el="status"></div>
        <div class="stats" data-el="stats">
          Economia nesta conversa: <strong data-el="statsTokens">0</strong> tokens
          (~$<span data-el="statsCost">0.00</span>) em <span data-el="statsRequests">0</span> prompt(s)
        </div>
      </main>
    `;

    const fab = document.createElement("div");
    fab.className = "fab";
    fab.title = "Prompt Fixer";
    fab.innerHTML = `✦<span class="badge" data-el="badge"></span>`;

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(fab);

    const els = {
      input: panel.querySelector('[data-el="input"]'),
      mode: panel.querySelector('[data-el="mode"]'),
      status: panel.querySelector('[data-el="status"]'),
      sendBtn: panel.querySelector('[data-action="send"]'),
      statsTokens: panel.querySelector('[data-el="statsTokens"]'),
      statsCost: panel.querySelector('[data-el="statsCost"]'),
      statsRequests: panel.querySelector('[data-el="statsRequests"]'),
      badge: fab.querySelector('[data-el="badge"]'),
    };

    function setStatus(msg, isError = false) {
      els.status.textContent = msg;
      els.status.classList.toggle("error", isError);
    }

    function renderStats(stats) {
      els.statsTokens.textContent = Math.max(0, Math.round(stats.tokensSaved));
      els.statsCost.textContent = stats.costSaved.toFixed(2);
      els.statsRequests.textContent = stats.requests;

      if (stats.requests > 0) {
        els.badge.textContent = stats.tokensSaved > 0 ? Math.round(stats.tokensSaved) : "✓";
        els.badge.classList.add("show");
      }
    }

    fab.addEventListener("click", () => panel.classList.toggle("open"));
    panel.querySelector('[data-action="close"]').addEventListener("click", () => panel.classList.remove("open"));

    els.sendBtn.addEventListener("click", async () => {
      const prompt = els.input.value.trim();
      if (!prompt) {
        setStatus("Escreva um prompt primeiro.", true);
        return;
      }

      els.sendBtn.disabled = true;
      setStatus("Otimizando...");

      const result = await optimizePrompt(prompt, els.mode.value);

      if (!result.ok) {
        setStatus(`Falha: ${result.error}`, true);
        els.sendBtn.disabled = false;
        return;
      }

      const { optimized_prompt, tokens_saved } = result.data;

      const { sent } = await insertAndSend(optimized_prompt || prompt, site);

      const updatedStats = await addStats(tokens_saved || 0);
      renderStats(updatedStats);

      if (sent) {
        setStatus(`Enviado! Economia de ${tokens_saved} tokens.`);
        els.input.value = "";
      } else {
        setStatus("Otimizado e inserido no campo — pressione Enter para enviar.");
      }

      els.sendBtn.disabled = false;
    });

    // Enter (sem shift) na textarea do widget já dispara o envio
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        els.sendBtn.click();
      }
    });

    loadStats().then(renderStats);
  }

  async function handleRedirectedPrompt(site) {
    const params = new URLSearchParams(location.search);
    const prompt = params.get("q") || params.get("prompt");
    if (!prompt) return;

    let attempts = 0;
    while (attempts < 15) {
      const composer = findComposer(site);
      if (composer) {
        await sleep(500);
        await insertAndSend(prompt, site);

        // Limpa o parâmetro de busca da URL para evitar reenviar caso o usuário dê F5
        try {
          const cleanUrl = window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
        } catch {
          // ignora erro de manipulação de história
        }
        break;
      }
      await sleep(400);
      attempts++;
    }
  }

  async function init() {
    const site = getSite();
    handleRedirectedPrompt(site);

    const { widgetEnabled } = await chrome.storage.sync.get("widgetEnabled");
    if (widgetEnabled === false) return;

    buildWidget(site);
  }

  init();
})();
