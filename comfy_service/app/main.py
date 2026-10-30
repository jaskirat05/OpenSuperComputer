from __future__ import annotations

import asyncio
import hmac
import json
import re
from uuid import uuid4
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .catalog import CatalogError, WorkflowCatalog
from .config import allowed_origins, comfy_api_key, service_token, workflows_dir
from .runtime import RunManager
from .store import Store
from .mcp_server import create_mcp_server
from .proxy import ComfyProxyManager, ProxyError


store = Store()
catalog = WorkflowCatalog()
run_manager = RunManager(store, catalog)
proxy_manager = ComfyProxyManager(store)
mcp_server, mcp_app = create_mcp_server(store, catalog, run_manager)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    workflows_dir().mkdir(parents=True, exist_ok=True)
    store.mark_interrupted()
    try:
        await proxy_manager.restore()
    except Exception:
        # Keep the REST/MCP service available so the user can correct the URL.
        import logging
        logging.getLogger(__name__).exception("Could not restore the configured Comfy connection")
    try:
        async with mcp_server.session_manager.run():
            yield
    finally:
        await proxy_manager.close()


app = FastAPI(title="VFX Guru ComfyUI Service", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Service-Token"],
)


def require_service_token(x_service_token: str | None = Header(default=None)) -> None:
    expected = service_token()
    if expected and (not x_service_token or not hmac.compare_digest(x_service_token, expected)):
        raise HTTPException(status_code=401, detail="Service authentication failed.")


class InstanceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=8, max_length=2048)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parts = urlsplit(value.strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("URL must be an absolute HTTP or HTTPS ComfyUI URL.")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("URL cannot include credentials, query parameters, or a fragment.")
        return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workflow_id: str = Field(min_length=1, max_length=240)
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=200)
    asset_inputs: dict[str, str] = Field(default_factory=dict, max_length=40)


@app.get("/health")
async def health() -> dict:
    instance = store.instance()
    return {"status": "ok", "service": "vfxguru-comfy-service", "comfy_configured": instance is not None}


@app.get("/v1/comfy/instance", dependencies=[Depends(require_service_token)])
async def get_comfy_instance() -> dict:
    instance = store.instance()
    return {"configured": instance is not None, "instance": instance}


@app.put("/v1/comfy/instance", dependencies=[Depends(require_service_token)])
async def register_comfy_instance(request: InstanceRegistration) -> dict:
    previous = store.instance()
    try:
        connection = await proxy_manager.configure(request.url)
    except ProxyError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    instance = store.replace_instance(connection["comfy_url"], connection["base_url"], connection["managed_proxy"])
    return {"configured": True, "replaced": previous is not None, "instance": instance}


@app.delete("/v1/comfy/instance", dependencies=[Depends(require_service_token)])
async def clear_comfy_instance() -> dict:
    await proxy_manager.stop()
    return {"removed": store.clear_instance(), "configured": False}


