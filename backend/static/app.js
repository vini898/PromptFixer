// ═══════════════════════════════════════════════════════════════
// Prompt Fixer — Single Page Application (v2)
// ═══════════════════════════════════════════════════════════════

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

// A API devolve `detail` como string nos nossos erros customizados, mas
// como uma LISTA de objetos {msg, loc, ...} nos erros de validação
// automáticos do FastAPI/Pydantic (HTTP 422). Sem isso, esses casos
// apareceriam pro usuário como "[object Object]".
function errorDetail(errBody, fallback) {
  const d = errBody && errBody.detail;
  if (!d) return fallback;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e.msg || JSON.stringify(e)).join("; ");
  return fallback;
}

// Monta um comando cURL reproduzível pra uma otimização — útil pra quem
// quiser automatizar/scriptar depois. Escapa aspas simples com o truque
// clássico de shell ('\'') pra funcionar mesmo com texto complexo.
function buildCurlCommand(prompt, mode) {
  const body = JSON.stringify({ prompt, mode });
  const escaped = body.replace(/'/g, `'"'"'`);
  return `curl -X POST http://localhost:8000/api/optimize \\\n  -H "Content-Type: application/json" \\\n  -d '${escaped}'`;
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ---------- Theme ----------
const themeSwitch = document.getElementById("themeSwitch");
const themeLabel = document.getElementById("themeLabel");

function applyThemeUI() {
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  themeSwitch.checked = theme === "dark";
  themeLabel.textContent = theme === "dark" ? "Modo escuro" : "Modo claro";
}
applyThemeUI();

themeSwitch.addEventListener("change", () => {
  const theme = themeSwitch.checked ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("po-theme", theme);
  applyThemeUI();
});

// ---------- Health check ----------
async function checkHealth() {
  const dot = document.getElementById("healthDot");
  const label = document.getElementById("healthLabel");
  const banner = document.getElementById("onboardingBanner");
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error();
    const data = await res.json();
    dot.className = "health-dot " + (data.any_provider_configured ? "online" : "offline");
    label.textContent = data.any_provider_configured
      ? `Online · ${data.active_provider} (${data.active_model})`
      : "Nenhum provedor configurado";
    banner.classList.toggle("hidden", data.any_provider_configured);
  } catch {
    dot.className = "health-dot offline";
    label.textContent = "Backend indisponível";
  }
}
checkHealth();

document.getElementById("onboardingGoBtn").addEventListener("click", () => switchView("settings"));

// ---------- View navigation ----------
const navItems = document.querySelectorAll(".nav-item");
const views = document.querySelectorAll(".view");
const loadedViews = { optimize: true };

function switchView(view) {
  navItems.forEach((b) => {
    const isActive = b.dataset.view === view;
    b.classList.toggle("active", isActive);
    if (isActive) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  views.forEach((s) => s.classList.toggle("active", s.id === `view-${view}`));
  if (view === "dashboard" && !loadedViews.dashboard) { loadDashboard(); loadedViews.dashboard = true; }
  if (view === "history" && !loadedViews.history) { loadHistory(); loadedViews.history = true; }
  if (view === "templates" && !loadedViews.templates) { loadTemplatesGrid(); loadCustomTemplatesGrid(); loadedViews.templates = true; }
  if (view === "settings") { loadSettings(); }
  if (view === "api" && !loadedViews.api) {
    document.getElementById("apiFrame").src = "/docs";
    loadedViews.api = true;
  }
}

navItems.forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

// ---------- DOM refs (Optimize view) ----------
const form = document.getElementById("optimizeForm");
const promptEl = document.getElementById("prompt");
const modeEl = document.getElementById("mode");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const resultSkeleton = document.getElementById("resultSkeleton");
const resultEl = document.getElementById("result");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copyBtn");
const micBtn = document.getElementById("micBtn");
const diffViewEl = document.getElementById("diffView");
const qualityReasonsEl = document.getElementById("qualityReasons");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("hidden", !msg);
  statusEl.style.color = isError ? "var(--color-danger)" : "var(--text-muted)";
}

// ---------- Contador de caracteres ----------
const MAX_PROMPT_CHARS = 6000;
const charCounterEl = document.getElementById("charCounter");
function updateCharCounter() {
  const len = promptEl.value.length;
  charCounterEl.textContent = `${len.toLocaleString("pt-BR")} / ${MAX_PROMPT_CHARS.toLocaleString("pt-BR")} caracteres`;
  charCounterEl.classList.toggle("warn", len >= MAX_PROMPT_CHARS * 0.85 && len < MAX_PROMPT_CHARS);
  charCounterEl.classList.toggle("limit", len >= MAX_PROMPT_CHARS);
}
promptEl.addEventListener("input", updateCharCounter);
updateCharCounter();

// ---------- Diff (LCS word-level) ----------
function wordDiff(oldText, newText) {
  const oldW = oldText.split(/(\s+)/), newW = newText.split(/(\s+)/);
  const n = oldW.length, m = newW.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldW[i] === newW[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0; const parts = [];
  while (i < n && j < m) {
    if (oldW[i] === newW[j]) { parts.push({ t: "s", x: oldW[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ t: "d", x: oldW[i] }); i++; }
    else { parts.push({ t: "a", x: newW[j] }); j++; }
  }
  while (i < n) { parts.push({ t: "d", x: oldW[i] }); i++; }
  while (j < m) { parts.push({ t: "a", x: newW[j] }); j++; }
  return parts;
}

function renderDiff(oldText, newText, target) {
  const el = target || diffViewEl;
  el.innerHTML = wordDiff(oldText, newText).map((p) => {
    if (p.t === "s") return esc(p.x);
    if (p.t === "d") return `<del>${esc(p.x)}</del>`;
    return `<ins>${esc(p.x)}</ins>`;
  }).join("");
}

// ---------- Quality gauge ----------
function qualityColorVar(score) {
  if (score >= 75) return "var(--color-success)";
  if (score >= 50) return "var(--color-accent)";
  return "var(--color-danger)";
}

function renderGauge(elId, valueId, score) {
  const gaugeEl = document.getElementById(elId);
  const valueEl = document.getElementById(valueId);
  gaugeEl.style.setProperty("--score", score);
  gaugeEl.style.setProperty("--gauge-color", qualityColorVar(score));
  valueEl.textContent = score;
}

function renderQuality(before, after, reasons) {
  renderGauge("gaugeBefore", "gaugeBeforeValue", before);
  renderGauge("gaugeAfter", "gaugeAfterValue", after);
  qualityReasonsEl.innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join("");
}

function renderTokensSourceBadge(source) {
  const el = document.getElementById("tokensSourceBadge");
  el.innerHTML = source === "real"
    ? `<span class="tokens-source-tag real">✓ Contagem real de tokens (tokenizador da Groq)</span>`
    : `<span class="tokens-source-tag estimado">≈ Estimativa local de tokens</span>`;
}

const MODE_LABELS = { otimizar: "Otimizar", enriquecimento: "Enriquecer", resumir: "Resumir", traduzir: "Traduzir", codigo: "Código" };

function renderResult(data) {
  outputEl.value = data.optimized_prompt;
  document.getElementById("tokensBefore").textContent = data.tokens_before;
  document.getElementById("tokensAfter").textContent = data.tokens_after;
  document.getElementById("tokensSaved").textContent = `${data.tokens_saved} (${data.tokens_saved_pct}%)`;
  renderTokensSourceBadge(data.tokens_source);
  const providerBadge = document.getElementById("providerBadge");
  providerBadge.textContent = data.provider_label
    ? `⚙️ Otimizado com ${data.provider_label}${data.from_cache ? " (resultado em cache)" : ""}`
    : "";
  document.getElementById("qualityReviewResult").classList.add("hidden");
  renderQuality(data.quality_score_before, data.quality_score_after, data.quality_reasons_after);
  renderDiff(data.original_prompt, data.optimized_prompt);
  renderAiRec(data);
  resultEl.classList.remove("hidden");
}

// ---------- Optimize form ----------
let _lastResponse = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  submitBtn.disabled = true;
  resultEl.classList.add("hidden");
  document.getElementById("simulationContainer").classList.add("hidden");
  resultSkeleton.classList.remove("hidden");
  setStatus("Otimizando...");
  try {
    const res = await fetch("/api/optimize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, mode: modeEl.value }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    _lastResponse = data;
    renderResult(data);
    resetChain(data.mode);
    setStatus("Pronto.");
    loadedViews.dashboard = false;
    loadedViews.history = false;
  } catch (err) { setStatus(`Falha: ${err.message}`, true); }
  finally { submitBtn.disabled = false; resultSkeleton.classList.add("hidden"); }
});

form.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); form.requestSubmit(); }
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(outputEl.value);
  showToast("Prompt copiado!");
});

