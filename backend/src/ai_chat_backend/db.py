"""SQLite 数据库模块 — 用户注册/登录 + 对话记忆持久化。

数据库文件 ``ai_chat.db`` 自动创建在项目根目录下。

安全说明：
    密码使用标准库 :func:`hashlib.pbkdf2_hmac`（SHA-256，26 万次迭代，随机盐）加盐哈希，
    不引入任何第三方依赖。旧版本使用「固定盐 + SHA256」，登录时仍可校验，
    校验通过后会自动升级为新格式，保证历史账号不受影响。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Optional

# 数据库文件始终保存在项目根目录（ai_chat/），而非 backend/ 下
_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DB_PATH = os.path.join(_PROJECT_DIR, "ai_chat.db")

# 密码哈希参数
_PBKDF2_ALGO = "sha256"
_PBKDF2_ITERATIONS = 260_000
_PBKDF2_PREFIX = "pbkdf2_sha256"
# 旧版固定盐（仅用于校验历史数据，新密码不再使用）
_LEGACY_SALT = "ai_gf_salt_"

# 数据库锁等待时间（秒）：并发写入时避免立刻抛 database is locked
_DB_TIMEOUT = 5.0


def _now() -> str:
    """返回 UTC 时间字符串，统一用于 created_at / updated_at。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 密码哈希
