from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from pathlib import Path

import httpx

# ---------- Provedores de IA suportados ----------
# Todos falam o mesmo formato de API (OpenAI-compatible chat completions),
# então dá pra tratar de forma genérica: basta trocar URL/modelo/chave.
# A ordem de tentativa e o modelo escolhido por provedor ficam salvos no
# banco (tabela app_settings) e são passados pra cá pelo main.py — este
# módulo não acessa o banco diretamente.
PROVIDERS: dict[str, dict] = {
    "groq": {
        "label": "Groq",
        "base_url": "https://api.groq.com/openai/v1/chat/completions",
        "default_model": "llama-3.3-70b-versatile",
        "env_key": "GROQ_API_KEY",
        "signup_url": "https://console.groq.com/keys",
    },
    "cerebras": {
        "label": "Cerebras",
        "base_url": "https://api.cerebras.ai/v1/chat/completions",
        "default_model": "llama-3.3-70b",
        "env_key": "CEREBRAS_API_KEY",
        "signup_url": "https://cloud.cerebras.ai/",
    },
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1/chat/completions",
        "default_model": "meta-llama/llama-3.3-70b-instruct:free",
        "env_key": "OPENROUTER_API_KEY",
        "signup_url": "https://openrouter.ai/keys",
    },
}

DEFAULT_PROVIDER_ORDER: list[str] = ["groq", "cerebras", "openrouter"]

# Caminho do .env do backend (independe do diretório de onde o uvicorn
# for iniciado), usado pela tela de configuração da chave na UI.
ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"

# Quantos caracteres um prompt pode ter. Existe principalmente para não
# deixar a UI travar nem estourar o contexto do modelo com um texto gigante.
MAX_PROMPT_CHARS = 6000

# Estimativa local de tokens (não é o tokenizador exato do modelo, mas é
# consistente e reproduzível). Usada como fallback quando o provedor não
# devolve contagem real de tokens — na maioria das vezes usamos a
# contagem REAL, veja `call_llm_full` abaixo.
_TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)

SYSTEM_PROMPTS: dict[str, str] = {
    "otimizar": (
        "Você reescreve prompts de usuários para IAs, tornando-os mais "
        "claros, objetivos e curtos, sem perder nenhuma informação ou "
        "intenção essencial do prompt original.\n\n"
        "Regras:\n"
        "- Remova redundâncias, rodeios e informações irrelevantes.\n"
        "- Use frases diretas e instruções explícitas (o que fazer, "
        "formato esperado, restrições).\n"
        "- Preserve todos os requisitos, dados, exemplos e restrições "
        "importantes do original.\n"
        "- Não adicione informação nova que não estava implícita no "
        "original.\n"
        "- Responda APENAS com o prompt reescrito, sem comentários, sem "
        "aspas, sem explicações."
    ),
    "resumir": (
        "Você resume prompts longos, mantendo só a essência do pedido em "
        "poucas frases diretas. Corte exemplos, contexto redundante e "
        "detalhes secundários. Responda APENAS com o resumo, sem "
        "comentários nem aspas."
    ),
    "traduzir": (
        "Você traduz o prompt do usuário para inglês, mantendo o tom e a "
        "intenção originais, de forma natural e objetiva. Responda APENAS "
        "com o texto traduzido, sem comentários nem aspas."
    ),
    "codigo": (
        "Você reestrutura o pedido do usuário em um prompt técnico ideal "
        "para um assistente de programação, organizado em: Tarefa, "
        "Contexto, Restrições e Formato de saída esperado. Seja direto e "
        "não invente requisitos que o usuário não mencionou. Responda "
        "APENAS com o prompt reestruturado."
    ),
    "enriquecimento": (
        "Você é um especialista em Prompt Engineering. Sua tarefa é enriquecer e expandir o prompt do usuário, "
        "tornando-o extremamente detalhado, contextualizado e completo.\n\n"
        "Estruture o prompt enriquecido com:\n"
        "- Papel/Persona (Quem a IA deve ser)\n"
        "- Contexto de fundo e objetivo principal\n"
        "- Instruções detalhadas e critérios de qualidade\n"
        "- Restrições, Tom e Formato de saída esperado\n\n"
        "Responda APENAS com o prompt enriquecido, sem comentários nem aspas."
    ),
}

