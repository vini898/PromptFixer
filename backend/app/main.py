from __future__ import annotations

import asyncio
import csv
import io
import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.database import fts_available, get_connection, init_db
from app.schemas import (
    BackupExport,
    BackupImportResult,
    BatchOptimizeItem,
    BatchOptimizeRequest,
    BatchOptimizeResponse,
    BulkHistoryRequest,
    CustomTemplate,
    CustomTemplateCreate,
    HealthResponse,
    HistoryItem,
    HistoryNoteUpdate,
    HistoryPage,
    OptimizeRequest,
    OptimizeResponse,
    ProviderKeyUpdate,
    ProviderModelUpdate,
    ProviderOrderUpdate,
    ProviderStatus,
    PromptTemplate,
    QualityReviewRequest,
    QualityReviewResponse,
    SettingsResponse,
    SimulateRequest,
    SimulateResponse,
    StatsResponse,
)
from app.services.optimizer import (
    DEFAULT_PROVIDER_ORDER,
    PROVIDERS,
    ai_quality_review,
    call_llm_full,
    make_cache_key,
    masked_key,
    prompt_quality_score,
    reset_overhead_cache,
    save_provider_key,
    simulate_ai_response,
    test_provider_key,
    warm_up_token_cache,
)

BASE_DIR = Path(__file__).parent.parent
ENV_PATH = BASE_DIR / ".env"
load_dotenv(ENV_PATH)

APP_VERSION = "2.5.0"

