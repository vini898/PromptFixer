from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.services.optimizer import MAX_PROMPT_CHARS

Mode = Literal["otimizar", "resumir", "traduzir", "codigo", "enriquecimento"]
TokensSource = Literal["real", "estimado"]
BulkAction = Literal["favorite", "unfavorite", "trash", "restore", "permanent_delete"]


class OptimizeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)
    mode: Mode = "otimizar"


class SimulateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)


class SimulateResponse(BaseModel):
    prompt: str
    simulated_response: str
    provider_label: str = ""


class OptimizeResponse(BaseModel):
    id: int | None = None
    mode: Mode
    original_prompt: str
    optimized_prompt: str
    tokens_before: int
    tokens_after: int
    tokens_saved: int
    tokens_saved_pct: float
    tokens_source: TokensSource = "estimado"
    from_cache: bool = False
    provider: str = ""
    provider_label: str = ""
    quality_score_before: int
    quality_score_after: int
    quality_reasons_before: list[str]
    quality_reasons_after: list[str]
    ai_name: str = ""
    ai_company: str = ""
    ai_model: str = ""
    ai_url: str = ""
    ai_icon: str = ""
    ai_color: str = ""
    ai_reason: str = ""


class HistoryItem(BaseModel):
    id: int
    created_at: str
    mode: str
    original_prompt: str
    optimized_prompt: str
    tokens_before: int
    tokens_after: int
    quality_score_before: int
    quality_score_after: int
    favorite: bool = False
    tokens_source: TokensSource = "estimado"
    deleted_at: str | None = None
    provider: str = "groq"
    note: str = ""


class HistoryNoteUpdate(BaseModel):
    note: str = Field(default="", max_length=500)


class HistoryPage(BaseModel):
    items: list[HistoryItem]
    total: int


class BulkHistoryRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    action: BulkAction


class BatchOptimizeRequest(BaseModel):
    prompts: list[Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]] = Field(min_length=1, max_length=20)
    mode: Mode = "otimizar"


class BatchOptimizeItem(BaseModel):
    prompt: str
    success: bool
    result: OptimizeResponse | None = None
    error: str = ""


class BatchOptimizeResponse(BaseModel):
    items: list[BatchOptimizeItem]


class StatsResponse(BaseModel):
    total_requests: int
    total_tokens_before: int
    total_tokens_after: int
    total_tokens_saved: int
    best_single_saving: int
    avg_tokens_saved_pct: float
    avg_quality_gain: float
    avg_quality_before: float
    avg_quality_after: float
    estimated_cost_saved_usd: float
    mode_usage: dict[str, int]
    most_used_mode: str
    favorites_count: int
    daily_tokens_saved: list[dict]
    daily_quality: list[dict]


class PromptTemplate(BaseModel):
    id: str
    title: str
    description: str
    mode: Mode
    icon: str
    prompt: str


class CustomTemplateCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=200)
    mode: Mode
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)


class CustomTemplate(BaseModel):
    id: int
    created_at: str
    title: str
    description: str
    mode: Mode
    prompt: str


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    any_provider_configured: bool
    active_provider: str = ""
    active_model: str = ""
    total_history: int
    version: str


class ProviderStatus(BaseModel):
    id: str
    label: str
    configured: bool
    masked_key: str = ""
    model: str


class ProviderKeyUpdate(BaseModel):
    provider: str
    api_key: str = Field(min_length=10, max_length=300)


class ProviderOrderUpdate(BaseModel):
    order: list[str]


class ProviderModelUpdate(BaseModel):
    provider: str
    model: str = Field(min_length=1, max_length=120)


class SettingsResponse(BaseModel):
    providers: list[ProviderStatus]
    provider_order: list[str]


class QualityReviewRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)


class QualityReviewResponse(BaseModel):
    score: int | None = None
    pontos_fortes: list[str] = []
    pontos_fracos: list[str] = []
    sugestao: str = ""
    provider_label: str = ""


class BackupExport(BaseModel):
    version: str
    exported_at: str
    history: list[dict]
    custom_templates: list[dict]


class BackupImportResult(BaseModel):
    history_imported: int
    templates_imported: int