_QUALITY_REVIEW_SYSTEM_PROMPT = (
    "Você é um revisor especialista em Prompt Engineering. Avalie o prompt "
    "do usuário com profundidade (clareza, especificidade, contexto, "
    "viabilidade). Responda APENAS em JSON válido, exatamente neste "
    'formato, sem markdown e sem texto fora do JSON: {"score": <0-100>, '
    '"pontos_fortes": ["..."], "pontos_fracos": ["..."], "sugestao": "..."}'
)

_SIMULATION_SYSTEM_PROMPT = (
    "Você é um assistente de IA altamente inteligente, capacitado e direto. Responda à solicitação do usuário "
    "com alta qualidade, precisão e boa formatação (markdown se aplicável), simulando o resultado da IA."
)

# Cache em memória: quantos tokens o system prompt de cada (provedor,
# modelo, modo) consome sozinho, segundo o tokenizador real daquele
# provedor. Medido uma única vez (chamada muito barata, max_tokens=1) e
# reaproveitado depois — a API só devolve o total (system + usuário),
# então subtraímos essa "gordura" fixa pra saber o tamanho real do
# prompt ORIGINAL do usuário.
_SYSTEM_PROMPT_OVERHEAD: dict[tuple[str, str, str], int] = {}

# Erros considerados temporários (vale a pena tentar de novo);
# erros de chave inválida, prompt inválido etc. NÃO entram aqui.
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _headers(api_key: str) -> dict:
    return {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}


async def _post_with_retry(client: httpx.AsyncClient, url: str, payload: dict, api_key: str, attempts: int = 3) -> dict:
    """Chama a API de um provedor com retry exponencial simples para falhas
    temporárias (timeout, conexão caiu, rate limit, erro 5xx). Erros de
    autenticação ou de requisição inválida (4xx que não seja 429) não são
    tentados de novo, pois tentar de novo não vai resolver.
    """
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            response = await client.post(url, headers=_headers(api_key), json=payload)
            if response.status_code in _RETRYABLE_STATUS and attempt < attempts - 1:
                await asyncio.sleep(0.6 * (attempt + 1))
                continue
            response.raise_for_status()
            return response.json()
        except (httpx.TimeoutException, httpx.ConnectError) as exc:
            last_exc = exc
            if attempt < attempts - 1:
                await asyncio.sleep(0.6 * (attempt + 1))
                continue
            raise
        except httpx.HTTPStatusError as exc:
            last_exc = exc
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("Falha desconhecida ao chamar o provedor de IA.")


def count_tokens(text: str) -> int:
    """Estima o número de tokens de um texto (fallback local).

    Modelos de linguagem geralmente quebram palavras em sub-unidades
    (tokens), então aproximamos: cada "palavra ou pontuação" conta como
    ~1.3 tokens. Só é usada quando a contagem real do provedor não está
    disponível.
    """
    if not text:
        return 0
    units = _TOKEN_PATTERN.findall(text)
    return max(1, round(len(units) * 1.3))


_VAGUE_WORDS = {
    "coisa", "coisas", "algo", "tipo", "meio", "mais ou menos", "sei lá",
    "alguma", "algum", "negócio", "trem", "etc",
}

_ACTION_VERBS = {
    "crie", "criar", "escreva", "escrever", "gere", "gerar", "explique",
    "explicar", "resuma", "resumir", "compare", "comparar", "liste",
    "listar", "traduza", "traduzir", "analise", "analisar", "corrija",
    "corrigir", "otimize", "otimizar", "desenvolva", "desenvolver",
    "calcule", "calcular", "faça", "faz", "fazer", "monte", "montar",
    "descreva", "descrever", "identifique", "identificar", "sugira",
    "sugerir", "revise", "revisar",
}