app = FastAPI(
    title="Prompt Fixer API",
    description=(
        "API que reescreve prompts para ficarem mais claros, objetivos e "
        "econômicos em tokens, com suporte a múltiplos modos."
    ),
    version=APP_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    # Libera o próprio app web (localhost/127.0.0.1) e qualquer extensão
    # de Chrome instalada (o ID da extensão varia por instalação, por
    # isso o regex em vez de uma origem fixa). Isso evita que um site
    # qualquer na internet possa chamar sua API local via CORS.
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _get_setting(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _set_setting(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _load_provider_prefs() -> tuple[list[str], dict[str, str]]:
    """Lê a ordem de provedores e os modelos escolhidos do banco. Se nunca
    foram configurados, usa os padrões — mantém compatibilidade com quem
    já rodava o app só com GROQ_API_KEY antes dessa funcionalidade existir.
    """
    with get_connection() as conn:
        order_raw = _get_setting(conn, "provider_order")
        overrides_raw = _get_setting(conn, "provider_models")
    order = json.loads(order_raw) if order_raw else list(DEFAULT_PROVIDER_ORDER)
    overrides = json.loads(overrides_raw) if overrides_raw else {}
    # Garante que todo provedor conhecido apareça na ordem, mesmo que a
    # lista salva seja de uma versão anterior com menos provedores.
    for p in DEFAULT_PROVIDER_ORDER:
        if p not in order:
            order.append(p)
    return order, overrides


def _save_provider_order(order: list[str]) -> None:
    with get_connection() as conn:
        _set_setting(conn, "provider_order", json.dumps(order))


def _save_provider_model(provider_id: str, model: str) -> None:
    with get_connection() as conn:
        overrides_raw = _get_setting(conn, "provider_models")
        overrides = json.loads(overrides_raw) if overrides_raw else {}
        overrides[provider_id] = model
        _set_setting(conn, "provider_models", json.dumps(overrides))


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    # Pré-aquece o cache de tokens reais de todos os provedores
    # configurados (uma chamada barata por modo, por provedor). Se
    # nenhum tiver chave ou estiver fora do ar, falha em silêncio e os
    # pedidos caem para a estimativa local normalmente.
    order, overrides = _load_provider_prefs()
    await warm_up_token_cache(order, overrides)


# ---------- Recomendação de IA ----------

_AI_PROFILES = {
    "chatgpt": {
        "ai_name": "ChatGPT",
        "ai_company": "OpenAI",
        "ai_model": "GPT-4o",
        "ai_url": "https://chatgpt.com/",
        "ai_icon": "🤖",
        "ai_color": "#10a37f",
    },
    "claude": {
        "ai_name": "Claude",
        "ai_company": "Anthropic",
        "ai_model": "Claude 3.5 Sonnet",
        "ai_url": "https://claude.ai/new",
        "ai_icon": "🟠",
        "ai_color": "#d97706",
    },
    "gemini": {
        "ai_name": "Gemini",
        "ai_company": "Google",
        "ai_model": "Gemini 2.5 Flash",
        "ai_url": "https://gemini.google.com/app",
        "ai_icon": "✨",
        "ai_color": "#4285f4",
    },
    "deepseek": {
        "ai_name": "DeepSeek",
        "ai_company": "DeepSeek AI",
        "ai_model": "DeepSeek-R1",
        "ai_url": "https://chat.deepseek.com/",
        "ai_icon": "🐳",
        "ai_color": "#4d6bfe",
    },
    "perplexity": {
        "ai_name": "Perplexity",
        "ai_company": "Perplexity AI",
        "ai_model": "Perplexity Sonar",
        "ai_url": "https://www.perplexity.ai/",
        "ai_icon": "🔍",
        "ai_color": "#22b8cf",
    },
}

_CODE_KEYWORDS = {
    "código", "codigo", "função", "funcao", "script", "programa", "programar",
    "python", "javascript", "java", "html", "css", "sql", "react", "api",
    "bug", "erro", "debug", "algoritmo", "classe", "variável", "variavel",
    "loop", "array", "json", "backend", "frontend", "deploy", "git",
    "code", "function", "programming", "developer", "software",
}

_CREATIVE_KEYWORDS = {
    "escreva", "redação", "redacao", "texto", "história", "historia",
    "poema", "carta", "email", "artigo", "blog", "roteiro", "narrativa",
    "criativo", "criativa", "personagem", "diálogo", "dialogo", "ensaio",
    "write", "story", "creative", "essay", "letter", "poem",
}

_RESEARCH_KEYWORDS = {
    "pesquise", "pesquisar", "busque", "buscar", "encontre", "encontrar",
    "dados", "estatística", "estatistica", "notícia", "noticia", "atual",
    "recente", "hoje", "tendência", "tendencia", "mercado", "comparar",
    "compare", "search", "find", "research", "latest", "current", "trend",
}

_MATH_KEYWORDS = {
    "calcule", "calcular", "matemática", "matematica", "equação", "equacao",
    "fórmula", "formula", "estatística", "probabilidade", "integral",
    "derivada", "álgebra", "geometria", "math", "calculate", "equation",
}


def _recommend_ai(prompt: str, mode: str) -> dict:
    """Analisa o prompt e o modo para recomendar a melhor IA e Modelo com justificativa."""
    text_lower = prompt.lower()
    words = set(text_lower.split())

    if mode == "codigo":
        return {
            **_AI_PROFILES["deepseek"],
            "ai_reason": "O modelo DeepSeek-R1 da DeepSeek AI é o melhor para tarefas de programação e código devido à sua alta capacidade de raciocínio lógico e resolução de bugs complexos.",
        }

    if mode == "traduzir":
        return {
            **_AI_PROFILES["claude"],
            "ai_reason": "O modelo Claude 3.5 Sonnet da Anthropic é a escolha superior para traduções, garantindo tom natural e mantendo todas as nuances do texto original.",
        }

    if mode == "resumir":
        return {
            **_AI_PROFILES["gemini"],
            "ai_reason": "O modelo Gemini 2.5 Flash da Google possui uma grande janela de contexto e altíssima velocidade para sínteses e resumos de textos longos.",
        }

    if mode == "enriquecimento":
        return {
            **_AI_PROFILES["claude"],
            "ai_reason": "O modelo Claude 3.5 Sonnet da Anthropic é excelente em interpretar prompts detalhados e estruturados, seguindo instruções complexas à risca.",
        }

    code_score = len(words & _CODE_KEYWORDS)
    creative_score = len(words & _CREATIVE_KEYWORDS)
    research_score = len(words & _RESEARCH_KEYWORDS)
    math_score = len(words & _MATH_KEYWORDS)

    scores = {
        "code": code_score,
        "creative": creative_score,
        "research": research_score,
        "math": math_score,
    }
    best = max(scores, key=scores.get)

    if scores[best] == 0:
        return {
            **_AI_PROFILES["chatgpt"],
            "ai_reason": "O modelo GPT-4o da OpenAI é o modelo mais versátil e equilibrado para instruções gerais e solicitações diversas.",
        }

    if best == "code" or best == "math":
        return {
            **_AI_PROFILES["deepseek"],
            "ai_reason": "O modelo DeepSeek-R1 da DeepSeek AI se destaca em raciocínio matemático, lógica estruturada e desenvolvimento de código.",
        }
    elif best == "creative":
        return {
            **_AI_PROFILES["claude"],
            "ai_reason": "O modelo Claude 3.5 Sonnet da Anthropic é imbatível em escrita criativa, redação e estruturação estilística de texto.",
        }
    else:
        return {
            **_AI_PROFILES["perplexity"],
            "ai_reason": "O modelo Perplexity Sonar da Perplexity AI é ideal para pesquisa, encontrando dados recentes e informações com citação de fontes.",
        }


# ---------- Templates de prompt ----------

_PROMPT_TEMPLATES: list[dict] = [
    {
        "id": "bug-fix",
        "title": "Corrigir um bug",
        "description": "Estrutura o pedido com contexto, comportamento esperado e restrições para um assistente de código.",
        "mode": "codigo",
        "icon": "🐛",
        "prompt": "Tenho um bug na minha função de [descreva a função]. O comportamento esperado é [descreva], mas está acontecendo [descreva o erro]. Linguagem: [linguagem]. Aqui está o código relevante: [cole o código].",
    },
    {
        "id": "email-profissional",
        "title": "E-mail profissional",
        "description": "Ponto de partida para redigir um e-mail claro e no tom certo.",
        "mode": "enriquecimento",
        "icon": "✉️",
        "prompt": "Escreva um e-mail para [destinatário] sobre [assunto]. O tom deve ser [formal/casual]. Preciso comunicar: [pontos principais]. Encerre pedindo [ação desejada].",
    },
    {
        "id": "resumo-artigo",
        "title": "Resumir um texto longo",
        "description": "Reduz um texto extenso para os pontos essenciais.",
        "mode": "resumir",
        "icon": "📄",
        "prompt": "Resuma o texto abaixo em até 5 tópicos, mantendo os dados e conclusões mais importantes:\n\n[cole o texto aqui]",
    },
    {
        "id": "traducao-tecnica",
        "title": "Tradução técnica",
        "description": "Traduz preservando termos técnicos e tom original.",
        "mode": "traduzir",
        "icon": "🌐",
        "prompt": "[cole o texto que deseja traduzir para inglês, mantendo termos técnicos sem adaptação livre]",
    },
    {
        "id": "plano-estudo",
        "title": "Plano de estudos",
        "description": "Prompt enriquecido para gerar um plano estruturado.",
        "mode": "enriquecimento",
        "icon": "📚",
        "prompt": "Crie um plano de estudos de [tema] para [nível: iniciante/intermediário/avançado], com duração de [tempo disponível]. Quero um cronograma semanal com tópicos, recursos sugeridos e uma forma de avaliar meu progresso.",
    },
    {
        "id": "brainstorm",
        "title": "Brainstorm de ideias",
        "description": "Gera múltiplas alternativas criativas sobre um tema.",
        "mode": "otimizar",
        "icon": "💡",
        "prompt": "Liste 10 ideias diferentes para [objetivo], considerando [restrições ou público-alvo].",
    },
]


# ---------- API: otimização ----------

async def _optimize_one(prompt: str, mode: str, order: list[str], overrides: dict[str, str]) -> OptimizeResponse:
    """Lógica completa de uma otimização: cache, chamada à IA (com
    fallback entre provedores), gravação no histórico e recomendação de
    IA externa. Usada tanto pelo endpoint único `/api/optimize` quanto
    pelo endpoint em lote `/api/optimize/batch` — evita duplicar essa
    lógica em dois lugares (e correr o risco de os dois divergirem).
    Deixa exceções subirem; quem chama decide como tratar o erro.
    """
    original_prompt = prompt.strip()
    key = make_cache_key(original_prompt, mode)
    from_cache = False

    with get_connection() as conn:
        cached = conn.execute("SELECT * FROM response_cache WHERE cache_key = ?", (key,)).fetchone()

    if cached:
        # Mesmo prompt + mesmo modo já otimizados antes — reaproveita o
        # resultado em vez de chamar a IA de novo (mais rápido e não
        # gasta chamada de API).
        from_cache = True
        optimized_prompt = cached["optimized_prompt"]
        tokens_before = cached["tokens_before"]
        tokens_after = cached["tokens_after"]
        tokens_source = cached["tokens_source"]
        provider_id = cached["provider"]
        provider_label = PROVIDERS.get(provider_id, {}).get("label", provider_id)
        with get_connection() as conn:
            conn.execute("UPDATE response_cache SET hits = hits + 1 WHERE cache_key = ?", (key,))
    else:
        result = await call_llm_full(original_prompt, mode, order, overrides)

        optimized_prompt = result["text"]
        tokens_before = result["tokens_before"]
        tokens_after = result["tokens_after"]
        tokens_source = result["tokens_source"]
        provider_id = result["provider"]
        provider_label = result["provider_label"]

        with get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO response_cache
                    (cache_key, mode, optimized_prompt, tokens_before, tokens_after, tokens_source, provider, hits)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (key, mode, optimized_prompt, tokens_before, tokens_after, tokens_source, provider_id),
            )

    tokens_saved = tokens_before - tokens_after
    tokens_saved_pct = (tokens_saved / tokens_before * 100) if tokens_before else 0.0

    quality_before = prompt_quality_score(original_prompt)
    quality_after = prompt_quality_score(optimized_prompt)

    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO history
                (mode, original_prompt, optimized_prompt, tokens_before, tokens_after,
                 quality_score_before, quality_score_after, tokens_source, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                mode,
                original_prompt,
                optimized_prompt,
                tokens_before,
                tokens_after,
                quality_before["score"],
                quality_after["score"],
                tokens_source,
                provider_id,
            ),
        )
        new_id = cursor.lastrowid

    ai_rec = _recommend_ai(optimized_prompt, mode)

    return OptimizeResponse(
        id=new_id,
        mode=mode,
        original_prompt=original_prompt,
        optimized_prompt=optimized_prompt,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
        tokens_saved=tokens_saved,
        tokens_saved_pct=round(tokens_saved_pct, 1),
        tokens_source=tokens_source,
        from_cache=from_cache,
        provider=provider_id,
        provider_label=provider_label,
        quality_score_before=quality_before["score"],
        quality_score_after=quality_after["score"],
        quality_reasons_before=quality_before["reasons"],
        quality_reasons_after=quality_after["reasons"],
        **ai_rec,
    )


@app.post("/api/optimize", response_model=OptimizeResponse)
async def optimize(payload: OptimizeRequest) -> OptimizeResponse:
    order, overrides = _load_provider_prefs()
    try:
        return await _optimize_one(payload.prompt, payload.mode, order, overrides)
    except Exception as exc:  # noqa: BLE001 - queremos responder qualquer erro externo
        raise HTTPException(status_code=502, detail=f"Falha ao chamar a IA: {exc}") from exc


@app.post("/api/optimize/batch", response_model=BatchOptimizeResponse)
async def optimize_batch(payload: BatchOptimizeRequest) -> BatchOptimizeResponse:
    """Otimiza vários prompts de uma vez (até 20 por chamada). Cada um é
    tratado de forma independente — se um falhar (ex: rate limit), os
    outros continuam normalmente, igual ao "Comparar modos". No máximo 3
    otimizações rodam ao mesmo tempo, pra não estourar limite de taxa dos
    provedores configurados.
    """
    order, overrides = _load_provider_prefs()
    semaphore = asyncio.Semaphore(3)

    async def run_one(prompt: str) -> BatchOptimizeItem:
        async with semaphore:
            try:
                result = await _optimize_one(prompt, payload.mode, order, overrides)
                return BatchOptimizeItem(prompt=prompt, success=True, result=result)
            except Exception as exc:  # noqa: BLE001
                return BatchOptimizeItem(prompt=prompt, success=False, error=str(exc))

    items = await asyncio.gather(*(run_one(p) for p in payload.prompts))
    return BatchOptimizeResponse(items=list(items))


@app.post("/api/quality-review", response_model=QualityReviewResponse)
async def quality_review(payload: QualityReviewRequest) -> QualityReviewResponse:
    """Segunda opinião sobre a qualidade do prompt, gerada pela própria IA
    (mais lenta e gasta uma chamada de API, ao contrário da nota heurística
    instantânea que já aparece em toda otimização). Sob demanda.
    """
    order, overrides = _load_provider_prefs()
    try:
        result = await ai_quality_review(payload.prompt.strip(), order, overrides)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao consultar a IA: {exc}") from exc
    return QualityReviewResponse(**result)


@app.post("/api/simulate", response_model=SimulateResponse)
async def simulate(payload: SimulateRequest) -> SimulateResponse:
    prompt_text = payload.prompt.strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="Prompt não pode ser vazio.")

    order, overrides = _load_provider_prefs()
    try:
        result = await simulate_ai_response(prompt_text, order, overrides)
        return SimulateResponse(prompt=prompt_text, simulated_response=result["text"], provider_label=result["provider_label"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao simular resposta: {exc}") from exc


# ---------- API: histórico ----------

def _fts_safe_match(term: str) -> str:
    """Escapa o termo de busca do usuário como uma frase literal do FTS5,
    para que pontuação, aspas ou operadores especiais (AND/OR/-/:) do termo
    nunca quebrem a query nem sejam interpretados como sintaxe de busca."""
    return '"' + term.replace('"', '""') + '"'


def _build_history_filters(q: str | None, mode: str | None, favorite_only: bool, trashed: bool = False):
    clauses: list[str] = ["deleted_at IS NOT NULL" if trashed else "deleted_at IS NULL"]
    params: list = []
    use_fts = False
    if q:
        with get_connection() as conn:
            use_fts = fts_available(conn)
        if use_fts:
            clauses.append("id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)")
            params.append(_fts_safe_match(q))
        else:
            clauses.append("(original_prompt LIKE ? OR optimized_prompt LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])
    if mode:
        clauses.append("mode = ?")
        params.append(mode)
    if favorite_only:
        clauses.append("favorite = 1")
    where = f"WHERE {' AND '.join(clauses)}"
    return where, params


@app.get("/api/history", response_model=HistoryPage)
def get_history(
    limit: int = 20,
    offset: int = 0,
    q: str | None = None,
    mode: str | None = None,
    favorite_only: bool = False,
) -> HistoryPage:
    where, params = _build_history_filters(q, mode, favorite_only)
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS c FROM history {where}", params).fetchone()["c"]
        rows = conn.execute(
            f"SELECT * FROM history {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    items = [HistoryItem(**{**dict(row), "favorite": bool(row["favorite"])}) for row in rows]
    return HistoryPage(items=items, total=total)


@app.get("/api/history/trash", response_model=HistoryPage)
def get_trash(limit: int = 20, offset: int = 0) -> HistoryPage:
    where, params = _build_history_filters(None, None, False, trashed=True)
    with get_connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) AS c FROM history {where}", params).fetchone()["c"]
        rows = conn.execute(
            f"SELECT * FROM history {where} ORDER BY deleted_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    items = [HistoryItem(**{**dict(row), "favorite": bool(row["favorite"])}) for row in rows]
    return HistoryPage(items=items, total=total)


@app.delete("/api/history/{item_id}")
def delete_history_item(item_id: int) -> dict:
    """Move o registro para a lixeira (soft-delete) — não apaga de vez."""
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE history SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
            (item_id,),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return {"trashed": item_id}


@app.post("/api/history/{item_id}/restore", response_model=HistoryItem)
def restore_history_item(item_id: int) -> HistoryItem:
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE history SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
            (item_id,),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não está na lixeira.")
        row = conn.execute("SELECT * FROM history WHERE id = ?", (item_id,)).fetchone()
    return HistoryItem(**{**dict(row), "favorite": bool(row["favorite"])})


@app.delete("/api/history/{item_id}/permanent")
def delete_history_item_permanent(item_id: int) -> dict:
    """Exclusão definitiva — só permitida para itens já na lixeira."""
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM history WHERE id = ? AND deleted_at IS NOT NULL",
            (item_id,),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não está na lixeira.")
    return {"deleted_permanently": item_id}


@app.delete("/api/history/trash/empty")
def empty_trash() -> dict:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM history WHERE deleted_at IS NOT NULL")
    return {"deleted_permanently": cursor.rowcount}


@app.post("/api/history/bulk")
def bulk_history_action(payload: BulkHistoryRequest) -> dict:
    """Aplica a mesma ação a vários registros do histórico de uma vez
    (favoritar, mover para lixeira, restaurar ou excluir definitivamente)."""
    placeholders = ",".join("?" for _ in payload.ids)
    with get_connection() as conn:
        if payload.action == "favorite":
            cursor = conn.execute(f"UPDATE history SET favorite = 1 WHERE id IN ({placeholders})", payload.ids)
        elif payload.action == "unfavorite":
            cursor = conn.execute(f"UPDATE history SET favorite = 0 WHERE id IN ({placeholders})", payload.ids)
        elif payload.action == "trash":
            cursor = conn.execute(
                f"UPDATE history SET deleted_at = datetime('now') WHERE id IN ({placeholders}) AND deleted_at IS NULL",
                payload.ids,
            )
        elif payload.action == "restore":
            cursor = conn.execute(
                f"UPDATE history SET deleted_at = NULL WHERE id IN ({placeholders}) AND deleted_at IS NOT NULL",
                payload.ids,
            )
        elif payload.action == "permanent_delete":
            cursor = conn.execute(
                f"DELETE FROM history WHERE id IN ({placeholders}) AND deleted_at IS NOT NULL", payload.ids
            )
        else:
            raise HTTPException(status_code=400, detail="Ação desconhecida.")
    return {"action": payload.action, "affected": cursor.rowcount}


@app.patch("/api/history/{item_id}/favorite", response_model=HistoryItem)
def toggle_favorite(item_id: int) -> HistoryItem:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM history WHERE id = ? AND deleted_at IS NULL", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
        new_value = 0 if row["favorite"] else 1
        conn.execute("UPDATE history SET favorite = ? WHERE id = ?", (new_value, item_id))
        updated = conn.execute("SELECT * FROM history WHERE id = ?", (item_id,)).fetchone()
    return HistoryItem(**{**dict(updated), "favorite": bool(updated["favorite"])})


@app.patch("/api/history/{item_id}/note", response_model=HistoryItem)
def update_history_note(item_id: int, payload: HistoryNoteUpdate) -> HistoryItem:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM history WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
        conn.execute("UPDATE history SET note = ? WHERE id = ?", (payload.note.strip(), item_id))
        updated = conn.execute("SELECT * FROM history WHERE id = ?", (item_id,)).fetchone()
    return HistoryItem(**{**dict(updated), "favorite": bool(updated["favorite"])})


@app.get("/api/history/export")
def export_history(q: str | None = None, mode: str | None = None, favorite_only: bool = False):
    where, params = _build_history_filters(q, mode, favorite_only)
    with get_connection() as conn:
        rows = conn.execute(f"SELECT * FROM history {where} ORDER BY id DESC", params).fetchall()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "id", "data_hora", "modo", "prompt_original", "prompt_otimizado",
        "tokens_antes", "tokens_depois", "origem_tokens", "qualidade_antes", "qualidade_depois", "favorito",
    ])
    for r in rows:
        writer.writerow([
            r["id"], r["created_at"], r["mode"], r["original_prompt"], r["optimized_prompt"],
            r["tokens_before"], r["tokens_after"], r["tokens_source"], r["quality_score_before"], r["quality_score_after"],
            "sim" if r["favorite"] else "não",
        ])
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=historico_prompt_fixer.csv"},
    )


# ---------- API: templates ----------

@app.get("/api/templates", response_model=list[PromptTemplate])
def get_templates() -> list[PromptTemplate]:
    return [PromptTemplate(**t) for t in _PROMPT_TEMPLATES]


# ---------- API: templates pessoais (salvos pelo usuário) ----------

@app.get("/api/custom-templates", response_model=list[CustomTemplate])
def get_custom_templates() -> list[CustomTemplate]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM custom_templates ORDER BY id DESC").fetchall()
    return [CustomTemplate(**dict(row)) for row in rows]


@app.post("/api/custom-templates", response_model=CustomTemplate, status_code=201)
def create_custom_template(payload: CustomTemplateCreate) -> CustomTemplate:
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO custom_templates (title, description, mode, prompt) VALUES (?, ?, ?, ?)",
            (payload.title.strip(), payload.description.strip(), payload.mode, payload.prompt.strip()),
        )
        new_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM custom_templates WHERE id = ?", (new_id,)).fetchone()
    return CustomTemplate(**dict(row))


