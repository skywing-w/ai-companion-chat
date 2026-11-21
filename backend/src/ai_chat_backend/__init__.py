"""AI 对话机器人后端。"""

from .main import app

__all__ = ["app"]


def main() -> None:
    """`uv run ai-chat-backend` 启动入口。"""
    import uvicorn

    from .main import PORT

    uvicorn.run(app, host="0.0.0.0", port=PORT)
