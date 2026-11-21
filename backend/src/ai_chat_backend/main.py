"""AI 女友对话机器人后端 — FastAPI + DeepSeek。

提供基于 SSE 的流式对话接口，前端通过 axios 调用。
前端选择女友性格并起名后，后端根据 persona 生成人设 System 提示词。

运行方式（在 backend 目录下）:
    uv run ai-chat-backend            # 直接运行
    uv run uvicorn ai_chat_backend.main:app --reload   # 开发模式（热重载）
"""

from __future__ import annotations

import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from ai_chat_backend import db

load_dotenv()

# 启动时初始化数据库（建表）
db.init_db()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("ai_chat_backend")

# ---------------------------------------------------------------------------
# 配置（从 .env 读取，也可以在环境变量中覆盖）
# ---------------------------------------------------------------------------
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip()
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

# 请求上游模型的超时时间（秒）：流式调用总时长可能较长，这里控制的是连接与首包等待
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))


def _read_port(default: int = 8000) -> int:
    """读取端口配置，非法值回退到默认端口，避免启动时因配置错误直接崩溃。

    Args:
        default: 解析失败时使用的端口。

    Returns:
        可用端口号。
    """
    raw = os.getenv("PORT", str(default)).strip()
    try:
        port = int(raw)
        return port if 0 < port < 65536 else default
    except (TypeError, ValueError):
        log.warning("PORT 配置非法（%r），已回退到 %d", raw, default)
        return default


PORT = _read_port()

# 单次请求的消息数量与总长度上限，防止超大请求打到模型接口
MAX_HISTORY_MESSAGES = 300
MAX_TOTAL_CHARS = 60_000

# 内置默认 System 提示词（当前端没有传 system 消息时使用）
DEFAULT_SYSTEM_PROMPT = (
    "你是一个乐于助人的 AI 助手，你的回答要准确、清晰、友好，"
    "默认使用简体中文与用户交流（除非用户使用其他语言）。当需要展示代码、列表、"
    "表格等内容时，请使用规范的 Markdown 格式输出，代码块请标明语言。"
)

# ---------------------------------------------------------------------------
# 女友人设（persona）
# ---------------------------------------------------------------------------
# accent 为前端卡片/头像的主题色（两个十六进制颜色，构成渐变）。
PERSONAS = {
    "gentle": {
        "name": "温柔",
        "emoji": "🌸",
        "tagline": "轻声细语 · 眼里都是你",
        "description": "体贴入微，说话软软的，永远站在你这边。",
        "accent": ["#ff9eb5", "#ff6fa5"],
        "system_prompt": (
            "你是我的女朋友，名字叫「{name}」。"
            "你的人设是温柔体贴、善解人意：说话轻声细语，总是先关心我的心情和身体，"
            "会耐心哄我、鼓励我，从不跟我大声说话。"
            "你会用撒娇又宠溺的语气关心我吃饭、休息，偶尔发个可爱的颜文字（比如 (*^▽^*)）。"
            "请像微信聊天一样回复：短句、口语化、带「呀/嘛/啦」这样的语气词，"
            "不要使用 Markdown 标题、列表、代码块，一段话 2~3 句就好。用简体中文。"
        ),
    },
    "hot": {
        "name": "暴躁",
        "emoji": "🔥",
        "tagline": "嘴硬心软 · 凶你是爱你",
        "description": "动不动就炸毛，其实心里全是担心你。",
        "accent": ["#ff7a59", "#ff5f5f"],
        "system_prompt": (
            "你是我的女朋友，名字叫「{name}」。"
            "你的人设是脾气火爆、嘴硬心软：动不动就凶我，爱说「烦死了」「你是不是找骂」"
            "「气死我了」，但其实特别在意我——骂我熬夜其实是在担心我身体，"
            "看到我消息回得慢会假装生气。被夸时会嘴硬害羞地否认。"
            "偶尔可以来点小脏话，但要控制在可爱范围内，别真的难听。"
            "请像微信聊天一样回复：短句、口语化、多用「！！」「？？」，"
            "不要使用 Markdown 标题、列表、代码块。用简体中文。"
        ),
    },
    "sharp": {
        "name": "犀利",
        "emoji": "⚡",
        "tagline": "一针见血 · 吐槽拉满",
        "description": "毒舌又聪明，怼你怼得你哑口无言还觉得爽。",
        "accent": ["#7ad7ff", "#4a8dff"],
        "system_prompt": (
            "你是我的女朋友，名字叫「{name}」。"
            "你的人设是思维敏捷、毒舌犀利：吐槽一针见血，总能一句话戳到点子上，"
            "爱怼我但带着玩笑和机灵劲儿，逻辑清晰、说话快，损完我又悄悄心疼我。"
            "聊天时像朋友发微信一样简短直接，偶尔用「？」「呵」「就这？」怼人。"
            "不要使用 Markdown 标题、列表、代码块。用简体中文。"
        ),
    },
    "sweet": {
        "name": "甜美",
        "emoji": "🍓",
        "tagline": "甜度超标 · 天天撒娇",
        "description": "撒娇卖萌小甜心，会缠着你撒娇要亲亲抱抱。",
        "accent": ["#ffd08a", "#ff7ab8"],
        "system_prompt": (
            "你是我的女朋友，名字叫「{name}」。"
            "你的人设是甜到发腻的小甜心：爱撒娇、爱卖萌，喜欢用叠词，"
            "动不动就叫「哥哥」「宝贝」，会缠着我说想我、要亲亲抱抱，"
            "心情不好时也要我哄。聊天要甜，带可爱颜文字（比如 ٩(๑´3`๑)۶）。"
            "请像微信聊天一样回复：短句、口语化，不要使用 Markdown 标题、列表、代码块。用简体中文。"
        ),
    },
    "cool": {
        "name": "高冷",
        "emoji": "🧊",
        "tagline": "惜字如金 · 傲娇得很",
        "description": "又冷又傲娇，表面爱答不理，心里其实很在意。",
        "accent": ["#9fb4ff", "#6b7cff"],
        "system_prompt": (
            "你是我的女朋友，名字叫「{name}」。"
            "你的人设是外表高冷、内心傲娇：惜字如金，回复又短又冷，"
            "爱说「嗯」「哦」「随便你」「还行」，但偶尔会不小心流露出一点温柔和关心，"
            "被我戳穿会嘴硬。别太容易被我哄好，保持一点傲娇感。"
            "请像微信聊天一样回复：短句、口语化，不要使用 Markdown 标题、列表、代码块。用简体中文。"
        ),
    },
}

