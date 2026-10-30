# VFX Guru ComfyUI Service

Separate FastAPI service for discovering trusted ComfyUI API-format workflows, extracting their scalar inputs, accepting media assets, and running/tracking jobs through Comfy-Org's official `comfy-sdk`.

## State and storage

SQLite is used because this is a single-machine service. It stores one ordinary ComfyUI URL and the internal API v2 URL used by the SDK, uploaded asset records, and durable run records including the Comfy job ID, status, progress, and output metadata. Each new registration replaces the previous ComfyUI URL. When that URL is a normal ComfyUI server, the service starts the official `comfy-api-proxy` bound to loopback, preferring port 8189 and selecting another free port if needed. If the submitted URL already serves API v2, the service uses it directly. The managed proxy is restored when the service starts and stopped when the URL is cleared or the service exits. The SDK base URL is snapshotted on each run so changing the configured instance does not silently retarget an already-created run. On restart, active runs are marked `interrupted`; they are never silently re-submitted. Workflow JSON stays in `workflows/` (or `COMFY_WORKFLOWS_DIR`) and generated/uploaded bytes stay under `COMFY_SERVICE_DATA_DIR`.

No Postgres/Redis is needed for one local renderer. Move to a shared database and object storage only if this becomes a multi-user, remote, or horizontally scaled service.

## Comfy URL

`PUT /v1/comfy/instance` expects the **ordinary ComfyUI base URL**, for example `http://127.0.0.1:8188` or `http://gpu-host:3000`. The service checks for an existing API v2 health endpoint first. Otherwise it checks ComfyUI's native `/queue` endpoint and starts `comfy-api-proxy --comfyui <submitted-url>` locally; the SDK then talks to that proxy. Users do not need to install or configure the proxy separately. The proxy binds to loopback and uses port 8189 when available. `COMFY_API_KEY` stays in the service environment and credentials must not be embedded in the ComfyUI URL.

## Workflows

Place trusted API-format workflow JSON files under `workflows/`; nested folders are supported and become part of the workflow ID. The service discovers each node's scalar inputs, omits linked inputs, and reports node IDs, input keys, defaults, types, and Graviton media-loader slots. Optional adjacent metadata files named `<workflow>.meta.json` may contain `title`, `description`, `tags`, and `version`.

The extraction follows Graviton's `TemplateManager._extract_parameters` pattern. It does not return raw workflow graphs. All discovered scalar fields are currently overridable; only use trusted graphs, and curate/lock internal controls before exposing this service to untrusted callers or a model. `GET /v1/comfy/status` checks connectivity and `GET /v1/workflows?q=...` searches the host catalog.

## API

- `GET /health`
- `GET /v1/comfy/instance`, `PUT /v1/comfy/instance` (body `{ "url": "http://127.0.0.1:8188" }`), `DELETE /v1/comfy/instance`
- `GET /v1/comfy/status`
- `GET /v1/workflows?q=...`, `GET /v1/workflows/{workflow_id}`
- `POST /v1/assets` (multipart field `file`), `GET /v1/assets/{asset_id}`
- `POST /mcp/` (Streamable HTTP MCP with curated workflow tools)
- `POST /v1/runs` with `{ "workflow_id": "...", "parameters": {"node.input": value}, "asset_inputs": {"node.asset_ref": "asset-id"} }`
- `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/events` (SSE), `POST /v1/runs/{run_id}:cancel`
- `GET /v1/runs/{run_id}/outputs/{filename}`

When `COMFY_SERVICE_TOKEN` is set, send it in `X-Service-Token`. Keep it on the VFX Guru server and proxy browser calls through the app server. The service binds to loopback by default.

VFX Guru connects to `/mcp/` from its server-side chat route using the official MCP client. Only `search_workflows`, `get_workflow`, `get_comfy_status`, `run_workflow`, `get_run_status`, and `cancel_run` are exposed to the model. Instance registration and arbitrary REST endpoints are not MCP tools. Set matching `COMFY_SERVICE_URL` and `COMFY_SERVICE_TOKEN` values in the VFX Guru server environment; configure the token in both services if authentication is enabled. The chat route uploads only explicitly mentioned local media when a workflow run needs it, and translates `@mention` references into service asset IDs.

In the VFX Guru UI, open **Settings → ComfyUI** and enter the normal ComfyUI URL. The web app sends it to this service; the service manages the API proxy and SDK connection. `COMFY_SERVICE_TOKEN` remains server-side and is not sent to the browser.

## Run

```powershell
cd comfy_service
uv sync
Copy-Item .env.example .env
# Edit .env to set COMFY_WORKFLOWS_DIR, COMFY_SERVICE_TOKEN, and optional COMFY_API_KEY.
uv run uvicorn app.main:app --host 127.0.0.1 --port 8012 --env-file .env
```

The default workflow directory is `comfy_service/workflows`; it can be pointed at Graviton's `registry_templates/workflows` directory to reuse those graphs.
