#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$ROOT/comfy_service"
WORKFLOWS_DIR="$ROOT/workflows"
SERVICE_ENV="$SERVICE_DIR/.env"
VENV_DIR="$SERVICE_DIR/.venv-launch"

for command in node npm uv; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

PYTHON_BIN=""
for candidate in python3.12 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
    PYTHON_BIN="$(command -v "$candidate")"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "Python 3.12+ is required for the ComfyUI MCP service." >&2; exit 1; }

if [ ! -f "$SERVICE_ENV" ]; then
  cp "$SERVICE_DIR/.env.example" "$SERVICE_ENV"
  echo "Created comfy_service/.env from its example. Add a service token there only if you also configure the same token for Next.js."
fi
if [ ! -d "$ROOT/node_modules/next" ]; then
  echo "Installing Next.js dependencies..."
  (cd "$ROOT" && npm ci)
fi

export COMFY_SERVICE_URL="http://127.0.0.1:8012"
export COMFY_WORKFLOWS_DIR="$WORKFLOWS_DIR"
export VFX_GURU_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
export UV_PROJECT_ENVIRONMENT="$VENV_DIR"
export NEXT_DIST_DIR=".next-open-supercomputer"
if [ -z "${COMFY_SERVICE_TOKEN:-}" ]; then
  export COMFY_SERVICE_TOKEN="$("$PYTHON_BIN" "$ROOT/scripts/read-env-value.py" "$SERVICE_ENV" COMFY_SERVICE_TOKEN)"
fi

echo "Syncing ComfyUI MCP dependencies using $PYTHON_BIN..."
if [ ! -x "$VENV_DIR/bin/python" ] || ! "$VENV_DIR/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1; then
  echo "Creating or repairing the ComfyUI Python environment..."
  uv venv --clear --python "$PYTHON_BIN" "$VENV_DIR"
fi
uv sync --project "$SERVICE_DIR" --frozen --python "$PYTHON_BIN"

cleanup() {
  if [ -n "${MCP_PID:-}" ] && kill -0 "$MCP_PID" 2>/dev/null; then
    kill "$MCP_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(
  cd "$SERVICE_DIR"
  exec "$VENV_DIR/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8012 --env-file .env
) &
MCP_PID=$!

ready=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if ! kill -0 "$MCP_PID" 2>/dev/null; then
    echo "ComfyUI MCP exited before becoming ready." >&2
    exit 1
  fi
  if "$PYTHON_BIN" -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=1).read()' "$COMFY_SERVICE_URL/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "ComfyUI MCP did not become healthy at $COMFY_SERVICE_URL/health within 60 seconds." >&2
  exit 1
fi

echo "ComfyUI MCP is ready at $COMFY_SERVICE_URL/mcp/"
echo "Starting Open SuperComputer at http://localhost:3000"
cd "$ROOT"
npm run dev -- --hostname 127.0.0.1 --port 3000
