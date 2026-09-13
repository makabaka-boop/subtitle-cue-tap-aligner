# 字幕对点台（Subtitle Cue-Point Station）

供剧场字幕操作员联排使用的全栈对点台：导入“字幕文本|整数毫秒”计划时间表，
联排时用浏览器单调时钟记录每次敲击相对首击的毫秒数，提交 FastAPI 后按统一
规则完成计划与敲击的配对，页面逐行展示已配对条目（含原始时间与带符号偏差）
及全部未配对计划、敲击。

## 配对规则（服务端唯一裁决）

1. 敲击按时间升序处理（时间相同按提交顺序）；
2. 每条计划与每次敲击至多使用一次；
3. 仅考虑绝对偏差不超过 **800 ms** 的计划；
4. 选择绝对偏差最小者；若相同，选择计划时间较早者。

偏差 `deviation = 敲击时间 − 计划时间`，带符号显示（如 `-120 ms`、`+40 ms`）。
除此之外没有第二个阈值，也没有合格/不合格分类。

## 导入校验

- 每行必须为 `字幕文本|整数毫秒`；字幕不得为空，时间不得为负；
- 各行时间必须严格递增、不得重复；
- 错误定位到具体行号（一行可有多个错误）；
- 非法导入**不会覆盖**上一份已成功导入的计划（客户端先即时校验，服务端
  `/api/parse` 为最终权威，通过后才提交到页面状态）。
- 时间为任意精度整数：前端用 BigInt 解析、比较并显示，传输层
  （`src/jsonBigint.ts`）保证超过 `Number.MAX_SAFE_INTEGER` 的相邻大整数
  不被双精度舍入为重复值（Python 端 int 本为任意精度）。

## 技术栈

Python 3.12 · FastAPI · Pydantic v2 · TypeScript · React 18 · Vite 5
测试：pytest（解析/配对/API）、Vitest（TS 解析与格式化）、Playwright（页面联调）。
配对算法在 `backend/tests/test_matcher.py` 中还与一份独立的“显然正确”参考
实现做了 300 组随机对拍，结果不写死。

## Docker Compose 启动

```bash
docker compose up --build
# Web:  http://localhost:${WEB_PORT:-8080}
# API:  http://localhost:${API_PORT:-8000}/api/health
WEB_PORT=9001 API_PORT=9000 docker compose up --build
```

## 一次性验收服务 verify

```bash
docker compose --profile verify run --rm verify
```

它会等待 web/api 健康后依次执行：pytest → 经 nginx 的线上 HTTP 冒烟检查 →
npm 类型检查/Vitest/生产构建 → Playwright（Chromium，指向 compose 中的 web），
全部通过输出 `ALL ACCEPTANCE CHECKS PASSED`，任一失败即以非零码退出。

## 本地开发

```bash
# 后端
cd backend
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000

# 前端（dev server 把 /api 代理到 localhost:8000）
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run test         # Vitest
npm run test:e2e     # Playwright（需另起后端）
```

## 目录

```
backend/    FastAPI 应用（app/parser.py、app/matcher.py、app/main.py）+ pytest
frontend/   React/Vite 应用（src/）、Vitest、Playwright（e2e/）
verify/     一次性验收镜像（pytest + 冒烟 + Vitest + Playwright）
docker-compose.yml
```