document.getElementById("copyJsonBtn").addEventListener("click", async () => {
  if (!_lastResponse) return;
  await navigator.clipboard.writeText(JSON.stringify(_lastResponse, null, 2));
  showToast("Resposta JSON copiada!");
});

document.getElementById("copyCurlResultBtn").addEventListener("click", async () => {
  if (!_lastResponse) return;
  await navigator.clipboard.writeText(buildCurlCommand(_lastResponse.original_prompt, _lastResponse.mode));
  showToast("Comando cURL copiado!");
});

// ---------- Salvar como template ----------
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const saveTemplateForm = document.getElementById("saveTemplateForm");
const saveTemplateTitle = document.getElementById("saveTemplateTitle");

saveTemplateBtn.addEventListener("click", () => {
  if (!promptEl.value.trim()) { showToast("Escreva um prompt antes de salvar."); return; }
  saveTemplateForm.classList.toggle("hidden");
  if (!saveTemplateForm.classList.contains("hidden")) saveTemplateTitle.focus();
});

document.getElementById("cancelSaveTemplateBtn").addEventListener("click", () => {
  saveTemplateForm.classList.add("hidden");
  saveTemplateTitle.value = "";
});

document.getElementById("confirmSaveTemplateBtn").addEventListener("click", async () => {
  const title = saveTemplateTitle.value.trim();
  if (!title) { showToast("Dê um nome para o template."); return; }
  try {
    await fetch("/api/custom-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "", mode: modeEl.value, prompt: promptEl.value }),
    });
    _customTemplates = null; // invalida cache
    loadedViews.templates = false;
    saveTemplateForm.classList.add("hidden");
    saveTemplateTitle.value = "";
    showToast(`Template "${title}" salvo!`);
  } catch { showToast("Falha ao salvar template."); }
});

// ---------- Encadear modos ----------
let _chainTrail = [];
const chainModeSelect = document.getElementById("chainModeSelect");
const chainTrailEl = document.getElementById("chainTrail");

function populateChainSelect(excludeMode) {
  chainModeSelect.innerHTML = Object.entries(MODE_LABELS)
    .filter(([value]) => value !== excludeMode)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
}

function renderChainTrail() {
  if (_chainTrail.length < 2) { chainTrailEl.classList.add("hidden"); return; }
  chainTrailEl.textContent = "Cadeia aplicada: " + _chainTrail.map((m) => MODE_LABELS[m] || m).join(" → ");
  chainTrailEl.classList.remove("hidden");
}

function resetChain(initialMode) {
  _chainTrail = [initialMode];
  populateChainSelect(initialMode);
  renderChainTrail();
}

document.getElementById("chainApplyBtn").addEventListener("click", async () => {
  const nextMode = chainModeSelect.value;
  const currentOutput = outputEl.value.trim();
  if (!currentOutput || !nextMode) return;
  const btn = document.getElementById("chainApplyBtn");
  btn.disabled = true;
  setStatus(`Aplicando ${MODE_LABELS[nextMode]}...`);
  try {
    const res = await fetch("/api/optimize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: currentOutput, mode: nextMode }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    _lastResponse = data;
    renderResult(data);
    _chainTrail.push(nextMode);
    populateChainSelect(nextMode);
    renderChainTrail();
    setStatus("Pronto.");
    loadedViews.dashboard = false;
    loadedViews.history = false;
  } catch (err) { setStatus(`Falha: ${err.message}`, true); }
  finally { btn.disabled = false; }
});

// ---------- AI Recommendation ----------
let _aiData = null;
function renderAiRec(data) {
  const card = document.getElementById("aiRecommendation");
  if (!data.ai_name) { card.classList.add("hidden"); return; }
  _aiData = data;
  card.style.setProperty("--ai-color", data.ai_color || "#2563eb");
  document.getElementById("aiIcon").textContent = data.ai_icon || "🤖";
  document.getElementById("aiName").textContent = data.ai_name;
  document.getElementById("aiCompany").textContent = data.ai_company ? `(${data.ai_company})` : "";
  document.getElementById("aiModel").textContent = `Modelo recomendado: ${data.ai_model}`;
  document.getElementById("aiReason").textContent = data.ai_reason;
  document.getElementById("sendToAiLabel").textContent = `🚀 Abrir no ${data.ai_name} (${data.ai_model}) →`;
  card.classList.remove("hidden"); card.style.animation = "none"; card.offsetHeight; card.style.animation = "";
}

document.getElementById("sendToAiBtn").addEventListener("click", async () => {
  if (!_aiData) return;
  const p = outputEl.value; if (!p) return;
  try { await navigator.clipboard.writeText(p); } catch { const t = document.createElement("textarea"); t.value = p; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); }
  showToast(`Prompt copiado! Abrindo ${_aiData.ai_name}... Cole com Ctrl+V.`);
  setTimeout(() => window.open(_aiData.ai_url, "_blank"), 400);
});

// ---------- Simulation ----------
const simulateBtn = document.getElementById("simulateBtn");
if (simulateBtn) {
  simulateBtn.addEventListener("click", async () => {
    const p = outputEl.value.trim(); if (!p) return;
    simulateBtn.disabled = true;
    const cont = document.getElementById("simulationContainer");
    const stat = document.getElementById("simulationStatus");
    const out = document.getElementById("simulationOutput");
    cont.classList.remove("hidden"); stat.textContent = "Gerando..."; out.textContent = "Aguarde...";
    try {
      const res = await fetch("/api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: p }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `Erro ${res.status}`); }
      const d = await res.json(); stat.textContent = `Concluído! (via ${d.provider_label})`; out.textContent = d.simulated_response;
    } catch (e) { stat.textContent = "Erro!"; out.textContent = `Falha: ${e.message}`; }
    finally { simulateBtn.disabled = false; }
  });
}

// ---------- Toast ----------
function showToast(msg) {
  const t = document.getElementById("toast"); t.textContent = msg;
  t.classList.remove("hidden"); t.classList.add("show");
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.classList.add("hidden"), 400); }, 3500);
}