@app.delete("/api/custom-templates/{template_id}")
def delete_custom_template(template_id: int) -> dict:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM custom_templates WHERE id = ?", (template_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Template não encontrado.")
    return {"deleted": template_id}


@app.get("/api/custom-templates/export")
def export_custom_templates():
    with get_connection() as conn:
        rows = conn.execute("SELECT title, description, mode, prompt FROM custom_templates ORDER BY id").fetchall()
    payload = json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2)
    return StreamingResponse(
        iter([payload]),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=meus_templates.json"},
    )


@app.post("/api/custom-templates/import")
def import_custom_templates(payload: list[CustomTemplateCreate]) -> dict:
    if not payload:
        return {"imported": 0}
    with get_connection() as conn:
        for tpl in payload:
            conn.execute(
                "INSERT INTO custom_templates (title, description, mode, prompt) VALUES (?, ?, ?, ?)",
                (tpl.title.strip(), tpl.description.strip(), tpl.mode, tpl.prompt.strip()),
            )
    return {"imported": len(payload)}


# ---------- API: stats ----------

# Preço ilustrativo (aprox. modelos GPT-4-class), só para dar uma noção
# de escala. Deixe claro na apresentação que é uma estimativa.
COST_PER_1K_TOKENS_USD = 0.03


@app.get("/api/stats", response_model=StatsResponse)
def get_stats() -> StatsResponse:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM history WHERE deleted_at IS NULL").fetchall()

    total_requests = len(rows)
    total_tokens_before = sum(r["tokens_before"] for r in rows)
    total_tokens_after = sum(r["tokens_after"] for r in rows)
    total_tokens_saved = total_tokens_before - total_tokens_after
    avg_pct = (
        (total_tokens_saved / total_tokens_before * 100) if total_tokens_before else 0.0
    )
    avg_quality_gain = (
        sum(r["quality_score_after"] - r["quality_score_before"] for r in rows) / total_requests
        if total_requests
        else 0.0
    )
    avg_quality_before = sum(r["quality_score_before"] for r in rows) / total_requests if total_requests else 0.0
    avg_quality_after = sum(r["quality_score_after"] for r in rows) / total_requests if total_requests else 0.0
    best_single_saving = max([r["tokens_before"] - r["tokens_after"] for r in rows], default=0)
    favorites_count = sum(1 for r in rows if r["favorite"])

    estimated_cost_saved_usd = (total_tokens_saved / 1000) * COST_PER_1K_TOKENS_USD

    mode_usage = Counter(r["mode"] for r in rows)
    most_used_mode = mode_usage.most_common(1)[0][0] if mode_usage else ""

    daily = Counter()
    daily_q: dict[str, dict] = {}
    for r in rows:
        day = r["created_at"][:10]
        daily[day] += r["tokens_before"] - r["tokens_after"]
        if day not in daily_q:
            daily_q[day] = {"gain": 0, "count": 0}
        daily_q[day]["gain"] += r["quality_score_after"] - r["quality_score_before"]
        daily_q[day]["count"] += 1

    daily_tokens_saved = [
        {"date": day, "tokens_saved": saved} for day, saved in sorted(daily.items())
    ]
    daily_quality = [
        {"date": day, "avg_quality_gain": round(data["gain"] / data["count"], 1)}
        for day, data in sorted(daily_q.items())
    ]

    return StatsResponse(
        total_requests=total_requests,
        total_tokens_before=total_tokens_before,
        total_tokens_after=total_tokens_after,
        total_tokens_saved=total_tokens_saved,
        best_single_saving=best_single_saving,
        avg_tokens_saved_pct=round(avg_pct, 1),
        avg_quality_gain=round(avg_quality_gain, 1),
        avg_quality_before=round(avg_quality_before, 1),
        avg_quality_after=round(avg_quality_after, 1),
        estimated_cost_saved_usd=round(estimated_cost_saved_usd, 4),
        mode_usage=dict(mode_usage),
        most_used_mode=most_used_mode,
        favorites_count=favorites_count,
        daily_tokens_saved=daily_tokens_saved,
        daily_quality=daily_quality,
    )


