"""SQLite-backed user storage: accounts, free-trial usage, subscription state.

A short-lived connection is opened per call rather than shared across
requests - sqlite3 connections aren't safe to share across FastAPI's
threadpool, and reading settings.db_path fresh each time (instead of once
at import) is what lets tests point this at a temp file via monkeypatch.
"""

import os
import sqlite3
import time
from contextlib import contextmanager

from app.config import settings


@contextmanager
def _connect():
    os.makedirs(os.path.dirname(settings.db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                auth_token_hash TEXT,
                trial_searches_used INTEGER NOT NULL DEFAULT 0,
                subscription_status TEXT NOT NULL DEFAULT 'none',
                razorpay_subscription_id TEXT,
                subscription_current_end INTEGER,
                reset_token_hash TEXT,
                reset_token_expires_at INTEGER,
                created_at TEXT NOT NULL
            )
            """
        )
        # Existing local DB files predate these columns - CREATE TABLE IF NOT EXISTS
        # won't add them, so patch the schema in place rather than requiring a fresh DB.
        existing_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        for column, ddl_type in (("reset_token_hash", "TEXT"), ("reset_token_expires_at", "INTEGER")):
            if column not in existing_columns:
                conn.execute(f"ALTER TABLE users ADD COLUMN {column} {ddl_type}")

        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_token_hash ON users(auth_token_hash)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_reset_token_hash ON users(reset_token_hash)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                query TEXT,
                event_type TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def create_user(email: str, password_hash: str) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
            (email, password_hash, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        )
        conn.commit()
        return cur.lastrowid


def get_user_by_email(email: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def get_user_by_token_hash(token_hash: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE auth_token_hash = ?", (token_hash,)).fetchone()


def set_auth_token_hash(user_id: int, token_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET auth_token_hash = ? WHERE id = ?", (token_hash, user_id))
        conn.commit()


def clear_auth_token(user_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET auth_token_hash = NULL WHERE id = ?", (user_id,))
        conn.commit()


def try_consume_access(user_id: int, free_trial_limit: int) -> bool:
    """Atomically grants access: subscribers pass free, others spend one trial.

    The trial count is decremented in the same statement as the eligibility
    check (`WHERE trial_searches_used < ?`), so two concurrent requests for
    the same user can't both pass the check before either one writes.
    """
    with _connect() as conn:
        row = conn.execute(
            "SELECT subscription_status, subscription_current_end FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            return False
        if row["subscription_status"] == "active" and (row["subscription_current_end"] or 0) > time.time():
            return True

        cur = conn.execute(
            "UPDATE users SET trial_searches_used = trial_searches_used + 1 "
            "WHERE id = ? AND trial_searches_used < ?",
            (user_id, free_trial_limit),
        )
        conn.commit()
        return cur.rowcount == 1


def set_subscription_pending(user_id: int, razorpay_subscription_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET razorpay_subscription_id = ? WHERE id = ?",
            (razorpay_subscription_id, user_id),
        )
        conn.commit()


def set_subscription_active(razorpay_subscription_id: str, current_end: int | None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET subscription_status = 'active', subscription_current_end = ? "
            "WHERE razorpay_subscription_id = ?",
            (current_end, razorpay_subscription_id),
        )
        conn.commit()


def set_subscription_cancelled(razorpay_subscription_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET subscription_status = 'cancelled' WHERE razorpay_subscription_id = ?",
            (razorpay_subscription_id,),
        )
        conn.commit()


def get_user_by_razorpay_subscription_id(razorpay_subscription_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE razorpay_subscription_id = ?", (razorpay_subscription_id,)
        ).fetchone()


def update_password(user_id: int, password_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
        conn.commit()


def set_reset_token(user_id: int, token_hash: str, expires_at: int) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ? WHERE id = ?",
            (token_hash, expires_at, user_id),
        )
        conn.commit()


def get_user_by_reset_token_hash(token_hash: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE reset_token_hash = ?", (token_hash,)).fetchone()


def consume_reset_token(user_id: int, password_hash: str) -> None:
    """Sets the new password and invalidates the reset token and any active session."""
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires_at = NULL, "
            "auth_token_hash = NULL WHERE id = ?",
            (password_hash, user_id),
        )
        conn.commit()


def delete_user(user_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()


def log_audit_event(user_id: int, query: str, event_type: str, detail: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO audit_events (user_id, query, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, query, event_type, detail, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        )
        conn.commit()