// ---------- Voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { micBtn.disabled = true; micBtn.title = "Não suportado"; }
else {
  const rec = new SR(); rec.lang = "pt-BR"; rec.interimResults = false; let on = false;
  micBtn.addEventListener("click", () => { on ? rec.stop() : rec.start(); });
  rec.addEventListener("start", () => { on = true; micBtn.classList.add("listening"); setStatus("Ouvindo..."); });
  rec.addEventListener("end", () => { on = false; micBtn.classList.remove("listening"); });
  rec.addEventListener("result", (e) => { promptEl.value = promptEl.value ? `${promptEl.value} ${e.results[0][0].transcript}` : e.results[0][0].transcript; updateCharCounter(); setStatus("Capturado."); });
  rec.addEventListener("error", (e) => { setStatus(`Erro voz: ${e.error}`, true); });
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════════════
let _templates = null;

async function fetchTemplates() {
  if (_templates) return _templates;
  const res = await fetch("/api/templates");
  _templates = await res.json();
  return _templates;
}

function useTemplate(tpl) {
  promptEl.value = tpl.prompt;
  modeEl.value = tpl.mode;
  updateCharCounter();
  // Esconde o resultado (e a cadeia de modos) de uma otimização anterior
  // — ele descreve um prompt diferente do que acabou de ser carregado,
  // então deixá-lo visível seria confuso até o usuário clicar em Otimizar.
  resultEl.classList.add("hidden");
  setStatus("");
  switchView("optimize");
  promptEl.focus();
  showToast(`Template "${tpl.title}" carregado`);
}

async function loadQuickChips() {
  const chips = await fetchTemplates();
  const box = document.getElementById("quickTemplateChips");
  box.innerHTML = chips.slice(0, 5).map((t, i) =>
    `<button type="button" class="template-chip" data-idx="${i}">${t.icon} ${esc(t.title)}</button>`
  ).join("");
  box.querySelectorAll(".template-chip").forEach((btn) => {
    btn.addEventListener("click", () => useTemplate(chips[parseInt(btn.dataset.idx, 10)]));
  });
}
loadQuickChips();

let _customTemplates = null;

async function fetchCustomTemplates() {
  if (_customTemplates) return _customTemplates;
  const res = await fetch("/api/custom-templates");
  _customTemplates = await res.json();
  return _customTemplates;
}

async function loadCustomTemplatesGrid() {
  const tpls = await fetchCustomTemplates();
  const grid = document.getElementById("customTemplatesGrid");
  const emptyEl = document.getElementById("customTemplatesEmpty");
  if (!tpls.length) { grid.innerHTML = ""; emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");
  grid.innerHTML = tpls.map((t, i) => `
    <div class="template-card">
      <div class="template-card-header">
        <div class="template-card-icon">📌</div>
        <button type="button" class="icon-btn-delete" data-del-idx="${i}" title="Excluir template">🗑️</button>
      </div>
      <h4>${esc(t.title)}</h4>
      <p>${esc(t.description || `Modo: ${MODE_LABELS[t.mode] || t.mode}`)}</p>
      <div class="form-actions-row">
        <button type="button" data-idx="${i}">Usar template →</button>
        ${detectPlaceholders(t.prompt).length ? `<button type="button" class="btn-ghost" data-fill-idx="${i}">📝 Preencher campos</button>` : ""}
      </div>
    </div>`).join("");
  grid.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => useTemplate(tpls[parseInt(btn.dataset.idx, 10)]));
  });
  grid.querySelectorAll("button[data-fill-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openTemplateFillModal(tpls[parseInt(btn.dataset.fillIdx, 10)]));
  });
  grid.querySelectorAll("button[data-del-idx]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tpl = tpls[parseInt(btn.dataset.delIdx, 10)];
      if (!confirm(`Excluir o template "${tpl.title}"?`)) return;
      await fetch(`/api/custom-templates/${tpl.id}`, { method: "DELETE" });
      _customTemplates = null;
      loadCustomTemplatesGrid();
    });
  });
}

async function loadTemplatesGrid() {
  const tpls = await fetchTemplates();
  const grid = document.getElementById("templatesGrid");
  grid.innerHTML = tpls.map((t, i) => `
    <div class="template-card">
      <div class="template-card-icon">${t.icon}</div>
      <h4>${esc(t.title)}</h4>
      <p>${esc(t.description)}</p>
      <div class="form-actions-row">
        <button type="button" data-idx="${i}">Usar template →</button>
        ${detectPlaceholders(t.prompt).length ? `<button type="button" class="btn-ghost" data-fill-idx="${i}">📝 Preencher campos</button>` : ""}
      </div>
    </div>`).join("");
  grid.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => useTemplate(tpls[parseInt(btn.dataset.idx, 10)]));
  });
  grid.querySelectorAll("button[data-fill-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openTemplateFillModal(tpls[parseInt(btn.dataset.fillIdx, 10)]));
  });
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
const ACHIEVEMENTS = [
  { threshold: 1, label: "🚀 Primeiro prompt" }, { threshold: 10, label: "🔥 10 prompts" },
  { threshold: 50, label: "💪 50 prompts" }, { threshold: 100, label: "🏆 100 prompts" },
];
const TOKEN_ACHIEVEMENTS = [
  { threshold: 100, label: "✨ 100 tokens economizados" }, { threshold: 1000, label: "🎯 1k tokens" },
  { threshold: 10000, label: "🥇 10k tokens" },
];

let modeChartInstance = null, dailyChartInstance = null, qualityChartInstance = null;

function chartTextColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#26223a";
}

