# ai-chat-backend

AI 陪伴对话的后端服务（FastAPI + SQLite + DeepSeek）。

- `main.py` — 应用入口：人设管理、SSE 流式转发、账号与对话接口
- `db.py` — 数据访问层：用户、对话、消息三张表

## 运行

```bash
uv sync
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
uv run ai-chat-backend # http://127.0.0.1:8000/docs
```

完整说明（前端启动方式、接口清单、目录结构）见项目根目录 `README.md`。