# ---------------------------------------------------------------------------
def _hash_password(password: str) -> str:
    """使用 PBKDF2-HMAC-SHA256 + 随机盐生成密码哈希。

    Args:
        password: 明文密码。

    Returns:
        形如 ``pbkdf2_sha256$260000$<salt_hex>$<hash_hex>`` 的字符串，
        盐随密码一起存储，校验时从串中解析。
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{_PBKDF2_PREFIX}${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def _legacy_hash(password: str) -> str:
    """旧版哈希：固定盐 + 单轮 SHA256（仅供校验历史数据）。"""
    return hashlib.sha256((_LEGACY_SALT + password).encode()).hexdigest()


def _verify_password(password: str, stored: str) -> bool:
    """校验密码，同时兼容旧版哈希格式。

    Args:
        password: 用户输入的明文密码。
        stored: 数据库中保存的哈希值。

    Returns:
        密码正确返回 True。
    """
    if not stored:
        return False
    if stored.startswith(_PBKDF2_PREFIX + "$"):
        try:
            _, iterations, salt_hex, digest_hex = stored.split("$")
            digest = hashlib.pbkdf2_hmac(
                _PBKDF2_ALGO, password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
            )
            # compare_digest 做常量时间比较，避免通过响应时间侧信道猜测哈希
            return hmac.compare_digest(digest.hex(), digest_hex)
        except (ValueError, TypeError):
            # 存储格式损坏：按校验失败处理，不让异常冒到接口层
            return False
    return hmac.compare_digest(_legacy_hash(password), stored)


def _is_legacy_hash(stored: str) -> bool:
    """判断哈希是否为旧版格式（用于登录成功后自动升级）。"""
    return bool(stored) and not stored.startswith(_PBKDF2_PREFIX + "$")


# ---------------------------------------------------------------------------
# 连接管理
# ---------------------------------------------------------------------------
def get_conn() -> sqlite3.Connection:
    """获取数据库连接，启用 WAL、外键约束与锁等待。

    Returns:
        已设置 ``row_factory`` 的连接对象，调用方负责关闭（建议配合 ``try/finally``）。
    """
    conn = sqlite3.connect(DB_PATH, timeout=_DB_TIMEOUT)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=%d" % int(_DB_TIMEOUT * 1000))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """建表与索引（幂等，应用启动时调用一次）。"""
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT    NOT NULL UNIQUE,
                password    TEXT    NOT NULL,
                created_at  TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id          TEXT PRIMARY KEY,
                user_id     INTEGER NOT NULL,
                persona_id  TEXT    NOT NULL,
                gf_name     TEXT    NOT NULL,
                title       TEXT    NOT NULL DEFAULT '',
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT    NOT NULL,
                role            TEXT    NOT NULL,
                content         TEXT    NOT NULL DEFAULT '',
                reasoning       TEXT    DEFAULT '',
                error           TEXT    DEFAULT '',
                created_at      TEXT    NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
            CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 用户操作
# ---------------------------------------------------------------------------
def create_user(username: str, password: str) -> Optional[dict]:
    """注册用户。

    Args:
        username: 用户名（唯一）。
        password: 明文密码，落库前会做 PBKDF2 加盐哈希。

    Returns:
        成功返回 ``{"id": ..., "username": ...}``；用户名已存在返回 None。
    """
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)",
            (username.strip(), _hash_password(password), _now()),
        )
        conn.commit()
        return {"id": cur.lastrowid, "username": username.strip()}
    except sqlite3.IntegrityError:
        # 用户名唯一约束冲突，属于预期业务分支
        return None
    finally:
        conn.close()


def verify_user(username: str, password: str) -> Optional[dict]:
    """校验登录信息。

    历史账号若仍是旧版哈希，校验通过后会自动改写为 PBKDF2 格式（透明升级）。

    Args:
        username: 用户名。
        password: 明文密码。

    Returns:
        成功返回 ``{"id": ..., "username": ...}``；失败返回 None。
    """
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, username, password FROM users WHERE username = ?",
            (username.strip(),),
        ).fetchone()
        if row is None or not _verify_password(password, row["password"]):
            return None

        if _is_legacy_hash(row["password"]):
            # 旧哈希升级为新格式：本次登录不受影响，下次开始使用更强哈希
            conn.execute(
                "UPDATE users SET password = ? WHERE id = ?",
                (_hash_password(password), row["id"]),
            )
            conn.commit()
        return {"id": row["id"], "username": row["username"]}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 对话操作
# ---------------------------------------------------------------------------
def save_conversation(
    conv_id: str,
    user_id: int,
    persona_id: str,
    gf_name: str,
    title: str,
    messages: list[dict],
) -> None:
    """保存或更新一段对话及其全部消息（先删旧消息再整段写入）。

    Args:
        conv_id: 对话 id（前端生成）。
        user_id: 所属用户 id。
        persona_id: 人设 id。
        gf_name: 女友名字。
        title: 对话标题。
        messages: 消息列表，元素需包含 role/content，可选 reasoning/error。

    Raises:
        PermissionError: 该 conv_id 已存在但属于其他用户（防止跨用户覆盖）。
    """
    conn = get_conn()
    now = _now()
    try:
        existing = conn.execute(
            "SELECT id, user_id FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()

        if existing is not None:
            if existing["user_id"] != user_id:
                # 客户端可以任意指定 conv_id，必须校验归属，否则能覆盖他人对话
                raise PermissionError("该对话不属于当前用户")
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, now, conv_id),
            )
            conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
        else:
            conn.execute(
                "INSERT INTO conversations (id, user_id, persona_id, gf_name, title, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (conv_id, user_id, persona_id, gf_name, title, now, now),
            )

        conn.executemany(
            "INSERT INTO messages (conversation_id, role, content, reasoning, error, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    conv_id,
                    m.get("role", ""),
                    m.get("content", ""),
                    m.get("reasoning", ""),
                    m.get("error", ""),
                    now,
                )
                for m in messages
            ],
        )
        conn.commit()
    except Exception:
        # 中途失败时回滚，避免出现「对话已建、消息只写了一半」的残缺数据
        conn.rollback()
        raise
    finally:
        conn.close()


def load_conversations(user_id: int, gf_name: Optional[str] = None, persona_id: Optional[str] = None) -> list[dict]:
    """加载用户的对话列表（含消息），可按女友名字和性格过滤。

    Args:
        user_id: 用户 id。
        gf_name: 女友名字，传入时做精确过滤。
        persona_id: 人设 id，传入时做精确过滤。

    Returns:
        对话列表，按更新时间倒序；每条包含 messages 数组。
    """
    conn = get_conn()
    try:
        conditions = ["user_id = ?"]
        params: list = [user_id]

        if gf_name:
            conditions.append("gf_name = ?")
            params.append(gf_name.strip())
        if persona_id:
            conditions.append("persona_id = ?")
            params.append(persona_id.strip())

        where = " AND ".join(conditions)
        rows = conn.execute(
            f"SELECT * FROM conversations WHERE {where} ORDER BY updated_at DESC",
            params,
        ).fetchall()
        if not rows:
            return []

        # 一次性取出所有消息再按 conversation_id 分组，避免逐条对话查询（N+1）
        conv_ids = [row["id"] for row in rows]
        placeholders = ",".join("?" for _ in conv_ids)
        msg_rows = conn.execute(
            "SELECT conversation_id, role, content, reasoning, error, created_at "
            f"FROM messages WHERE conversation_id IN ({placeholders}) ORDER BY id ASC",
            conv_ids,
        ).fetchall()

        grouped: dict[str, list[dict]] = {cid: [] for cid in conv_ids}
        for m in msg_rows:
            grouped[m["conversation_id"]].append(
                {
                    "role": m["role"],
                    "content": m["content"],
                    "reasoning": m["reasoning"] or None,
                    "error": m["error"] or None,
                    "ts": m["created_at"],
                }
            )

        return [
            {
                "id": row["id"],
                "persona_id": row["persona_id"],
                "gf_name": row["gf_name"],
                "title": row["title"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "messages": grouped.get(row["id"], []),
            }
            for row in rows
        ]
    finally:
        conn.close()


def delete_conversation(conv_id: str, user_id: Optional[int] = None) -> bool:
    """删除一段对话（消息由外键级联删除）。

    Args:
        conv_id: 对话 id。
        user_id: 传入时会校验归属，只允许删除自己的对话；
            为 None 时按 conv_id 直接删除（兼容旧调用，存在越权风险，建议始终传入）。

    Returns:
        True 表示删除成功，False 表示对话不存在或不属于该用户。
    """
    conn = get_conn()
    try:
        if user_id is None:
            cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        else:
            cur = conn.execute(
                "DELETE FROM conversations WHERE id = ? AND user_id = ?",
                (conv_id, user_id),
            )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