async function loadDashboard() {
  try {
    const res = await fetch("/api/stats"); const s = await res.json();
    document.getElementById("dTotalRequests").textContent = s.total_requests;
    document.getElementById("dTotalSaved").textContent = s.total_tokens_saved.toLocaleString("pt-BR");
    document.getElementById("dAvgPct").textContent = `${s.avg_tokens_saved_pct}%`;
    document.getElementById("dCostSaved").textContent = `$${s.estimated_cost_saved_usd}`;
    document.getElementById("dAvgQuality").textContent = (s.avg_quality_gain >= 0 ? "+" : "") + s.avg_quality_gain;
    document.getElementById("dBestSaving").textContent = `${s.best_single_saving} tokens`;
    document.getElementById("dTopMode").textContent = s.most_used_mode || "—";
    document.getElementById("dFavorites").textContent = s.favorites_count;

    const aBox = document.getElementById("dAchievements");
    const unlocked = [...ACHIEVEMENTS.filter(a => s.total_requests >= a.threshold), ...TOKEN_ACHIEVEMENTS.filter(a => s.total_tokens_saved >= a.threshold)];
    if (unlocked.length) { aBox.classList.remove("hidden"); aBox.innerHTML = "<h3>Conquistas</h3><div class='badge-row'>" + unlocked.map(a => `<span class='badge'>${a.label}</span>`).join("") + "</div>"; }
    else { aBox.classList.add("hidden"); }

    const textColor = chartTextColor();
    const gridColor = "rgba(128,128,128,0.15)";

    const modeLabels = Object.keys(s.mode_usage), modeData = Object.values(s.mode_usage);
    if (modeChartInstance) modeChartInstance.destroy();
    modeChartInstance = new Chart(document.getElementById("modeChart"), {
      type: "doughnut",
      data: { labels: modeLabels.length ? modeLabels : ["Sem dados"], datasets: [{ data: modeData.length ? modeData : [1], backgroundColor: ["#6d4fe0", "#1fae7a", "#f2a340", "#e5484d", "#22b8cf", "#4285f4"] }] },
      options: { responsive: true, plugins: { legend: { position: "bottom", labels: { color: textColor } } } }
    });

    const dLabels = s.daily_tokens_saved.map(d => d.date), dVals = s.daily_tokens_saved.map(d => d.tokens_saved);
    if (dailyChartInstance) dailyChartInstance.destroy();
    dailyChartInstance = new Chart(document.getElementById("dailyChart"), {
      type: "line",
      data: { labels: dLabels.length ? dLabels : ["Sem dados"], datasets: [{ label: "Tokens economizados", data: dVals.length ? dVals : [0], borderColor: "#6d4fe0", backgroundColor: "rgba(109,79,224,0.12)", fill: true, tension: 0.3 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } } }
    });

    const qLabels = (s.daily_quality || []).map(d => d.date), qVals = (s.daily_quality || []).map(d => d.avg_quality_gain);
    if (qualityChartInstance) qualityChartInstance.destroy();
    qualityChartInstance = new Chart(document.getElementById("qualityChart"), {
      type: "bar",
      data: { labels: qLabels.length ? qLabels : ["Sem dados"], datasets: [{ label: "Ganho de qualidade", data: qVals.length ? qVals : [0], backgroundColor: "#1fae7a", borderRadius: 4 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { beginAtZero: true, ticks: { color: textColor }, grid: { color: gridColor } } } }
    });
  } catch (e) { console.error("Dashboard error:", e); }
}

const exportBtn = document.getElementById("exportBtn");
if (exportBtn) exportBtn.addEventListener("click", () => window.print());

// ═══════════════════════════════════════════════════════════════
// HISTÓRICO
// ═══════════════════════════════════════════════════════════════
let _historyItems = [];
const historyState = { q: "", mode: "", favorite_only: false, trashed: false, limit: 10, offset: 0, total: 0 };

function historyQueryString() {
  const params = new URLSearchParams();
  if (!historyState.trashed) {
    if (historyState.q) params.set("q", historyState.q);
    if (historyState.mode) params.set("mode", historyState.mode);
    if (historyState.favorite_only) params.set("favorite_only", "true");
  }
  params.set("limit", historyState.limit);
  params.set("offset", historyState.offset);
  return params.toString();
}

let _selectedIds = new Set();

async function loadHistory() {
  const tbody = document.getElementById("historyBody");
  const emptyEl = document.getElementById("historyEmpty");
  const endpoint = historyState.trashed ? "/api/history/trash" : "/api/history";
  _selectedIds.clear();
  updateBulkBar();
  const selectAllCb = document.getElementById("selectAllCheckbox");
  if (selectAllCb) selectAllCb.checked = false;
  try {
    const res = await fetch(`${endpoint}?${historyQueryString()}`);
    const data = await res.json();
    _historyItems = data.items;
    historyState.total = data.total;

    if (!_historyItems.length) {
      tbody.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.querySelector("h3").textContent = historyState.trashed ? "Lixeira vazia" : "Nenhum registro encontrado";
      emptyEl.querySelector("p").textContent = historyState.trashed
        ? "Itens excluídos do histórico aparecem aqui."
        : 'Otimize um prompt na aba "Otimizar" ou ajuste os filtros de busca.';
      document.getElementById("historyPagination").innerHTML = "";
      return;
    }
    emptyEl.classList.add("hidden");

    tbody.innerHTML = _historyItems.map((item, idx) => `
      <tr class="history-row" data-index="${idx}">
        <td><input type="checkbox" class="row-select" data-id="${item.id}" aria-label="Selecionar registro" /></td>
        <td>${new Date(item.created_at + "Z").toLocaleString("pt-BR")}</td>
        <td><span class="mode-badge mode-${item.mode}">${item.mode}</span></td>
        <td class="truncate" title="${esc(item.original_prompt)}">${item.note ? '<span title="Tem nota pessoal">📝</span> ' : ""}${esc(item.original_prompt)}</td>
        <td class="truncate" title="${esc(item.optimized_prompt)}">${esc(item.optimized_prompt)}</td>
        <td><strong>${item.tokens_before}</strong> → <strong>${item.tokens_after}</strong></td>
        <td>${item.quality_score_before} → ${item.quality_score_after}</td>
        <td class="row-actions">
          ${historyState.trashed ? `
            <button type="button" class="icon-btn-restore" data-id="${item.id}" title="Restaurar">♻️</button>
            <button type="button" class="icon-btn-delete" data-id="${item.id}" data-permanent="1" title="Excluir definitivamente">🗑️</button>
          ` : `
            <button type="button" class="star-btn ${item.favorite ? "active" : ""}" data-id="${item.id}" title="Favoritar">${item.favorite ? "★" : "☆"}</button>
            <button type="button" class="icon-btn-delete" data-id="${item.id}" title="Mover para lixeira">🗑️</button>
          `}
        </td>
      </tr>`).join("");

    tbody.querySelectorAll(".row-select").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        const id = parseInt(cb.dataset.id, 10);
        if (e.target.checked) _selectedIds.add(id); else _selectedIds.delete(id);
        updateBulkBar();
      });
    });
    tbody.querySelectorAll(".history-row").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".row-actions") || e.target.closest("input")) return;
        openModal(_historyItems[parseInt(tr.dataset.index, 10)]);
      });
    });
    tbody.querySelectorAll(".star-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleFavorite(parseInt(btn.dataset.id, 10));
      });
    });
    tbody.querySelectorAll(".icon-btn-restore").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await restoreHistoryItem(parseInt(btn.dataset.id, 10));
      });
    });
    tbody.querySelectorAll(".icon-btn-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        if (btn.dataset.permanent) {
          if (confirm("Excluir definitivamente? Essa ação não pode ser desfeita.")) await permanentDeleteHistoryItem(id);
        } else if (confirm("Mover este registro para a lixeira?")) {
          await deleteHistoryItem(id);
        }
      });
    });

    renderPagination();
  } catch (e) { tbody.innerHTML = `<tr><td colspan="8" class="text-center">Erro: ${e.message}</td></tr>`; }
}