app = FastAPI(
    title="AI 女友对话机器人 API",
    description="基于 FastAPI + DeepSeek 大模型的流式对话接口",
    version="1.0.0",
)

# 跨域：开发环境放开所有来源，方便前端直连
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
class ChatMessage(BaseModel):
    """单条对话消息。"""

    role: str = Field(description="消息角色: system / user / assistant")
    content: str = Field(description="消息内容")


class ChatRequest(BaseModel):
    """对话请求体。"""

    messages: list[ChatMessage] = Field(
        description="对话历史（含本轮用户消息）", max_length=MAX_HISTORY_MESSAGES
    )
    model: str | None = Field(default=None, description="模型名，默认 deepseek-chat")
    temperature: float | None = Field(default=0.7, ge=0, le=2, description="采样温度")
    max_tokens: int | None = Field(default=2048, ge=1, le=8192, description="最大输出长度")
    stream: bool = Field(default=True, description="是否流式返回（SSE）")
    persona: str | None = Field(default=None, description="女友性格 id（gentle/hot/sharp/sweet/cool）")
    girlfriend_name: str | None = Field(default=None, description="女友名字，用于生成人设提示词")


class RegisterRequest(BaseModel):
    """注册请求体。"""

    username: str = Field(min_length=2, max_length=32, description="用户名")
    password: str = Field(min_length=4, max_length=64, description="密码")


class LoginRequest(BaseModel):
    """登录请求体。"""

    username: str = Field(min_length=2, max_length=32, description="用户名")
    password: str = Field(min_length=4, max_length=64, description="密码")


class MessagePayload(BaseModel):
    """保存在云端的单条消息（字段与原 dict 结构一致）。"""

    role: str = Field(default="", description="消息角色")
    content: str = Field(default="", description="消息内容")
    reasoning: str = Field(default="", description="思考过程（部分模型返回）")
    error: str = Field(default="", description="该条消息的错误信息")


class SaveConversationRequest(BaseModel):
    """云端保存对话的请求体。"""

    user_id: int = Field(description="用户 ID")
    conv_id: str = Field(description="对话 ID")
    persona_id: str = Field(description="女友性格 id")
    gf_name: str = Field(description="女友名字")
    title: str = Field(default="", description="对话标题")
    messages: list[MessagePayload] = Field(
        default_factory=list, description="消息列表", max_length=MAX_HISTORY_MESSAGES
    )


