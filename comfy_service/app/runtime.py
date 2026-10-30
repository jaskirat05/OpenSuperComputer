from __future__ import annotations

import asyncio
import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from comfy_sdk import AsyncComfy, Progress, StatusChange

from .catalog import WorkflowCatalog, validate_parameter
from .config import comfy_api_key
from .store import Store


_SDK_ENV_LOCK = threading.RLock()
_TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


def make_client(base_url: str) -> AsyncComfy:
    """The official SDK reads COMFY_BASE_URL on construction, so scope the env change."""
    with _SDK_ENV_LOCK:
        previous_url = os.environ.get("COMFY_BASE_URL")
        previous_key = os.environ.get("COMFY_API_KEY")
        os.environ["COMFY_BASE_URL"] = base_url
        key = comfy_api_key()
        os.environ.pop("COMFY_API_KEY", None)
        try:
            return AsyncComfy(api_key=key, timeout=60, client_info="vfxguru-comfy-service")
        finally:
            if previous_url is None:
                os.environ.pop("COMFY_BASE_URL", None)
            else:
                os.environ["COMFY_BASE_URL"] = previous_url
            if previous_key is None:
                os.environ.pop("COMFY_API_KEY", None)
            else:
                os.environ["COMFY_API_KEY"] = previous_key


def _safe_filename(value: str, fallback: str) -> str:
    name = Path(value).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:160]
    return name or fallback


def _set_graph_input(graph: dict[str, Any], key: str, value: Any) -> tuple[str, str]:
    node_id, input_key = key.split(".", 1)
    node = graph.get(node_id)
    if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict) or input_key not in node["inputs"]:
        raise ValueError(f"Parameter binding is no longer valid: {key}")
    node["inputs"][input_key] = value
    return node_id, input_key


def _adapt_media_input(graph: dict[str, Any], param: dict[str, Any], asset: Any) -> None:
    node_id = param["node_id"]
    input_key = param["input_key"]
    node = graph.get(node_id)
    if not isinstance(node, dict):
        raise ValueError(f"Media input node is missing: {node_id}")
    io_type = param.get("io_type")
    if param["category"] == "bridge_input":
        native_types = {"image": "LoadImage", "video": "LoadVideo", "audio": "LoadAudio", "text": "LoadText", "file": "LoadImage", "3d": "Load3D"}
        native_input = {"image": "image", "video": "video", "audio": "audio", "text": "text", "file": "file", "3d": "file"}[io_type]
        node["class_type"] = native_types[io_type]
        node["inputs"] = {native_input: asset}
    else:
        node.setdefault("inputs", {})[input_key] = asset


def _adapt_bridge_output_nodes(graph: dict[str, Any]) -> None:
    """Convert Graviton's storage bridge nodes to Comfy's native output nodes."""
    for node in graph.values():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        inputs = node["inputs"]
        if node.get("class_type") == "GravitonSaveImage":
            node["class_type"] = "SaveImage"
            node["inputs"] = {
                "images": inputs.get("image"),
                "filename_prefix": Path(str(inputs.get("filename", "vfxguru_image.png"))).stem,
            }
        elif node.get("class_type") == "GravitonSaveVideo":
            node["class_type"] = "SaveVideo"
            node["inputs"] = {
                "video": inputs.get("video"),
                "filename_prefix": inputs.get("filename_prefix", "vfxguru/video"),
                "format": inputs.get("format", "auto"),
                "codec": inputs.get("codec", "auto"),
            }


