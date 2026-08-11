// Service worker (Manifest V3).
//
// Por que a chamada à API mora aqui, e não no content.js?
// As páginas de IA (claude.ai, chatgpt.com, gemini.google.com) têm políticas
// de segurança (CSP) próprias que podem bloquear um fetch() feito a partir
// do content script, já que ele roda "dentro" da página. O background
// (service worker) roda no contexto da extensão, sem essa restrição, então
// é ele quem fala com o backend. O content script só pede via mensagem.

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPTIMIZE_PROMPT") return false;

  (async () => {
    try {
      const { backendUrl } = await chrome.storage.sync.get("backendUrl");
      const url = backendUrl || DEFAULT_BACKEND_URL;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: message.prompt, mode: message.mode }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        sendResponse({
          ok: false,
          error: extractErrorDetail(data) || `Erro ${res.status}`,
        });
        return;
      }

      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || "Falha de conexão com o backend." });
    }
  })();

  return true; // mantém o canal aberto para a resposta assíncrona
});