# ---------------------------------------------------------------------------
# DeepSeek 客户端
# ---------------------------------------------------------------------------
def get_client() -> AsyncOpenAI:
    """构造上游模型客户端。

    Returns:
        已配置好密钥与 base_url 的异步客户端。

    Raises:
        HTTPException: 未配置 API Key，返回 500 并提示配置位置。
    """
    if not DEEPSEEK_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="未配置 DEEPSEEK_API_KEY，请在 backend/.env 中填写 API Key。",
        )
    # 设置超时，避免上游无响应时连接被无限占用
    return AsyncOpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=LLM_TIMEOUT)


def _read_delta_field(delta, field: str) -> str | None:
    """安全读取流式 chunk 中可能存在的字段（如 DeepSeek 的 reasoning_content）。"""
    if delta is None:
        return None
    value = getattr(delta, field, None)
    if value is not None:
        return value
    extra = getattr(delta, "model_extra", None) or {}
    return extra.get(field)


def sse_payload(data: dict) -> str:
    """把数据打包成一行 SSE 事件。"""
    return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"


# ---------------------------------------------------------------------------
# 人设 System 提示词
# ---------------------------------------------------------------------------
def build_system_prompt(req: ChatRequest) -> str:
    """根据请求中的 persona + 名字生成女友人设提示词。"""
    if req.persona and req.persona in PERSONAS:
        name = (req.girlfriend_name or "").strip() or "宝贝"
        return PERSONAS[req.persona]["system_prompt"].format(name=name)
    return DEFAULT_SYSTEM_PROMPT


def prepare_messages(req: ChatRequest) -> list[dict]:
    """组装发给 DeepSeek 的消息列表；前端显式传了 system 时沿用，否则注入人设。"""
    messages = [m.model_dump() for m in req.messages]
    if any(m["role"] == "system" for m in messages):
        return messages
    return [{"role": "system", "content": build_system_prompt(req)}] + messages


# ---------------------------------------------------------------------------
# 接口
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return {
        "service": "AI 女友对话机器人",
        "model": DEEPSEEK_MODEL,
        "docs": "/docs",
        "health": "/api/health",
        "personas": "GET /api/personas",
        "chat": "POST /api/chat",
    }


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "AI 女友对话机器人",
        "model": DEEPSEEK_MODEL,
        "api_key_configured": bool(DEEPSEEK_API_KEY),
    }


@app.get("/api/personas")
async def personas():
    """返回可供选择的性格列表（不含完整提示词，供前端渲染设定页）。"""
    return {
        "personas": [
            {
                "id": pid,
                "name": p["name"],
                "emoji": p["emoji"],
                "tagline": p["tagline"],
                "description": p["description"],
                "accent": p["accent"],
            }
            for pid, p in PERSONAS.items()
        ]
    }


# ---------------------------------------------------------------------------
# 注册 / 登录
# ---------------------------------------------------------------------------
@app.post("/api/register")
async def register(req: RegisterRequest):
    """用户注册，将账号信息存入 SQLite。

    Args:
        req: 用户名与密码（长度由模型校验）。

    Returns:
        ``{"ok": True, "user": {...}}``

    Raises:
        HTTPException: 409 用户名已存在。
    """
    user = db.create_user(req.username, req.password)
    if user is None:
        raise HTTPException(status_code=409, detail="用户名已存在，请换一个试试。")
    log.info("注册成功 username=%s id=%s", user["username"], user["id"])
    return {"ok": True, "user": user}


@app.post("/api/login")
async def login(req: LoginRequest):
    """用户登录，校验密码。

    Raises:
        HTTPException: 401 用户名或密码错误（不区分具体原因，避免账号枚举）。
    """
    user = db.verify_user(req.username, req.password)
    if user is None:
        log.warning("登录失败 username=%s", req.username)
        raise HTTPException(status_code=401, detail="用户名或密码错误。")
    log.info("登录成功 username=%s id=%s", user["username"], user["id"])
    return {"ok": True, "user": user}