function updateBulkBar() {
  const bar = document.getElementById("bulkActionBar");
  const count = _selectedIds.size;
  if (count === 0) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  document.getElementById("bulkCount").textContent = `${count} selecionado(s)`;
  const box = document.getElementById("bulkActionButtons");
  box.innerHTML = historyState.trashed
    ? `<button type="button" id="bulkRestoreBtn" class="btn-secondary">♻️ Restaurar</button>
       <button type="button" id="bulkPermDeleteBtn" class="btn-danger-ghost">🗑️ Excluir definitivamente</button>`
    : `<button type="button" id="bulkFavBtn" class="btn-secondary">⭐ Favoritar</button>
       <button type="button" id="bulkTrashBtn" class="btn-danger-ghost">🗑️ Mover p/ lixeira</button>`;

  if (historyState.trashed) {
    document.getElementById("bulkRestoreBtn").addEventListener("click", () => runBulkAction("restore"));
    document.getElementById("bulkPermDeleteBtn").addEventListener("click", () => {
      if (confirm(`Excluir definitivamente ${count} item(ns)? Essa ação não pode ser desfeita.`)) runBulkAction("permanent_delete");
    });
  } else {
    document.getElementById("bulkFavBtn").addEventListener("click", () => runBulkAction("favorite"));
    document.getElementById("bulkTrashBtn").addEventListener("click", () => {
      if (confirm(`Mover ${count} item(ns) para a lixeira?`)) runBulkAction("trash");
    });
  }
}

async function runBulkAction(action) {
  try {
    await fetch("/api/history/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [..._selectedIds], action }),
    });
    showToast("Ação aplicada.");
    _selectedIds.clear();
    loadedViews.dashboard = false;
    loadHistory();
  } catch { showToast("Falha ao aplicar ação em lote."); }
}

document.getElementById("bulkClearBtn").addEventListener("click", () => {
  _selectedIds.clear();
  document.querySelectorAll(".row-select").forEach((cb) => { cb.checked = false; });
  const selectAllCb = document.getElementById("selectAllCheckbox");
  if (selectAllCb) selectAllCb.checked = false;
  updateBulkBar();
});

document.getElementById("selectAllCheckbox").addEventListener("change", (e) => {
  document.querySelectorAll(".row-select").forEach((cb) => {
    cb.checked = e.target.checked;
    const id = parseInt(cb.dataset.id, 10);
    if (e.target.checked) _selectedIds.add(id); else _selectedIds.delete(id);
  });
  updateBulkBar();
});

function renderPagination() {
  const el = document.getElementById("historyPagination");
  const from = historyState.total === 0 ? 0 : historyState.offset + 1;
  const to = Math.min(historyState.offset + historyState.limit, historyState.total);
  el.innerHTML = `
    <button type="button" class="btn-ghost" id="prevPageBtn" ${historyState.offset === 0 ? "disabled" : ""}>← Anterior</button>
    <span>Mostrando ${from}–${to} de ${historyState.total}</span>
    <button type="button" class="btn-ghost" id="nextPageBtn" ${to >= historyState.total ? "disabled" : ""}>Próxima →</button>
  `;
  document.getElementById("prevPageBtn").addEventListener("click", () => {
    historyState.offset = Math.max(0, historyState.offset - historyState.limit);
    loadHistory();
  });
  document.getElementById("nextPageBtn").addEventListener("click", () => {
    historyState.offset += historyState.limit;
    loadHistory();
  });
}

async function toggleFavorite(id) {
  try {
    await fetch(`/api/history/${id}/favorite`, { method: "PATCH" });
    loadHistory();
  } catch { showToast("Falha ao favoritar."); }
}

async function deleteHistoryItem(id) {
  try {
    await fetch(`/api/history/${id}`, { method: "DELETE" });
    showToast("Movido para a lixeira.");
    loadedViews.dashboard = false;
    if (historyState.offset > 0 && _historyItems.length === 1) historyState.offset -= historyState.limit;
    loadHistory();
  } catch { showToast("Falha ao excluir."); }
}

async function restoreHistoryItem(id) {
  try {
    await fetch(`/api/history/${id}/restore`, { method: "POST" });
    showToast("Registro restaurado.");
    loadedViews.dashboard = false;
    if (historyState.offset > 0 && _historyItems.length === 1) historyState.offset -= historyState.limit;
    loadHistory();
  } catch { showToast("Falha ao restaurar."); }
}

async function permanentDeleteHistoryItem(id) {
  try {
    await fetch(`/api/history/${id}/permanent`, { method: "DELETE" });
    showToast("Excluído definitivamente.");
    if (historyState.offset > 0 && _historyItems.length === 1) historyState.offset -= historyState.limit;
    loadHistory();
  } catch { showToast("Falha ao excluir."); }
}

const historySearchEl = document.getElementById("historySearch");
historySearchEl.addEventListener("input", debounce((e) => {
  historyState.q = e.target.value.trim();
  historyState.offset = 0;
  loadHistory();
}, 350));

document.getElementById("historyModeFilter").addEventListener("change", (e) => {
  historyState.mode = e.target.value;
  historyState.offset = 0;
  loadHistory();
});

const favoriteFilterEl = document.getElementById("favoriteFilter");
const favoriteFilterPill = document.getElementById("favoriteFilterPill");
favoriteFilterEl.addEventListener("change", (e) => {
  historyState.favorite_only = e.target.checked;
  favoriteFilterPill.classList.toggle("active", e.target.checked);
  historyState.offset = 0;
  loadHistory();
});

const trashFilterEl = document.getElementById("trashFilter");
const trashFilterPill = document.getElementById("trashFilterPill");
const emptyTrashBtn = document.getElementById("emptyTrashBtn");
const exportCsvBtnEl = document.getElementById("exportCsvBtn");
trashFilterEl.addEventListener("change", (e) => {
  historyState.trashed = e.target.checked;
  trashFilterPill.classList.toggle("active", e.target.checked);
  historyState.offset = 0;
  historySearchEl.disabled = e.target.checked;
  document.getElementById("historyModeFilter").disabled = e.target.checked;
  favoriteFilterEl.disabled = e.target.checked;
  emptyTrashBtn.classList.toggle("hidden", !e.target.checked);
  exportCsvBtnEl.classList.toggle("hidden", e.target.checked);
  loadHistory();
});

emptyTrashBtn.addEventListener("click", async () => {
  if (!confirm("Excluir definitivamente TODOS os itens da lixeira? Essa ação não pode ser desfeita.")) return;
  try {
    await fetch("/api/history/trash/empty", { method: "DELETE" });
    showToast("Lixeira esvaziada.");
    historyState.offset = 0;
    loadHistory();
  } catch { showToast("Falha ao esvaziar lixeira."); }
});

document.getElementById("exportCsvBtn").addEventListener("click", () => {
  const params = new URLSearchParams();
  if (historyState.q) params.set("q", historyState.q);
  if (historyState.mode) params.set("mode", historyState.mode);
  if (historyState.favorite_only) params.set("favorite_only", "true");
  const a = document.createElement("a");
  a.href = `/api/history/export?${params.toString()}`;
  a.download = "historico_prompt_fixer.csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});

// Modal
const modal = document.getElementById("historyModal");
let _selItem = null;

function openModal(item) {
  _selItem = item;
  document.getElementById("modalMeta").textContent = `${item.mode.toUpperCase()} · ${new Date(item.created_at + "Z").toLocaleString("pt-BR")}`;
  document.getElementById("modalOriginal").textContent = item.original_prompt;
  document.getElementById("modalOptimized").textContent = item.optimized_prompt;
  document.getElementById("modalTokens").textContent = `${item.tokens_before} → ${item.tokens_after} (−${item.tokens_before - item.tokens_after})`;
  document.getElementById("modalQuality").textContent = `${item.quality_score_before} → ${item.quality_score_after} / 100`;
  document.getElementById("modalNoteInput").value = item.note || "";
  renderDiff(item.original_prompt, item.optimized_prompt, document.getElementById("modalDiff"));
  modal.classList.remove("hidden");
}

function closeModal() { modal.classList.add("hidden"); _selItem = null; }

document.getElementById("closeModalBtn").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal(); });

