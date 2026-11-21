@echo off
chcp 65001 >nul
title 星辰 AI · 后端服务
cd /d "%~dp0backend"
echo ============================================
echo   星辰 AI 后端服务正在启动...
echo   接口文档: http://127.0.0.1:8000/docs
echo   按 Ctrl+C 停止
echo ============================================
uv run uvicorn ai_chat_backend.main:app --host 127.0.0.1 --port 8000 --reload
pause