class RunManager:
    def __init__(self, store: Store, catalog: WorkflowCatalog) -> None:
        self.store = store
        self.catalog = catalog
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.jobs: dict[str, Any] = {}

    def create(self, workflow_id: str, parameters: dict[str, Any], asset_inputs: dict[str, str]) -> dict[str, Any]:
        instance = self.store.instance()
        if not instance:
            raise RuntimeError("Register a Comfy API v2 endpoint first.")
        graph, params = self.catalog.load_graph(workflow_id)
        by_key = {param["key"]: param for param in params}
        unknown = set(parameters) - set(by_key)
        unknown_assets = set(asset_inputs) - set(by_key)
        if unknown or unknown_assets:
            keys = sorted(unknown | unknown_assets)
            raise ValueError(f"Unknown workflow input(s): {', '.join(keys)}")
        for key, value in parameters.items():
            if key in asset_inputs:
                raise ValueError(f"Input cannot be both a value and an asset: {key}")
            validate_parameter(by_key[key], value)
        for key, asset_id in asset_inputs.items():
            if by_key[key]["category"] not in {"bridge_input", "media_input"}:
                raise ValueError(f"Input is not recognized as a media slot: {key}")
            if not self.store.get_asset(asset_id):
                raise ValueError(f"Unknown uploaded asset: {asset_id}")
        run = self.store.create_run(workflow_id, instance["base_url"], parameters, asset_inputs)
        self.tasks[run["id"]] = asyncio.create_task(self._execute(run["id"], graph, by_key, parameters, asset_inputs))
        return run

    async def _execute(self, run_id: str, graph: dict[str, Any], by_key: dict[str, dict[str, Any]], parameters: dict[str, Any], asset_inputs: dict[str, str]) -> None:
        internal = self.store.get_run_internal(run_id)
        if not internal:
            return
        client = make_client(internal["base_url"])
        active_job = None
        try:
            self.store.update_run(run_id, status="running", message="Submitting workflow to ComfyUI.")
            async with client:
                workflow = client.workflows.from_json(graph)
                for key, value in parameters.items():
                    node_id, input_key = _set_graph_input(graph, key, value)
                    workflow.set_input(node_id, input_key, value)
                for key, asset_id in asset_inputs.items():
                    asset_row = self.store.get_asset(asset_id)
                    if not asset_row:
                        raise ValueError(f"Uploaded asset no longer exists: {asset_id}")
                    asset_path = self.store.assets_dir / asset_row["stored_name"]
                    asset = client.assets.from_file(str(asset_path))
                    param = by_key[key]
                    _adapt_media_input(graph, param, asset)
                    # from_json wraps the graph object, and set_input is the SDK's documented input path.
                    node = graph[param["node_id"]]
                    input_name = "image" if param["category"] == "bridge_input" else param["input_key"]
                    workflow.set_input(param["node_id"], input_name, asset)
                _adapt_bridge_output_nodes(graph)
                active_job = await client.submit(workflow)
                self.jobs[run_id] = active_job
                self.store.update_run(run_id, comfy_job_id=active_job.id, status="running", message="ComfyUI is rendering.")
                try:
                    async for event in active_job.events():
                        if isinstance(event, Progress):
                            try:
                                progress = max(0.0, min(1.0, float(event.value or 0)))
                            except (TypeError, ValueError):
                                progress = 0.0
                            self.store.update_run(run_id, progress=progress, message=event.message or "ComfyUI is rendering.")
                        elif isinstance(event, StatusChange) and event.status in {"failed", "error", "cancelled", "canceled"}:
                            break
                except Exception:
                    # Event streams are for progress; job.result() remains authoritative.
                    pass
                await active_job.result()
                output_dir = self.store.outputs_dir / run_id
                output_dir.mkdir(parents=True, exist_ok=True)
                outputs = []
                for index, output in enumerate(active_job.outputs):
                    filename = f"{index + 1:03d}_{_safe_filename(output.name or f'output-{index + 1}', 'output.bin')}"
                    output_path = output_dir / filename
                    await output.to_file(str(output_path))
                    outputs.append({"name": filename, "type": output.type, "content_type": output.content_type, "size_bytes": output_path.stat().st_size, "url": f"/v1/runs/{run_id}/outputs/{filename}"})
                if not outputs:
                    raise RuntimeError("ComfyUI completed the job without any outputs.")
                self.store.update_run(run_id, status="completed", progress=1.0, message="Workflow completed.", outputs=outputs)
        except asyncio.CancelledError:
            if active_job is not None:
                try:
                    await active_job.cancel()
                except Exception:
                    pass
            self.store.update_run(run_id, status="cancelled", message="Run cancelled.")
            raise
        except Exception as error:
            details = getattr(error, "details", None)
            code = getattr(error, "code", None)
            http_status = getattr(error, "http_status", None)
            request_id = getattr(error, "request_id", None)
            structured = {
                key: value for key, value in {
                    "code": code,
                    "http_status": http_status,
                    "request_id": request_id,
                    "details": details,
                }.items() if value is not None
            }
            job_error = getattr(error, "error", None)
            if job_error is not None:
                structured["job_error"] = {
                    key: getattr(job_error, key)
                    for key in ("code", "node_id", "message", "traceback")
                    if getattr(job_error, key, None) is not None
                }
            try:
                detail_text = json.dumps(structured, ensure_ascii=False, default=str) if structured else ""
            except (TypeError, ValueError):
                detail_text = str(structured)
            self.store.update_run(
                run_id,
                status="failed",
                error=f"{type(error).__name__}: {str(error)[:800]}",
                error_details=structured or None,
                message="Workflow failed.",
            )
            if detail_text:
                print(f"Comfy workflow {run_id} failed: {detail_text[:4000]}", flush=True)
        finally:
            self.jobs.pop(run_id, None)
            self.tasks.pop(run_id, None)

    async def cancel(self, run_id: str) -> bool:
        run = self.store.get_run_internal(run_id)
        if not run:
            return False
        if run["status"] in _TERMINAL:
            return False
        job = self.jobs.get(run_id)
        if job is not None:
            await job.cancel()
            self.store.update_run(run_id, status="cancel_requested", message="Cancellation requested.")
            return True
        job_id = run.get("comfy_job_id")
        if not job_id:
            task = self.tasks.get(run_id)
            if task:
                task.cancel()
                return True
            return False
        client = make_client(run["base_url"])
        async with client:
            job = await client.jobs.get(job_id)
            await job.cancel()
        self.store.update_run(run_id, status="cancel_requested", message="Cancellation requested.")
        return True