// Atalho "/" foca a busca do histórico, de qualquer tela — como no
// GitHub/Slack. Ignorado se o foco já estiver num campo de digitação.
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
    e.preventDefault();
    switchView("history");
    setTimeout(() => historySearchEl.focus(), 30);
  }
});

document.getElementById("modalCopyBtn").addEventListener("click", async () => {
  if (_selItem) { await navigator.clipboard.writeText(_selItem.optimized_prompt); showToast("Prompt copiado!"); }
});

document.getElementById("modalCopyCurlBtn").addEventListener("click", async () => {
  if (!_selItem) return;
  await navigator.clipboard.writeText(buildCurlCommand(_selItem.original_prompt, _selItem.mode));
  showToast("Comando cURL copiado!");
});

document.getElementById("modalSaveNoteBtn").addEventListener("click", async () => {
  if (!_selItem) return;
  const note = document.getElementById("modalNoteInput").value.trim();
  try {
    const res = await fetch(`/api/history/${_selItem.id}/note`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) throw new Error();
    _selItem.note = note;
    const idx = _historyItems.findIndex((i) => i.id === _selItem.id);
    if (idx !== -1) _historyItems[idx].note = note;
    showToast("Nota salva!");
  } catch { showToast("Falha ao salvar nota."); }
});

document.getElementById("modalDeleteBtn").addEventListener("click", async () => {
  if (!_selItem) return;
  if (!confirm("Mover este registro para a lixeira?")) return;
  await deleteHistoryItem(_selItem.id);
  closeModal();
});