def prompt_quality_score(text: str) -> dict:
    """Heurística simples (0-100) para dar feedback sobre a qualidade de um
    prompt: tem verbo de ação claro? tem tamanho razoável? evita termos
    vagos? Não usa IA — é só análise de texto, então é instantâneo e
    gratuito. Para uma segunda opinião mais profunda (via IA), veja
    `ai_quality_review`.
    """
    words = re.findall(r"\w+", text.lower())
    word_count = len(words)
    score = 50
    reasons: list[str] = []

    if word_count == 0:
        return {"score": 0, "reasons": ["Prompt vazio."]}

    if any(v in words for v in _ACTION_VERBS):
        score += 15
        reasons.append("Tem um verbo de ação claro (ex: crie, explique, resuma).")
    else:
        reasons.append("Falta um verbo de ação claro no início do pedido.")

    vague_hits = sum(1 for w in _VAGUE_WORDS if w in text.lower())
    if vague_hits == 0:
        score += 15
        reasons.append("Não usa termos vagos.")
    else:
        score -= vague_hits * 8
        reasons.append(f"Usa {vague_hits} termo(s) vago(s) (ex: 'coisa', 'tipo').")

    if 6 <= word_count <= 80:
        score += 15
        reasons.append("Tamanho adequado (nem curto demais, nem prolixo).")
    elif word_count < 6:
        score -= 10
        reasons.append("Muito curto — pode faltar contexto.")
    else:
        score -= 5
        reasons.append("Longo — pode ter informação redundante.")

    if any(ch.isdigit() for ch in text) or '"' in text:
        score += 5
        reasons.append("Contém dados concretos (números, exemplos).")

    score = max(0, min(100, score))
    return {"score": score, "reasons": reasons}


# ---------- Chamada crua a um provedor (sem lógica de negócio) ----------

async def _request_provider(
    provider_id: str, api_key: str, model: str, system_prompt: str, user_content: str, max_tokens: int
) -> dict:
    """Chamada de baixo nível a UM provedor específico. Devolve {text, usage}."""
    provider = PROVIDERS[provider_id]
    async with httpx.AsyncClient(timeout=30) as client:
        data = await _post_with_retry(
            client,
            provider["base_url"],
            {
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
            },
            api_key,
        )
    text = data["choices"][0]["message"]["content"].strip()
    usage = data.get("usage") or {}
    return {"text": text, "usage": usage}


async def _with_provider_fallback(
    system_prompt: str,
    user_content: str,
    max_tokens: int,
    provider_order: list[str] | None,
    model_overrides: dict[str, str] | None,
) -> dict:
    """Tenta os provedores configurados na ordem definida, passando para o
    próximo sempre que um falhar (rate limit, timeout, chave inválida,
    etc.). Provedores sem chave configurada são pulados. Só levanta erro
    se TODOS os provedores da lista falharem ou nenhum estiver configurado.
    """
    order = provider_order or DEFAULT_PROVIDER_ORDER
    overrides = model_overrides or {}
    last_exc: Exception | None = None
    any_configured = False

    for provider_id in order:
        provider = PROVIDERS.get(provider_id)
        if not provider:
            continue
        api_key = os.getenv(provider["env_key"])
        if not api_key:
            continue
        any_configured = True
        model = overrides.get(provider_id) or provider["default_model"]
        try:
            result = await _request_provider(provider_id, api_key, model, system_prompt, user_content, max_tokens)
            result["provider"] = provider_id
            result["provider_label"] = provider["label"]
            result["model"] = model
            return result
        except Exception as exc:  # noqa: BLE001 - tenta o próximo provedor
            last_exc = exc
            continue

    if not any_configured:
        raise RuntimeError("Nenhum provedor de IA está configurado. Vá em Configurações e adicione uma chave.")
    raise RuntimeError(f"Todos os provedores configurados falharam. Último erro: {last_exc}")


