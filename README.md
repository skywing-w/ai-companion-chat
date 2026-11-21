# AI 陪伴对话应用

一个前后端分离的 AI 陪伴对话应用：选择女友性格、起个名字，即可开始聊天。支持 **SSE 流式输出**、多会话管理、Markdown 渲染、账号注册登录与云端对话同步。

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript + axios（无构建工具，纯静态） |
| 后端 | Python + uv + **FastAPI** |
| 数据库 | SQLite（用户、对话、消息三张表，WAL 模式） |
| 大模型 | DeepSeek（`deepseek-chat` / `deepseek-reasoner`），OpenAI 兼容协议 |

## 功能

- **五种人设**：温柔 / 暴躁 / 犀利 / 甜美 / 高冷，每种对应独立人设提示词与主题色
- **流式对话**：SSE 逐 token 渲染，支持中途停止生成
- **多会话**：新建、切换、删除对话，标题自动生成，本地 + 云端双向保存
- **账号体系**：注册 / 登录，密码 PBKDF2 加盐哈希存储
- **云端同步**：登录后对话自动同步到 SQLite，换设备也能接着聊

## 目录结构

```
companion-chat
├── frontend/                  # 前端（浏览器直接打开 index.html）
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js              # 交互逻辑、SSE 解析、云端同步
│   └── assets/                # 头像、卡片与背景图
├── backend/                   # 后端（uv 管理）
│   ├── src/ai_chat_backend/
│   │   ├── main.py            # FastAPI 应用：路由、人设、SSE 转发
│   │   ├── db.py              # 数据访问层：用户、对话、消息
│   │   └── __init__.py
│   ├── .env.example
│   └── pyproject.toml
├── start-backend.bat
```

## 快速开始

### 1. 启动后端

```bash
cd backend
uv sync                       # 安装依赖
cp .env.example .env          # 填入 DEEPSEEK_API_KEY
uv run ai-chat-backend        # 默认监听 0.0.0.0:8000
```

`.env` 配置项：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
CORS_ORIGINS=*                # 生产环境改为前端域名
PORT=8000
LLM_TIMEOUT=60                # 上游请求超时（秒）
```

### 2. 打开前端

直接用浏览器打开 `frontend/index.html`。首次进入先选性格、起名字，然后注册/登录账号即可开始聊天。

若后端不在本机 8000 端口，在 `index.html` 的 `<script>` 前加一行覆盖即可：

```html
<script>window.__API_BASE__ = 'https://your-domain.com';</script>
```

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（含 Key 是否已配置） |
| GET | `/api/personas` | 人设列表（不含完整提示词） |
| POST | `/api/chat` | 对话，默认 SSE 流式；`stream=false` 返回完整 JSON |
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录 |
| POST | `/api/conversations/save` | 保存 / 覆盖一段对话及消息 |
| GET | `/api/conversations?user_id=` | 加载对话列表，可按 `gf_name`、`persona_id` 过滤 |
| DELETE | `/api/conversations/{conv_id}?user_id=` | 删除对话（带 `user_id` 时校验归属） |

SSE 事件格式：`data: {"delta": "..."}` / `data: {"reasoning": "..."}` / `data: {"done": true, "usage": {...}}` / `data: {"error": "..."}`。
接口文档：启动后访问 `http://127.0.0.1:8000/docs`。

## 说明

本项目为个人项目，人设与对话内容由大模型生成，仅用于演示流式对话与多轮记忆的实现方式。
