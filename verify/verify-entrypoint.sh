#!/usr/bin/env bash
# One-shot acceptance: backend unit tests, frontend unit tests, production
# build, live HTTP smoke test and Playwright page integration against the
# running web + api containers. Exits non-zero on the first failure.
set -euo pipefail

export HOME=/tmp/verify-home
mkdir -p "${HOME}"
export npm_config_cache="${HOME}/.npm"

WEB_URL="${PLAYWRIGHT_BASE_URL:-http://web:80}"
API_URL="${API_BASE_URL:-http://api:8000}"

echo "==> Waiting for api at ${API_URL}"
python - <<'PY'
import json, os, sys, time, urllib.request
deadline = time.time() + 60
url = os.environ.get("API_BASE_URL", "http://api:8000") + "/api/health"
while True:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            assert json.load(response)["status"] == "ok"
        break
    except Exception:
        if time.time() > deadline:
            sys.exit("api never became healthy")
        time.sleep(1)
PY

echo "==> Waiting for web at ${WEB_URL}"
python - <<'PY'
import os, sys, time, urllib.request
deadline = time.time() + 60
url = os.environ.get("PLAYWRIGHT_BASE_URL", "http://web:80") + "/"
while True:
    try:
        if urllib.request.urlopen(url, timeout=2).status == 200:
            break
    except Exception:
        pass
    if time.time() > deadline:
        sys.exit("web never became healthy")
    time.sleep(1)
PY

echo "==> pytest: parser, matcher, API"
(cd /workspace/backend && python -m pytest -q)

echo "==> HTTP smoke test against the live compose stack"
API_BASE_URL="${API_URL}" python /workspace/verify/smoke_check.py

echo "==> npm install"
(cd /workspace/frontend && npm install --no-audit --no-fund)

echo "==> TypeScript type check + Vitest + production build"
(cd /workspace/frontend && npm run typecheck && npm run test && npm run build)

echo "==> Playwright page integration against ${WEB_URL}"
(cd /workspace/frontend && npx playwright test)

echo "==> ALL ACCEPTANCE CHECKS PASSED"