async def _get_system_prompt_overhead(provider_id: str, model: str, api_key: str, mode: str) -> int | None:
    """Mede (uma vez por provedor+modelo+modo, depois fica em cache) quantos
    tokens o system prompt daquele modo consome sozinho. Uma chamada de
    max_tokens=1 é extremamente barata.
    """
    cache_key = (provider_id, model, mode)
    if cache_key in _SYSTEM_PROMPT_OVERHEAD:
        return _SYSTEM_PROMPT_OVERHEAD[cache_key]
    system_prompt = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["otimizar"])
    try:
        result = await _request_provider(provider_id, api_key, model, system_prompt, "x", 1)
        overhead = result["usage"].get("prompt_tokens")
        if overhead is not None:
            _SYSTEM_PROMPT_OVERHEAD[cache_key] = overhead
        return overhead
    except Exception:
        return None


def reset_overhead_cache() -> None:
    """Limpa o cache de overhead do system prompt. Chamado quando uma chave
    é trocada pela UI de configurações, já que uma chave nova pode valer
    para uma conta/organização diferente — mais seguro remedir.
    """
    _SYSTEM_PROMPT_OVERHEAD.clear()


async def warm_up_token_cache(provider_order: list[str] | None = None, model_overrides: dict[str, str] | None = None) -> None:
    """Pré-aquece o cache de overhead de todos os provedores configurados,
    para que a primeira otimização de cada um já use contagem real de
    tokens. Chamado no startup do FastAPI; falha silenciosamente por
    provedor se não houver chave ou se estiver fora do ar — nesse caso os
    pedidos daquele provedor caem para a estimativa local até funcionar.
    """
    order = provider_order or DEFAULT_PROVIDER_ORDER
    overrides = model_overrides or {}
    for provider_id in order:
        provider = PROVIDERS.get(provider_id)
        if not provider:
            continue
        api_key = os.getenv(provider["env_key"])
        if not api_key:
            continue
        model = overrides.get(provider_id) or provider["default_model"]
        for mode in SYSTEM_PROMPTS:
            await _get_system_prompt_overhead(provider_id, model, api_key, mode)


async def call_llm_full(
    prompt: str, mode: str, provider_order: list[str] | None = None, model_overrides: dict[str, str] | None = None
) -> dict:
    """Reescreve o prompt via IA e devolve texto + contagem de tokens +
    qual provedor realmente atendeu (pode não ser o primeiro da lista, se
    ele estiver indisponível — veja `_with_provider_fallback`).

    Sempre que possível usa a contagem REAL de tokens devolvida pelo
    próprio provedor (tokenizador exato do modelo) em vez da estimativa
    local — tokens_after vem direto de `usage.completion_tokens`, e
    tokens_before é calculado subtraindo o "peso" fixo do system prompt do
    `usage.prompt_tokens` total. Se o provedor não devolver `usage` por
    algum motivo, cai de volta para a estimativa local automaticamente.
    """
    system_prompt = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["otimizar"])
    result = await _with_provider_fallback(system_prompt, prompt, 1024, provider_order, model_overrides)
    text = result["text"]
    usage = result["usage"]
    provider_id, model = result["provider"], result["model"]

    tokens_after = usage.get("completion_tokens")
    tokens_before = None
    api_key = os.getenv(PROVIDERS[provider_id]["env_key"])
    overhead = await _get_system_prompt_overhead(provider_id, model, api_key, mode) if api_key else None
    if usage.get("prompt_tokens") is not None and overhead is not None:
        tokens_before = max(1, usage["prompt_tokens"] - overhead + 1)

    real = tokens_after is not None and tokens_before is not None
    return {
        "text": text,
        "tokens_before": tokens_before if tokens_before is not None else count_tokens(prompt),
        "tokens_after": tokens_after if tokens_after is not None else count_tokens(text),
        "tokens_source": "real" if real else "estimado",
        "provider": provider_id,
        "provider_label": result["provider_label"],
        "model": model,
    }


