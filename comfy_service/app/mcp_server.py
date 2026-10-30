from __future__ import annotations

import hmac
import json
import asyncio
import time
from typing import Any

from starlette.types import ASGIApp, Receive, Scope, Send
from mcp.server.mcpserver import MCPServer

from .catalog import CatalogError, WorkflowCatalog
from .config import service_token
from .runtime import RunManager
from .store import Store


class ServiceTokenGuard:
    """Protect the MCP route with the same optional service token as REST."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        expected = service_token()
        if scope["type"] == "http" and expected:
            headers = {key.lower(): value for key, value in scope.get("headers", [])}
            supplied = headers.get(b"x-service-token", b"").decode("latin1")
            authorization = headers.get(b"authorization", b"").decode("latin1")
            if not supplied and authorization.lower().startswith("bearer "):
                supplied = authorization[7:]
            if not supplied or not hmac.compare_digest(supplied, expected):
                body = b'{"detail":"Service authentication failed."}'
                await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


def create_mcp_server(store: Store, catalog: WorkflowCatalog, runs: RunManager):
    server = MCPServer(
        name="vfxguru-comfyui",
        version="0.1.0",
        instructions="Discover and run approved workflows from the configured local ComfyUI service. Workflow IDs refer only to files in the configured workflow catalog. Never expose credentials or internal filesystem paths.",
    )

    @server.tool(description="Search the configured workflow catalog by name, description, tags, or parameter key.")
    def search_workflows(query: str = "") -> str:
        return json.dumps({"workflows": catalog.list_workflows(query)[:100]}, ensure_ascii=False)

    @server.tool(description="Get a workflow's overridable parameters and media input keys before preparing a run.")
    def get_workflow(workflow_id: str) -> str:
        try:
            return json.dumps(catalog.get_workflow(workflow_id), ensure_ascii=False)
        except CatalogError as error:
            return json.dumps({"error": str(error)})

    @server.tool(description="Check whether a ComfyUI instance is configured and reachable.")
    async def get_comfy_status() -> str:
        instance = store.instance()
        if not instance:
            return json.dumps({"connected": False, "configured": False, "detail": "Register a Comfy API v2 URL first."})
        import httpx
        from .config import comfy_api_key
        headers = {"Authorization": f"Bearer {comfy_api_key()}"} if comfy_api_key() else {}
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{instance['base_url']}/api/v2/jobs?limit=1", headers=headers)
                response.raise_for_status()
            return json.dumps({"connected": True, "configured": True})
        except Exception as error:
            return json.dumps({"connected": False, "configured": True, "detail": f"Comfy API v2 did not respond ({type(error).__name__})."})

    @server.tool(description="Submit a workflow to the configured ComfyUI instance. Use only when the user explicitly asks to run or generate. parameters maps workflow input keys such as '12.steps' to values; asset_inputs maps media input keys to uploaded service asset IDs. After submission, call get_run_status. If it fails, report the error and error_details to the user in plain language.")
    async def run_workflow(workflow_id: str, parameters: dict[str, Any] | None = None, asset_inputs: dict[str, str] | None = None) -> str:
        try:
            run = runs.create(workflow_id, parameters or {}, asset_inputs or {})
            return json.dumps({"job_id": run["id"], "status": run["status"], "workflow_id": workflow_id, "message": run["message"]})
        except (CatalogError, RuntimeError, ValueError) as error:
            return json.dumps({"error": str(error)})

    @server.tool(description="Read the status, progress, outputs, error, and structured ComfyUI validation details for a submitted run. Always surface a failure's error and error_details to the user and explain actionable fixes.")
    def get_run_status(job_id: str) -> str:
        run = store.get_run(job_id)
        return json.dumps(run or {"error": "Run not found."}, ensure_ascii=False)

    @server.tool(description="Find recent ComfyUI runs, including completed run IDs and output filenames. Use this to recover outputs from a previous render that did not appear in the chat media library.")
    def list_recent_runs(limit: int = 20) -> str:
        return json.dumps({"runs": store.list_runs(limit)}, ensure_ascii=False)

    @server.tool(description="Import all outputs from a completed ComfyUI run into the current chat's media library. Use the run ID from list_recent_runs or a run status result when the rendered files are missing from the library.")
    def import_run_outputs(run_id: str) -> str:
        run = store.get_run(run_id)
        if not run:
            return json.dumps({"error": "Run not found."})
        if run.get("status") != "completed":
            return json.dumps({"error": f"Run is {run.get('status')}; only completed runs have importable outputs.", "run": run}, ensure_ascii=False)
        return json.dumps({"run": run, "outputs": run.get("outputs", [])}, ensure_ascii=False)

    @server.tool(description="Wait briefly for a ComfyUI run to make progress or finish. Prefer this after run_workflow instead of repeatedly calling get_run_status. Waits at most 20 seconds and returns the latest run status, progress, and outputs/errors.")
    async def wait_for_run(job_id: str, wait_seconds: int = 8) -> str:
        wait_seconds = max(1, min(20, int(wait_seconds)))
        started = time.monotonic()
        deadline = started + wait_seconds
        run = store.get_run(job_id)
        while run and run.get("status") in {"queued", "running", "cancel_requested"} and time.monotonic() < deadline:
            await asyncio.sleep(min(0.5, max(0.0, deadline - time.monotonic())))
            run = store.get_run(job_id)
        return json.dumps({"run": run, "waited_seconds": round(time.monotonic() - started, 1), "timed_out": bool(run and run.get("status") in {"queued", "running", "cancel_requested"})}, ensure_ascii=False)

    @server.tool(description="Cancel an active ComfyUI run when the user asks to stop it.")
    async def cancel_run(job_id: str) -> str:
        try:
            accepted = await runs.cancel(job_id)
            run = store.get_run(job_id)
            return json.dumps({"accepted": accepted, "run": run})
        except Exception as error:
            return json.dumps({"error": f"Cancellation failed ({type(error).__name__})."})

    mcp_app = ServiceTokenGuard(server.streamable_http_app(streamable_http_path="/"))
    return server, mcp_app
