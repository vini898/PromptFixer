const DEFAULT_BACKEND_URL = "http://localhost:8000/api/optimize";

// A API devolve `detail` como string nos erros customizados dela, mas
// como uma LISTA de objetos {msg, loc, ...} nos erros de validação
// automáticos do FastAPI/Pydantic (HTTP 422). Sem isso, esses casos
// apareceriam pro usuário como "[object Object]".
function extractErrorDetail(body) {
  const d = body && body.detail;
  if (!d) return body && body.error;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e.msg || JSON.stringify(e)).join("; ");
  return body && body.error;
}

const els = {
  input:            document.getElementById("inputPrompt"),
  mode:             document.getElementById("modeSelect"),
  output:           document.getElementById("outputPrompt"),
  outputSection:    document.getElementById("outputSection"),
  optimizeBtn:      document.getElementById("optimizeBtn"),
  copyBtn:          document.getElementById("copyBtn"),
  status:           document.getElementById("status"),
  settingsToggle:   document.getElementById("settingsToggle"),
  settingsPanel:    document.getElementById("settingsPanel"),
  backendUrl:       document.getElementById("backendUrl"),
  widgetEnabled:    document.getElementById("widgetEnabled"),
  saveSettings:     document.getElementById("saveSettings"),
  tokenStats:       document.getElementById("tokenStats"),
  tokenStatText:    document.getElementById("tokenStatText"),
  savingStatText:   document.getElementById("savingStatText"),
  qualityStats:     document.getElementById("qualityStats"),
  qBefore:          document.getElementById("qBefore"),
  qAfter:           document.getElementById("qAfter"),
  micBtn:           document.getElementById("micBtn"),
  aiRecommendation: document.getElementById("aiRecommendation"),
  aiIcon:           document.getElementById("aiIcon"),
  aiName:           document.getElementById("aiName"),
  aiCompany:        document.getElementById("aiCompany"),
  aiModel:          document.getElementById("aiModel"),
  aiReason:         document.getElementById("aiReason"),
  sendToAiBtn:      document.getElementById("sendToAiBtn"),
  sendToAiLabel:    document.getElementById("sendToAiLabel"),
  templateSelect:   document.getElementById("templateSelect"),
};

let _currentAiData = null;
let _templates = [];

/* ── Templates (prontos + pessoais, vindos do backend) ──── */
function backendBaseUrl(optimizeUrl) {
  return optimizeUrl.replace(/\/api\/optimize\/?$/, "");
}

async function loadTemplates() {
  try {
    const base = backendBaseUrl(await getBackendUrl());
    const [readyRes, customRes] = await Promise.all([
      fetch(`${base}/api/templates`),
      fetch(`${base}/api/custom-templates`),
    ]);
    const ready = readyRes.ok ? await readyRes.json() : [];
    const custom = customRes.ok ? await customRes.json() : [];
    _templates = [
      ...custom.map((t) => ({ ...t, group: "Meus templates" })),
      ...ready.map((t) => ({ ...t, group: "Prontos" })),
    ];
    const groups = {};
    _templates.forEach((t, i) => { (groups[t.group] ||= []).push({ ...t, _idx: i }); });
    els.templateSelect.innerHTML = '<option value="">Selecione um template salvo...</option>' +
      Object.entries(groups).map(([group, items]) =>
        `<optgroup label="${group}">` +
        items.map((t) => `<option value="${t._idx}">${t.icon || "📌"} ${t.title}</option>`).join("") +
        `</optgroup>`
      ).join("");
  } catch {
    // Backend offline ou sem templates ainda — dropdown fica só com o
    // placeholder, sem quebrar o resto do popup.
  }
}
loadTemplates();

els.templateSelect.addEventListener("change", () => {
  const idx = els.templateSelect.value;
  if (idx === "") return;
  const tpl = _templates[parseInt(idx, 10)];
  if (!tpl) return;
  els.input.value = tpl.prompt;
  els.mode.value = tpl.mode;
  els.templateSelect.value = "";
  els.input.focus();
});

/* ── Status helper ────────────────────────────────── */
function setStatus(msg, isError = false) {
  if (!msg) {
    els.status.classList.add("hidden");
    return;
  }
  els.status.textContent = msg;
  els.status.classList.remove("hidden");
  els.status.classList.toggle("error", isError);
}

/* ── AI Recommendation ────────────────────────────── */
function renderAiRecommendation(data) {
  if (!data || !data.ai_name) {
    els.aiRecommendation.classList.add("hidden");
    return;
  }

  _currentAiData = data;
  els.aiRecommendation.style.setProperty("--ai-color", data.ai_color || "#6366f1");
  els.aiIcon.textContent    = data.ai_icon || "🤖";
  els.aiName.textContent    = data.ai_name;
  els.aiCompany.textContent = data.ai_company ? `(${data.ai_company})` : "";
  els.aiModel.textContent   = data.ai_model || "";
  els.aiReason.textContent  = data.ai_reason || "";
  els.sendToAiLabel.textContent = `🚀 Abrir no ${data.ai_name} →`;

  els.aiRecommendation.classList.remove("hidden");
}