async def simulate_ai_response(
    prompt: str, provider_order: list[str] | None = None, model_overrides: dict[str, str] | None = None
) -> dict:
    result = await _with_provider_fallback(_SIMULATION_SYSTEM_PROMPT, prompt, 1200, provider_order, model_overrides)
    return {"text": result["text"], "provider_label": result["provider_label"]}


async def ai_quality_review(
    prompt: str, provider_order: list[str] | None = None, model_overrides: dict[str, str] | None = None
) -> dict:
    """Segunda opinião sobre a qualidade do prompt, usando a própria IA em
    vez da heurística local (`prompt_quality_score`) — mais lenta (gasta
    uma chamada de API) porém mais criteriosa. Sob demanda, nunca automática.
    """
    result = await _with_provider_fallback(_QUALITY_REVIEW_SYSTEM_PROMPT, prompt, 500, provider_order, model_overrides)
    try:
        parsed = json.loads(result["text"])
        return {
            "score": int(parsed.get("score", 0)),
            "pontos_fortes": list(parsed.get("pontos_fortes", []))[:6],
            "pontos_fracos": list(parsed.get("pontos_fracos", []))[:6],
            "sugestao": str(parsed.get("sugestao", "")),
            "provider_label": result["provider_label"],
        }
    except Exception:
        # Se a IA não respondeu em JSON válido, ainda mostramos o texto
        # cru como sugestão, sem quebrar a funcionalidade.
        return {
            "score": None,
            "pontos_fortes": [],
            "pontos_fracos": [],
            "sugestao": result["text"],
            "provider_label": result["provider_label"],
        }


def make_cache_key(prompt: str, mode: str) -> str:
    """Chave determinística pro cache de respostas: mesmo prompt + mesmo
    modo sempre gera a mesma chave, então uma segunda otimização idêntica
    pode reaproveitar o resultado sem chamar a IA de novo (independente de
    qual provedor teria atendido).
    """
    normalized = f"{mode}::{prompt.strip()}"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ---------- Configuração das chaves dos provedores (via UI, sem editar .env) ----------

def masked_key(key: str | None) -> str:
    """Nunca devolvemos a chave inteira pro navegador — só uma prévia tipo
    'gsk_...ab12', pra confirmar visualmente qual chave está configurada."""
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:4]}...{key[-4:]}"


async def test_provider_key(provider_id: str, key: str, model: str | None = None) -> tuple[bool, str]:
    """Faz uma chamada mínima (max_tokens=1) só pra validar se a chave
    funciona antes de salvar, com uma mensagem de erro amigável."""
    provider = PROVIDERS.get(provider_id)
    if not provider:
        return False, f"Provedor desconhecido: {provider_id}"
    model = model or provider["default_model"]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await _post_with_retry(
                client,
                provider["base_url"],
                {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "oi"}]},
                key,
                attempts=1,
            )
        return True, "Conexão OK."
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 401:
            return False, "Chave inválida (401 - não autorizado)."
        return False, f"{provider['label']} respondeu com erro {exc.response.status_code}."
    except Exception as exc:  # noqa: BLE001
        return False, f"Não foi possível conectar a {provider['label']}: {exc}"


def save_provider_key(provider_id: str, key: str) -> None:
    """Grava a chave no .env do backend e já atualiza o processo em
    execução, sem precisar reiniciar o uvicorn."""
    provider = PROVIDERS[provider_id]
    env_var = provider["env_key"]
    lines: list[str] = []
    found = False
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith(f"{env_var}="):
                lines.append(f"{env_var}={key}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"{env_var}={key}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.environ[env_var] = key