@app.get("/v1/comfy/status", dependencies=[Depends(require_service_token)])
async def comfy_status() -> dict:
    instance = store.instance()
    if not instance:
        return {"connected": False, "configured": False, "detail": "Register a Comfy API v2 URL first."}
    headers = {"Authorization": f"Bearer {comfy_api_key()}"} if comfy_api_key() else {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{instance['base_url']}/api/v2/jobs?limit=1", headers=headers)
            response.raise_for_status()
        return {"connected": True, "configured": True, "url": instance["comfy_url"], "managed_proxy": instance["managed_proxy"]}
    except Exception as error:
        return {"connected": False, "configured": True, "url": instance["comfy_url"], "managed_proxy": instance["managed_proxy"], "detail": f"Comfy API v2 did not respond ({type(error).__name__})."}


@app.get("/v1/workflows", dependencies=[Depends(require_service_token)])
async def list_workflows(q: str = "") -> dict:
    return {"items": catalog.list_workflows(q)}


@app.get("/v1/workflows/{workflow_id:path}", dependencies=[Depends(require_service_token)])
async def get_workflow(workflow_id: str) -> dict:
    try:
        return catalog.get_workflow(workflow_id)
    except CatalogError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/v1/assets", status_code=201, dependencies=[Depends(require_service_token)])
async def upload_asset(file: UploadFile = File(...)) -> dict:
    name = Path(file.filename or "upload.bin").name
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="A filename is required.")
    content_type = file.content_type or "application/octet-stream"
    allowed_prefixes = ("image/", "video/", "audio/", "model/")
    if not content_type.startswith(allowed_prefixes) and content_type != "application/octet-stream":
        raise HTTPException(status_code=415, detail="Upload an image, video, audio, or model asset.")
    stored_name = f"{uuid4().hex}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)[:120]}"
    destination = store.assets_dir / stored_name
    size = 0
    max_bytes = 2 * 1024 * 1024 * 1024
    try:
        with destination.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(status_code=413, detail="Asset exceeds the 2 GB upload limit.")
                output.write(chunk)
        if size == 0:
            destination.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="The uploaded asset is empty.")
        asset = store.save_asset(name[:240], content_type, size, stored_name)
        asset.pop("stored_name", None)
        return asset
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@app.post("/v1/runs", status_code=202, dependencies=[Depends(require_service_token)])
async def create_run(request: RunRequest) -> dict:
    try:
        run = run_manager.create(request.workflow_id, request.parameters, request.asset_inputs)
    except CatalogError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"job_id": run["id"], "status": run["status"], "run": run}


@app.get("/v1/runs/{run_id}", dependencies=[Depends(require_service_token)])
async def get_run(run_id: str) -> dict:
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return {"run": run, "result": {"outputs": run["outputs"]} if run["status"] == "completed" else None}


@app.get("/v1/runs/{run_id}/events", dependencies=[Depends(require_service_token)])
async def run_events(run_id: str) -> StreamingResponse:
    if store.get_run(run_id) is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    async def event_stream():
        previous = None
        while True:
            run = store.get_run(run_id)
            if run is None:
                break
            payload = json.dumps(run, ensure_ascii=False)
            if payload != previous:
                yield f"event: run\ndata: {payload}\n\n"
                previous = payload
            if run["status"] in {"completed", "failed", "cancelled", "interrupted"}:
                break
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/v1/runs/{run_id}:cancel", dependencies=[Depends(require_service_token)])
async def cancel_run(run_id: str) -> dict:
    try:
        accepted = await run_manager.cancel(run_id)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"ComfyUI cancellation failed: {type(error).__name__}") from error
    if not accepted:
        if store.get_run(run_id) is None:
            raise HTTPException(status_code=404, detail="Run not found.")
        raise HTTPException(status_code=409, detail="Run is already complete or cannot be cancelled.")
    return {"accepted": True, "run": store.get_run(run_id)}


@app.get("/v1/runs/{run_id}/outputs/{filename}", dependencies=[Depends(require_service_token)])
async def get_output(run_id: str, filename: str) -> FileResponse:
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    output = next((item for item in run["outputs"] if item["name"] == filename), None)
    if output is None:
        raise HTTPException(status_code=404, detail="Output not found.")
    output_path = (store.outputs_dir / run_id / filename).resolve()
    output_root = (store.outputs_dir / run_id).resolve()
    if output_root not in output_path.parents or not output_path.is_file():
        raise HTTPException(status_code=404, detail="Output not found.")
    return FileResponse(output_path, media_type=output.get("content_type") or "application/octet-stream", filename=filename)


@app.get("/v1/assets/{asset_id}", dependencies=[Depends(require_service_token)])
async def get_asset(asset_id: str) -> FileResponse:
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found.")
    path = (store.assets_dir / asset["stored_name"]).resolve()
    if store.assets_dir.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found.")
    return FileResponse(path, media_type=asset["content_type"], filename=asset["filename"])


app.mount("/mcp", mcp_app)