/* ── Backend URL ──────────────────────────────────── */
async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.sync.get("backendUrl");
  return backendUrl || DEFAULT_BACKEND_URL;
}

/* ── Settings ─────────────────────────────────────── */
els.settingsToggle.addEventListener("click", async () => {
  els.settingsPanel.classList.toggle("hidden");
  els.backendUrl.value = await getBackendUrl();
  const { widgetEnabled } = await chrome.storage.sync.get("widgetEnabled");
  els.widgetEnabled.checked = widgetEnabled !== false;
});

els.saveSettings.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    backendUrl: els.backendUrl.value.trim(),
    widgetEnabled: els.widgetEnabled.checked,
  });
  setStatus("✓ Configurações salvas.");
  setTimeout(() => setStatus(""), 2500);
  els.settingsPanel.classList.add("hidden");
});

/* ── Optimize ─────────────────────────────────────── */
els.optimizeBtn.addEventListener("click", async () => {
  const prompt = els.input.value.trim();
  if (!prompt) {
    setStatus("Escreva um prompt antes de otimizar.", true);
    return;
  }

  els.optimizeBtn.disabled = true;
  els.outputSection.classList.add("hidden");
  els.tokenStats.classList.add("hidden");
  els.qualityStats.classList.add("hidden");
  els.aiRecommendation.classList.add("hidden");
  setStatus("⚡ Otimizando seu prompt...");

  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, mode: els.mode.value }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(extractErrorDetail(errBody) || `Erro ${res.status}`);
    }

    const data = await res.json();
    els.output.value = data.optimized_prompt || "";

    // Show output section
    if (els.output.value) {
      els.outputSection.classList.remove("hidden");
    }

    // Token stats
    if (typeof data.tokens_before === "number") {
      els.tokenStatText.textContent   = `${data.tokens_before} → ${data.tokens_after}`;
      els.savingStatText.textContent  = `${data.tokens_saved} (${data.tokens_saved_pct}%)`;
      els.tokenStats.classList.remove("hidden");
    }

    // Quality stats
    if (typeof data.quality_score_after === "number") {
      els.qBefore.textContent = `${data.quality_score_before}/100`;
      els.qAfter.textContent  = `${data.quality_score_after}/100`;
      els.qualityStats.classList.remove("hidden");
    }

    renderAiRecommendation(data);
    setStatus("");
  } catch (err) {
    setStatus(`Falha: ${err.message}`, true);
  } finally {
    els.optimizeBtn.disabled = false;
  }
});

/* ── Open Web App ─────────────────────────────────── */
const openWebAppBtn = document.getElementById("openWebAppBtn");
if (openWebAppBtn) {
  openWebAppBtn.addEventListener("click", () => {
    const webAppUrl = "http://localhost:8000/";
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: webAppUrl });
    } else {
      window.open(webAppUrl, "_blank");
    }
  });
}

/* ── Send to AI ───────────────────────────────────── */
els.sendToAiBtn.addEventListener("click", async () => {
  if (!_currentAiData) return;
  const prompt = els.output.value;
  if (!prompt) return;

  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = prompt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  setStatus(`✓ Copiado! Abrindo ${_currentAiData.ai_name}...`);
  const targetUrl = _currentAiData.ai_url;

  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: targetUrl });
  } else {
    window.open(targetUrl, "_blank");
  }
});

/* ── Copy Result ──────────────────────────────────── */
els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.output.value);
  const originalText = els.copyBtn.innerHTML;
  els.copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copiado!`;
  setTimeout(() => { els.copyBtn.innerHTML = originalText; }, 2000);
});

/* ── Voice Input ──────────────────────────────────── */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  els.micBtn.disabled = true;
  els.micBtn.title = "Reconhecimento de voz não suportado neste navegador";
} else {
  const recognition = new SpeechRecognition();
  recognition.lang = "pt-BR";
  recognition.interimResults = false;
  let listening = false;

  els.micBtn.addEventListener("click", () => {
    listening ? recognition.stop() : recognition.start();
  });

  recognition.addEventListener("start", () => {
    listening = true;
    els.micBtn.classList.add("listening");
    setStatus("🎤 Ouvindo...");
  });

  recognition.addEventListener("end", () => {
    listening = false;
    els.micBtn.classList.remove("listening");
    setStatus("");
  });

  recognition.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    els.input.value = els.input.value
      ? `${els.input.value} ${transcript}`
      : transcript;
  });

  recognition.addEventListener("error", (event) => {
    setStatus(`Erro no microfone: ${event.error}`, true);
  });
}