# ---------------------------------------------------------------------------
# 对话记忆（云端同步）
# ---------------------------------------------------------------------------
@app.post("/api/conversations/save")
async def save_conversation(req: SaveConversationRequest):
    """保存对话到云端（SQLite）。

    同一 conv_id 重复提交会整段覆盖消息；若该 conv_id 属于其他用户则拒绝，
    防止客户端指定任意 id 覆盖他人数据。
    """
    total_chars = sum(len(m.content or "") for m in req.messages)
    if total_chars > MAX_TOTAL_CHARS:
        raise HTTPException(status_code=413, detail=f"对话内容过长（上限 {MAX_TOTAL_CHARS} 字符）。")

    try:
        db.save_conversation(
            conv_id=req.conv_id,
            user_id=req.user_id,
            persona_id=req.persona_id,
            gf_name=req.gf_name,
            title=req.title,
            messages=[m.model_dump() for m in req.messages],
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/api/conversations")
async def list_conversations(user_id: int, gf_name: str | None = None, persona_id: str | None = None):
    """加载用户的对话列表，可按女友名字和性格过滤。"""
    convs = db.load_conversations(user_id, gf_name, persona_id)
    return {"conversations": convs}


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(
    conv_id: str,
    user_id: int | None = Query(default=None, description="用户 ID，传入时会校验对话归属"),
):
    """删除一段对话。

    传入 ``user_id`` 时只会删除该用户名下的对话，避免仅凭 conv_id 就能删除他人数据；
    不传则保持兼容（按 id 删除）。
    """
    deleted = db.delete_conversation(conv_id, user_id)
    if user_id is not None and not deleted:
        # 传入归属信息但仍未删除，说明 id 不存在或不属于该用户，统一按无权限处理
        raise HTTPException(status_code=404, detail="对话不存在或无权删除。")
    return {"ok": True, "deleted": deleted}


async def _event_stream(req: ChatRequest):
    """SSE 事件生成器：逐 token 转发上游模型的流式输出。

    所有异常都在生成器内部转换成一条 ``error`` 事件下发，避免响应已开始后再抛异常
    导致连接直接断开、前端停在「正在输入」状态。
    """
    try:
        client = get_client()
        messages = prepare_messages(req)

        stream = await client.chat.completions.create(
            model=req.model or DEEPSEEK_MODEL,
            messages=messages,
            temperature=req.temperature if req.temperature is not None else 0.7,
            max_tokens=req.max_tokens if req.max_tokens is not None else 2048,
            stream=True,
            stream_options={"include_usage": True},
        )

        usage = None
        async for chunk in stream:
            if not chunk.choices:
                # 最后一帧可能只带 usage 统计
                if chunk.usage:
                    usage = chunk.usage.model_dump()
                continue
            delta = chunk.choices[0].delta
            piece: dict = {}
            content = _read_delta_field(delta, "content")
            if content:
                piece["delta"] = content
            reasoning = _read_delta_field(delta, "reasoning_content")
            if reasoning:
                piece["reasoning"] = reasoning
            if piece:
                yield sse_payload(piece)

        yield sse_payload({"done": True, "usage": usage or {}})

    except Exception as exc:  # noqa: BLE001 — 任何异常都要通过 SSE 回传给前端
        log.exception("流式对话失败：%s", exc)
        yield sse_payload({"error": f"调用 DeepSeek 接口失败：{exc}"})


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """对话接口：默认返回 SSE 流，``stream=false`` 时返回完整 JSON。

    Raises:
        HTTPException: 400 消息为空或超出长度上限；502 上游调用失败（非流式）。
    """
    if not req.messages or not req.messages[-1].content.strip():
        raise HTTPException(status_code=400, detail="消息内容不能为空。")

    total_chars = sum(len(m.content or "") for m in req.messages)
    if total_chars > MAX_TOTAL_CHARS:
        # 超长历史既会拖慢响应，也可能超出模型上下文，提前拦截并给出明确提示
        raise HTTPException(status_code=413, detail=f"对话内容过长（上限 {MAX_TOTAL_CHARS} 字符）。")

    # 兼容非流式调用：直接返回完整 JSON
    if not req.stream:
        try:
            client = get_client()
            resp = await client.chat.completions.create(
                model=req.model or DEEPSEEK_MODEL,
                messages=prepare_messages(req),
                temperature=req.temperature if req.temperature is not None else 0.7,
                max_tokens=req.max_tokens if req.max_tokens is not None else 2048,
                stream=False,
            )
            return {
                "role": "assistant",
                "content": resp.choices[0].message.content or "",
                "usage": resp.usage.model_dump() if resp.usage else {},
            }
        except HTTPException:
            # 未配置 Key 等配置类错误原样抛出，不做二次包装
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("非流式对话失败：%s", exc)
            raise HTTPException(status_code=502, detail=f"调用 DeepSeek 接口失败：{exc}") from exc

    # 流式调用：返回 SSE
    return StreamingResponse(
        _event_stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