# ---------- API: configurações (chaves dos provedores via UI) ----------

def _provider_status_list() -> list[ProviderStatus]:
    order, overrides = _load_provider_prefs()
    statuses = []
    for provider_id in order:
        provider = PROVIDERS.get(provider_id)
        if not provider:
            continue
        current_key = os.getenv(provider["env_key"])
        statuses.append(
            ProviderStatus(
                id=provider_id,
                label=provider["label"],
                configured=bool(current_key),
                masked_key=masked_key(current_key),
                model=overrides.get(provider_id) or provider["default_model"],
            )
        )
    return statuses


@app.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    order, _ = _load_provider_prefs()
    return SettingsResponse(providers=_provider_status_list(), provider_order=order)


@app.post("/api/settings/test")
async def test_settings_key(payload: ProviderKeyUpdate) -> dict:
    if payload.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Provedor desconhecido: {payload.provider}")
    ok, message = await test_provider_key(payload.provider, payload.api_key)
    return {"ok": ok, "message": message}


@app.post("/api/settings/provider-key", response_model=SettingsResponse)
async def update_provider_key(payload: ProviderKeyUpdate) -> SettingsResponse:
    if payload.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Provedor desconhecido: {payload.provider}")
    ok, message = await test_provider_key(payload.provider, payload.api_key)
    if not ok:
        raise HTTPException(status_code=400, detail=message)
    save_provider_key(payload.provider, payload.api_key)
    reset_overhead_cache()
    order, overrides = _load_provider_prefs()
    # Aquece o cache de tokens reais com a chave nova, não bloqueia
    # indefinidamente pois é só uma chamada extra de max_tokens=1.
    await warm_up_token_cache(order, overrides)
    return SettingsResponse(providers=_provider_status_list(), provider_order=order)


