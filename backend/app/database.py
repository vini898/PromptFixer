import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "data.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    mode TEXT NOT NULL,
    original_prompt TEXT NOT NULL,
    optimized_prompt TEXT NOT NULL,
    tokens_before INTEGER NOT NULL,
    tokens_after INTEGER NOT NULL,
    quality_score_before INTEGER NOT NULL DEFAULT 0,
    quality_score_after INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS custom_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL,
    prompt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS response_cache (
    cache_key TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    optimized_prompt TEXT NOT NULL,
    tokens_before INTEGER NOT NULL,
    tokens_after INTEGER NOT NULL,
    tokens_source TEXT NOT NULL DEFAULT 'estimado',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    hits INTEGER NOT NULL DEFAULT 0
);

-- Configurações simples de chave-valor (ordem de provedores, modelo
-- escolhido por provedor, etc.) — nada sensível, chaves de API
-- continuam só no .env.
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (name,)).fetchone()
    return row is not None


def _setup_fts(conn: sqlite3.Connection) -> None:
    """Cria a tabela de busca full-text (FTS5) do histórico, se ainda não
    existir, e a mantém sincronizada via triggers. Isso troca a busca por
    `LIKE '%...%'` (lenta e sem relevância) por uma busca tokenizada de
    verdade. Se a build do SQLite não tiver FTS5 (raro), falha em
    silêncio e a busca cai de volta para `LIKE`.
    """
    if _table_exists(conn, "history_fts"):
        return
    try:
        conn.executescript(
            """
            CREATE VIRTUAL TABLE history_fts USING fts5(
                original_prompt, optimized_prompt, content='history', content_rowid='id'
            );
            CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
                INSERT INTO history_fts(rowid, original_prompt, optimized_prompt)
                VALUES (new.id, new.original_prompt, new.optimized_prompt);
            END;
            CREATE TRIGGER history_ad AFTER DELETE ON history BEGIN
                INSERT INTO history_fts(history_fts, rowid, original_prompt, optimized_prompt)
                VALUES('delete', old.id, old.original_prompt, old.optimized_prompt);
            END;
            CREATE TRIGGER history_au AFTER UPDATE ON history BEGIN
                INSERT INTO history_fts(history_fts, rowid, original_prompt, optimized_prompt)
                VALUES('delete', old.id, old.original_prompt, old.optimized_prompt);
                INSERT INTO history_fts(rowid, original_prompt, optimized_prompt)
                VALUES (new.id, new.original_prompt, new.optimized_prompt);
            END;
            """
        )
        # Preenche o índice com o que já existia antes da tabela FTS existir.
        conn.execute(
            "INSERT INTO history_fts(rowid, original_prompt, optimized_prompt) "
            "SELECT id, original_prompt, optimized_prompt FROM history"
        )
    except sqlite3.OperationalError:
        pass  # build do SQLite sem suporte a FTS5 — busca cai para LIKE


def fts_available(conn: sqlite3.Connection) -> bool:
    return _table_exists(conn, "history_fts")


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        # Migrações leves para bancos criados por versões anteriores,
        # evitando ter que apagar o banco a cada atualização do app.
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(history)")}
        if "quality_score_before" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN quality_score_before INTEGER NOT NULL DEFAULT 0")
        if "quality_score_after" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN quality_score_after INTEGER NOT NULL DEFAULT 0")
        if "favorite" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
        if "tokens_source" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN tokens_source TEXT NOT NULL DEFAULT 'estimado'")
        if "deleted_at" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN deleted_at TEXT")
        if "provider" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN provider TEXT NOT NULL DEFAULT 'groq'")
        if "note" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN note TEXT NOT NULL DEFAULT ''")

        cache_cols = {row["name"] for row in conn.execute("PRAGMA table_info(response_cache)")}
        if "provider" not in cache_cols:
            conn.execute("ALTER TABLE response_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'groq'")

        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_mode ON history(mode)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_deleted_at ON history(deleted_at)")

        _setup_fts(conn)


@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