// ═══════════════════════════════════════════════════════════════
// API VIEW
// ═══════════════════════════════════════════════════════════════
const copyCurlBtn = document.getElementById("copyCurlBtn");
if (copyCurlBtn) {
  copyCurlBtn.addEventListener("click", async () => {
    const snippet = document.querySelector(".code-snippet").textContent.replace("Copiar", "").trim();
    await navigator.clipboard.writeText(snippet);
    showToast("Comando copiado!");
  });
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATES — EXPORTAR / IMPORTAR
// ═══════════════════════════════════════════════════════════════
document.getElementById("exportTemplatesBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = "/api/custom-templates/export";
  a.download = "meus_templates.json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});

const importTemplatesInput = document.getElementById("importTemplatesInput");
document.getElementById("importTemplatesBtn").addEventListener("click", () => importTemplatesInput.click());

importTemplatesInput.addEventListener("change", async () => {
  const file = importTemplatesInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("O arquivo precisa ser uma lista de templates.");
    const res = await fetch("/api/custom-templates/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    _customTemplates = null;
    loadCustomTemplatesGrid();
    showToast(`${data.imported} template(s) importado(s)!`);
  } catch (e) { showToast(`Falha ao importar: ${e.message}`); }
  finally { importTemplatesInput.value = ""; }
});

// ═══════════════════════════════════════════════════════════════
// COMPARAR MODOS
// ═══════════════════════════════════════════════════════════════
const comparePromptEl = document.getElementById("comparePrompt");
const compareModeAEl = document.getElementById("compareModeA");
const compareModeBEl = document.getElementById("compareModeB");
const compareBtn = document.getElementById("compareBtn");
const compareSkeleton = document.getElementById("compareSkeleton");
const compareResultEl = document.getElementById("compareResult");
let _compareData = { a: null, b: null };

function renderCompareSide(letter, data) {
  document.getElementById(`compareLabel${letter}`).textContent = MODE_LABELS[data.mode] || data.mode;
  document.getElementById(`compareOutput${letter}`).textContent = data.optimized_prompt;
  document.getElementById(`compareTokens${letter}`).textContent = `${data.tokens_before} → ${data.tokens_after}`;
  document.getElementById(`compareQuality${letter}`).textContent = `${data.quality_score_before} → ${data.quality_score_after}`;
}

async function fetchOptimizeSafe(prompt, mode) {
  try {
    const res = await fetch("/api/optimize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, mode }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); return { ok: false, error: errorDetail(err, `Erro ${res.status}`) }; }
    return { ok: true, data: await res.json() };
  } catch (e) { return { ok: false, error: e.message }; }
}

function renderCompareError(letter, message) {
  document.getElementById(`compareLabel${letter}`).textContent = "Falhou";
  document.getElementById(`compareOutput${letter}`).textContent = message;
  document.getElementById(`compareTokens${letter}`).textContent = "-";
  document.getElementById(`compareQuality${letter}`).textContent = "-";
  document.getElementById(`compareUse${letter}Btn`).disabled = true;
}

compareBtn.addEventListener("click", async () => {
  const prompt = comparePromptEl.value.trim();
  const modeA = compareModeAEl.value, modeB = compareModeBEl.value;
  if (!prompt) return;
  if (modeA === modeB) { showToast("Escolha dois modos diferentes."); return; }
  compareBtn.disabled = true;
  compareResultEl.classList.add("hidden");
  compareSkeleton.classList.remove("hidden");
  document.getElementById("compareUseABtn").disabled = false;
  document.getElementById("compareUseBBtn").disabled = false;
  try {
    // Promise.all faria a comparação inteira falhar se só um dos dois
    // modos desse erro (ex: rate limit) — aqui cada lado é tratado à
    // parte, então o que der certo ainda aparece.
    const [resultA, resultB] = await Promise.all([
      fetchOptimizeSafe(prompt, modeA),
      fetchOptimizeSafe(prompt, modeB),
    ]);
    _compareData = { a: resultA.ok ? resultA.data : null, b: resultB.ok ? resultB.data : null };
    if (resultA.ok) renderCompareSide("A", resultA.data); else renderCompareError("A", resultA.error);
    if (resultB.ok) renderCompareSide("B", resultB.data); else renderCompareError("B", resultB.error);
    compareResultEl.classList.remove("hidden");
    if (!resultA.ok && !resultB.ok) showToast("Os dois modos falharam.");
    else if (!resultA.ok || !resultB.ok) showToast("Um dos modos falhou — mostrando o que deu certo.");
    loadedViews.dashboard = false;
    loadedViews.history = false;
  } catch (e) { showToast(e.message); }
  finally { compareBtn.disabled = false; compareSkeleton.classList.add("hidden"); }
});

function useCompareResult(letter) {
  const data = letter === "A" ? _compareData.a : _compareData.b;
  if (!data) return;
  _lastResponse = data;
  modeEl.value = data.mode;
  promptEl.value = data.original_prompt;
  updateCharCounter();
  renderResult(data);
  resetChain(data.mode);
  switchView("optimize");
  showToast(`Resultado do modo ${MODE_LABELS[data.mode]} carregado.`);
}
document.getElementById("compareUseABtn").addEventListener("click", () => useCompareResult("A"));
document.getElementById("compareUseBBtn").addEventListener("click", () => useCompareResult("B"));

// ═══════════════════════════════════════════════════════════════
// CONFIGURAÇÕES — multi-provedor
// ═══════════════════════════════════════════════════════════════
let _orderState = [];

async function loadSettings() {
  const box = document.getElementById("providersList");
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    renderProvidersList(data.providers);
    renderProviderOrderList(data.provider_order, data.providers);
  } catch {
    box.innerHTML = '<p class="field-hint error">Não foi possível consultar o backend.</p>';
  }
}

function renderProvidersList(providers) {
  const box = document.getElementById("providersList");
  box.innerHTML = providers.map((p) => `
    <div class="provider-card" data-provider="${p.id}">
      <div class="provider-card-header">
        <strong>${esc(p.label)}</strong>
        <span class="settings-status ${p.configured ? "ok" : "degraded"}">${p.configured ? `✓ Configurado (${esc(p.masked_key)})` : "✗ Sem chave"}</span>
      </div>
      <div class="provider-card-grid">
        <div>
          <label>Chave da API</label>
          <input type="text" class="provider-key-input" placeholder="Cole a chave aqui" autocomplete="off" />
        </div>
        <div>
          <label>Modelo</label>
          <input type="text" class="provider-model-input" value="${esc(p.model)}" />
        </div>
      </div>
      <div class="form-actions-row">
        <button type="button" class="btn-secondary provider-test-btn">🧪 Testar</button>
        <button type="button" class="provider-save-btn">💾 Salvar chave</button>
        <button type="button" class="btn-ghost provider-save-model-btn">Salvar modelo</button>
      </div>
      <p class="field-hint provider-feedback"></p>
    </div>`).join("");

  box.querySelectorAll(".provider-card").forEach((card) => {
    const providerId = card.dataset.provider;
    const keyInput = card.querySelector(".provider-key-input");
    const modelInput = card.querySelector(".provider-model-input");
    const feedback = card.querySelector(".provider-feedback");

    card.querySelector(".provider-test-btn").addEventListener("click", async () => {
      const key = keyInput.value.trim();
      if (!key) { showToast("Cole uma chave antes de testar."); return; }
      feedback.textContent = "Testando..."; feedback.className = "field-hint provider-feedback";
      try {
        const res = await fetch("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, api_key: key }) });
        const data = await res.json();
        feedback.textContent = data.message;
        feedback.className = "field-hint provider-feedback " + (data.ok ? "ok" : "error");
      } catch { feedback.textContent = "Falha ao testar."; feedback.className = "field-hint provider-feedback error"; }
    });

    card.querySelector(".provider-save-btn").addEventListener("click", async () => {
      const key = keyInput.value.trim();
      if (!key) { showToast("Cole uma chave antes de salvar."); return; }
      feedback.textContent = "Salvando e validando..."; feedback.className = "field-hint provider-feedback";
      try {
        const res = await fetch("/api/settings/provider-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, api_key: key }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
        feedback.textContent = "Chave salva com sucesso!"; feedback.className = "field-hint provider-feedback ok";
        keyInput.value = "";
        loadSettings();
        checkHealth();
        showToast(`Chave da ${providerId} salva!`);
      } catch (e) { feedback.textContent = e.message; feedback.className = "field-hint provider-feedback error"; }
    });

    card.querySelector(".provider-save-model-btn").addEventListener("click", async () => {
      const model = modelInput.value.trim();
      if (!model) return;
      try {
        await fetch("/api/settings/provider-model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, model }) });
        showToast("Modelo atualizado!");
      } catch { showToast("Falha ao salvar modelo."); }
    });
  });
}

function renderProviderOrderList(order, providers) {
  _orderState = [...order];
  const providerMap = Object.fromEntries(providers.map((p) => [p.id, p]));
  const box = document.getElementById("providerOrderList");
  box.innerHTML = _orderState.map((id, idx) => {
    const p = providerMap[id];
    if (!p) return "";
    return `
      <div class="order-item ${p.configured ? "" : "unconfigured"}">
        <span class="order-badge">${idx + 1}</span>
        <span class="order-label">${esc(p.label)}</span>
        <span class="order-hint">${p.configured ? esc(p.model) : "sem chave"}</span>
        <div class="order-controls">
          <button type="button" class="order-up-btn" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="order-down-btn" ${idx === _orderState.length - 1 ? "disabled" : ""}>↓</button>
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll(".order-up-btn").forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      [_orderState[idx - 1], _orderState[idx]] = [_orderState[idx], _orderState[idx - 1]];
      renderProviderOrderList(_orderState, providers);
    });
  });
  box.querySelectorAll(".order-down-btn").forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      [_orderState[idx + 1], _orderState[idx]] = [_orderState[idx], _orderState[idx + 1]];
      renderProviderOrderList(_orderState, providers);
    });
  });
}

document.getElementById("saveOrderBtn").addEventListener("click", async () => {
  const feedback = document.getElementById("orderFeedback");
  try {
    const res = await fetch("/api/settings/provider-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: _orderState }) });
    if (!res.ok) throw new Error("Falha ao salvar a ordem.");
    feedback.textContent = "Ordem salva!";
    feedback.className = "field-hint ok";
    checkHealth();
  } catch (e) { feedback.textContent = e.message; feedback.className = "field-hint error"; }
});

// ═══════════════════════════════════════════════════════════════
// SEGUNDA OPINIÃO DA IA (revisão de qualidade)
// ═══════════════════════════════════════════════════════════════
const qualityReviewBtn = document.getElementById("qualityReviewBtn");
qualityReviewBtn.addEventListener("click", async () => {
  const prompt = (outputEl.value || promptEl.value).trim();
  if (!prompt) return;
  const box = document.getElementById("qualityReviewResult");
  const originalLabel = qualityReviewBtn.textContent;
  qualityReviewBtn.disabled = true;
  qualityReviewBtn.textContent = "🔬 Consultando a IA...";
  try {
    const res = await fetch("/api/quality-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    const fortes = data.pontos_fortes.map((p) => `<li>${esc(p)}</li>`).join("") || "<li>—</li>";
    const fracos = data.pontos_fracos.map((p) => `<li>${esc(p)}</li>`).join("") || "<li>—</li>";
    box.innerHTML = `
      ${data.score !== null ? `<div class="quality-review-score">Nota da IA: ${data.score}/100</div>` : ""}
      <div class="quality-review-cols">
        <div><h4>Pontos fortes</h4><ul>${fortes}</ul></div>
        <div><h4>Pontos fracos</h4><ul>${fracos}</ul></div>
      </div>
      ${data.sugestao ? `<div class="quality-review-suggestion"><strong>Sugestão:</strong> ${esc(data.sugestao)}</div>` : ""}
      <p class="field-hint" style="margin-top:8px;">via ${esc(data.provider_label)}</p>
    `;
    box.classList.remove("hidden");
  } catch (e) { showToast(`Falha: ${e.message}`); }
  finally { qualityReviewBtn.disabled = false; qualityReviewBtn.textContent = originalLabel; }
});

// ═══════════════════════════════════════════════════════════════
// BACKUP COMPLETO (exportar / importar)
// ═══════════════════════════════════════════════════════════════
document.getElementById("exportBackupBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = "/api/backup/export";
  a.download = "backup_prompt_fixer.json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});

const importBackupInput = document.getElementById("importBackupInput");
document.getElementById("importBackupBtn").addEventListener("click", () => importBackupInput.click());

importBackupInput.addEventListener("change", async () => {
  const file = importBackupInput.files[0];
  if (!file) return;
  const feedback = document.getElementById("backupFeedback");
  feedback.textContent = "Importando..."; feedback.className = "field-hint";
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await fetch("/api/backup/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    feedback.textContent = `Importado: ${data.history_imported} do histórico, ${data.templates_imported} template(s).`;
    feedback.className = "field-hint ok";
    loadedViews.history = false; loadedViews.dashboard = false; loadedViews.templates = false;
    showToast("Backup importado!");
  } catch (e) { feedback.textContent = `Falha: ${e.message}`; feedback.className = "field-hint error"; }
  finally { importBackupInput.value = ""; }
});

// ═══════════════════════════════════════════════════════════════
// OTIMIZAÇÃO EM LOTE
// ═══════════════════════════════════════════════════════════════
const batchPromptsEl = document.getElementById("batchPrompts");
const batchCounterEl = document.getElementById("batchCounter");
const MAX_BATCH_PROMPTS = 20;

function batchLines() {
  return batchPromptsEl.value.split("\n").map((l) => l.trim()).filter(Boolean);
}

function updateBatchCounter() {
  const count = batchLines().length;
  const over = count > MAX_BATCH_PROMPTS;
  batchCounterEl.textContent = `${count} prompt(s)` + (over ? ` — só os primeiros ${MAX_BATCH_PROMPTS} serão otimizados` : "");
  batchCounterEl.classList.toggle("warn", over);
}
batchPromptsEl.addEventListener("input", updateBatchCounter);
updateBatchCounter();

let _batchData = null;

document.getElementById("batchRunBtn").addEventListener("click", async () => {
  const lines = batchLines().slice(0, MAX_BATCH_PROMPTS);
  if (!lines.length) { showToast("Cole ao menos um prompt."); return; }
  const mode = document.getElementById("batchMode").value;
  const btn = document.getElementById("batchRunBtn");
  const skeleton = document.getElementById("batchSkeleton");
  const summary = document.getElementById("batchSummary");
  const resultsBox = document.getElementById("batchResults");
  btn.disabled = true;
  resultsBox.innerHTML = "";
  summary.classList.add("hidden");
  skeleton.classList.remove("hidden");
  try {
    const res = await fetch("/api/optimize/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: lines, mode }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errorDetail(err, `Erro ${res.status}`)); }
    const data = await res.json();
    _batchData = data;
    const okCount = data.items.filter((i) => i.success).length;
    summary.textContent = `${okCount} de ${data.items.length} otimizados com sucesso.`;
    summary.classList.remove("hidden");

    resultsBox.innerHTML = data.items.map((item, idx) => {
      if (!item.success) {
        return `
          <div class="batch-item failed">
            <div class="batch-item-header"><strong>Falhou</strong></div>
            <div class="batch-item-prompt">${esc(item.prompt)}</div>
            <div class="batch-item-error">${esc(item.error)}</div>
          </div>`;
      }
      const r = item.result;
      return `
        <div class="batch-item">
          <div class="batch-item-header">
            <span class="mode-badge mode-${r.mode}">${r.mode}</span>
            <span class="field-hint" style="margin:0;">${r.tokens_before} → ${r.tokens_after} tokens${r.from_cache ? " · cache" : ""}</span>
            <div class="batch-item-actions">
              <button type="button" class="btn-ghost btn-icon batch-copy-btn" data-idx="${idx}" title="Copiar">📋</button>
              <button type="button" class="btn-ghost btn-icon batch-use-btn" data-idx="${idx}" title="Abrir na tela Otimizar">↗️</button>
            </div>
          </div>
          <div class="batch-item-prompt">${esc(item.prompt)}</div>
          <div class="batch-item-output">${esc(r.optimized_prompt)}</div>
        </div>`;
    }).join("");

    resultsBox.querySelectorAll(".batch-copy-btn").forEach((b) => {
      b.addEventListener("click", async () => {
        const item = _batchData.items[parseInt(b.dataset.idx, 10)];
        if (item.success) { await navigator.clipboard.writeText(item.result.optimized_prompt); showToast("Copiado!"); }
      });
    });
    resultsBox.querySelectorAll(".batch-use-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const item = _batchData.items[parseInt(b.dataset.idx, 10)];
        if (!item.success) return;
        _lastResponse = item.result;
        promptEl.value = item.result.original_prompt;
        modeEl.value = item.result.mode;
        updateCharCounter();
        renderResult(item.result);
        resetChain(item.result.mode);
        switchView("optimize");
      });
    });

    loadedViews.dashboard = false;
    loadedViews.history = false;
  } catch (e) { showToast(`Falha: ${e.message}`); }
  finally { btn.disabled = false; skeleton.classList.add("hidden"); }
});

// ═══════════════════════════════════════════════════════════════
// PREENCHIMENTO GUIADO DE TEMPLATES
// ═══════════════════════════════════════════════════════════════
function detectPlaceholders(text) {
  const seen = new Set();
  const unique = [];
  for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); unique.push(m[1]); }
  }
  return unique;
}

let _fillTemplate = null;
const templateFillModal = document.getElementById("templateFillModal");

function openTemplateFillModal(tpl) {
  const placeholders = detectPlaceholders(tpl.prompt);
  if (!placeholders.length) { useTemplate(tpl); return; }
  _fillTemplate = tpl;
  document.getElementById("templateFillTitle").textContent = `Preencher: ${tpl.title}`;
  document.getElementById("templateFillFields").innerHTML = placeholders.map((ph, i) => `
    <div class="template-fill-field">
      <label for="fillField${i}">${esc(ph)}</label>
      <input type="text" id="fillField${i}" data-placeholder="${esc(ph)}" placeholder="${esc(ph)}" />
    </div>`).join("");
  templateFillModal.classList.remove("hidden");
  const firstInput = document.getElementById("fillField0");
  if (firstInput) firstInput.focus();
}

function closeTemplateFillModal() {
  templateFillModal.classList.add("hidden");
  _fillTemplate = null;
}

document.getElementById("closeTemplateFillBtn").addEventListener("click", closeTemplateFillModal);
templateFillModal.addEventListener("click", (e) => { if (e.target === templateFillModal) closeTemplateFillModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !templateFillModal.classList.contains("hidden")) closeTemplateFillModal();
});

document.getElementById("applyTemplateFillBtn").addEventListener("click", () => {
  if (!_fillTemplate) return;
  let filled = _fillTemplate.prompt;
  document.querySelectorAll("#templateFillFields input").forEach((input) => {
    const value = input.value.trim();
    if (value) filled = filled.split(`[${input.dataset.placeholder}]`).join(value);
  });
  const tpl = _fillTemplate;
  closeTemplateFillModal();
  useTemplate({ ...tpl, prompt: filled });
});