@app.post("/api/settings/provider-order", response_model=SettingsResponse)
def update_provider_order(payload: ProviderOrderUpdate) -> SettingsResponse:
    unknown = [p for p in payload.order if p not in PROVIDERS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Provedor(es) desconhecido(s): {', '.join(unknown)}")
    _save_provider_order(payload.order)
    return SettingsResponse(providers=_provider_status_list(), provider_order=payload.order)


@app.post("/api/settings/provider-model", response_model=SettingsResponse)
def update_provider_model(payload: ProviderModelUpdate) -> SettingsResponse:
    if payload.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Provedor desconhecido: {payload.provider}")
    _save_provider_model(payload.provider, payload.model.strip())
    reset_overhead_cache()
    order, _ = _load_provider_prefs()
    return SettingsResponse(providers=_provider_status_list(), provider_order=order)


# ---------- API: saúde do backend ----------

@app.get("/api/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    order, overrides = _load_provider_prefs()
    with get_connection() as conn:
        total_history = conn.execute("SELECT COUNT(*) AS c FROM history").fetchone()["c"]

    active_provider = ""
    active_model = ""
    for provider_id in order:
        provider = PROVIDERS.get(provider_id)
        if provider and os.getenv(provider["env_key"]):
            active_provider = provider["label"]
            active_model = overrides.get(provider_id) or provider["default_model"]
            break

    return HealthResponse(
        status="ok" if active_provider else "degraded",
        any_provider_configured=bool(active_provider),
        active_provider=active_provider,
        active_model=active_model,
        total_history=total_history,
        version=APP_VERSION,
    )


# ---------- API: backup e restauração completos ----------

@app.get("/api/backup/export", response_model=None)
def export_backup():
    with get_connection() as conn:
        history_rows = [dict(r) for r in conn.execute("SELECT * FROM history ORDER BY id").fetchall()]
        template_rows = [dict(r) for r in conn.execute("SELECT * FROM custom_templates ORDER BY id").fetchall()]
    payload = BackupExport(
        version=APP_VERSION,
        exported_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
        history=history_rows,
        custom_templates=template_rows,
    )
    body = payload.model_dump_json(indent=2)
    return StreamingResponse(
        iter([body]),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=backup_prompt_fixer.json"},
    )


@app.post("/api/backup/import", response_model=BackupImportResult)
def import_backup(payload: BackupExport) -> BackupImportResult:
    """Restaura um backup — os itens são ADICIONADOS ao que já existe (com
    IDs novos), nunca substituem os dados atuais. Seguro pra rodar mais de
    uma vez sem perder nada.
    """
    history_imported = 0
    templates_imported = 0
    with get_connection() as conn:
        for row in payload.history:
            conn.execute(
                """
                INSERT INTO history
                    (created_at, mode, original_prompt, optimized_prompt, tokens_before, tokens_after,
                     quality_score_before, quality_score_after, favorite, tokens_source, deleted_at, provider)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row.get("created_at"), row.get("mode"), row.get("original_prompt"), row.get("optimized_prompt"),
                    row.get("tokens_before", 0), row.get("tokens_after", 0),
                    row.get("quality_score_before", 0), row.get("quality_score_after", 0),
                    int(bool(row.get("favorite"))), row.get("tokens_source", "estimado"),
                    row.get("deleted_at"), row.get("provider", "groq"),
                ),
            )
            history_imported += 1
        for row in payload.custom_templates:
            conn.execute(
                "INSERT INTO custom_templates (title, description, mode, prompt) VALUES (?, ?, ?, ?)",
                (row.get("title", ""), row.get("description", ""), row.get("mode", "otimizar"), row.get("prompt", "")),
            )
            templates_imported += 1
    return BackupImportResult(history_imported=history_imported, templates_imported=templates_imported)


# ---------- Páginas web ----------

@app.get("/", response_class=HTMLResponse)
def index_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/historico")
def history_page():
    return RedirectResponse(url="/")


@app.get("/dashboard")
def dashboard_page():
    return RedirectResponse(url="/")
