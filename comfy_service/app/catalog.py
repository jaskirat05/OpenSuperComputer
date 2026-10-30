from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .config import workflows_dir


GRAVITON_LOAD_TYPES = {
    "GravitonLoadImage": "image",
    "GravitonLoadVideo": "video",
    "GravitonLoadText": "text",
    "GravitonLoadFile": "file",
    "GravitonLoadAudio": "audio",
    "GravitonLoad3D": "3d",
}
COMFY_MEDIA_INPUT_TYPES = {"LoadImage": {"image": "image"}, "LoadVideo": {"file": "video"}}


class CatalogError(Exception):
    pass


class WorkflowCatalog:
    """Read trusted ComfyUI API-format graphs from a host-owned directory."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or workflows_dir()).resolve()

    def _path(self, workflow_id: str) -> Path:
        if not workflow_id or "\\" in workflow_id or "\x00" in workflow_id:
            raise CatalogError("Invalid workflow ID.")
        path = (self.root / f"{workflow_id}.json").resolve()
        if self.root not in path.parents or not path.is_file():
            raise CatalogError(f"Workflow not found: {workflow_id}")
        return path

    @staticmethod
    def extract_parameters(graph: dict[str, Any]) -> list[dict[str, Any]]:
        params: list[dict[str, Any]] = []
        for node_id, node in graph.items():
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                continue
            node_class = str(node.get("class_type", "Unknown"))
            meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
            node_title = str(meta.get("title") or node_class)
            io_type = GRAVITON_LOAD_TYPES.get(node_class)
            for input_key, value in node["inputs"].items():
                # A list in API format is normally a connection to another node, not a user control.
                if isinstance(value, (list, dict)) or value is None:
                    continue
                standard_io_type = COMFY_MEDIA_INPUT_TYPES.get(node_class, {}).get(input_key)
                category = "bridge_input" if io_type and input_key == "asset_ref" else "media_input" if standard_io_type else "parameter"
                params.append({
                    "key": f"{node_id}.{input_key}", "node_id": str(node_id), "input_key": input_key,
                    "default_value": value, "type": "boolean" if isinstance(value, bool) else "integer" if isinstance(value, int) else "number" if isinstance(value, float) else "string" if isinstance(value, str) else "unsupported",
                    "node_class": node_class, "node_title": node_title, "description": "",
                    "category": category,
                    "io_type": io_type if category == "bridge_input" else standard_io_type if category == "media_input" else None,
                })
        return params

    def _read(self, workflow_id: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
        path = self._path(workflow_id)
        try:
            graph = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise CatalogError(f"Could not read workflow: {workflow_id}") from error
        if not isinstance(graph, dict) or not any(isinstance(value, dict) and "class_type" in value for value in graph.values()):
            raise CatalogError(f"Workflow is not a ComfyUI API-format graph: {workflow_id}")
        sidecar = path.with_name(f"{path.stem}.meta.json")
        try:
            metadata = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.is_file() else {}
        except (OSError, json.JSONDecodeError):
            metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}
        return graph, metadata, path

    def list_workflows(self, query: str = "") -> list[dict[str, Any]]:
        self.root.mkdir(parents=True, exist_ok=True)
        needle = query.casefold().strip()
        results = []
        for path in sorted(self.root.rglob("*.json")):
            if path.name.endswith(".meta.json"):
                continue
            workflow_id = path.relative_to(self.root).with_suffix("").as_posix()
            try:
                summary = self.get_workflow(workflow_id)
            except CatalogError:
                continue
            searchable = " ".join([summary["id"], summary["title"], summary["description"], *summary["tags"], *(param["key"] for param in summary["parameters"])]).casefold()
            if not needle or needle in searchable:
                results.append({key: value for key, value in summary.items() if key != "parameters"} | {"parameter_count": len(summary["parameters"])})
        return results

    def get_workflow(self, workflow_id: str) -> dict[str, Any]:
        graph, metadata, path = self._read(workflow_id)
        parameters = self.extract_parameters(graph)
        return {
            "id": workflow_id,
            "title": str(metadata.get("title") or path.stem.replace("_", " ").replace("-", " ")),
            "description": str(metadata.get("description") or ""),
            "tags": metadata.get("tags", []) if isinstance(metadata.get("tags", []), list) else [],
            "version": str(metadata.get("version") or "1"),
            "parameters": parameters,
            "media_inputs": [param["key"] for param in parameters if param["category"] in {"bridge_input", "media_input"}],
        }

    def load_graph(self, workflow_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        graph, _metadata, _path = self._read(workflow_id)
        return graph, self.extract_parameters(graph)


def validate_parameter(param: dict[str, Any], value: Any) -> Any:
    kind = param["type"]
    if kind == "boolean" and not isinstance(value, bool):
        raise ValueError("must be true or false")
    if kind == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
        raise ValueError("must be a whole number")
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError("must be a finite number")
    if kind == "string" and not isinstance(value, str):
        raise ValueError("must be text")
    if kind == "unsupported":
        raise ValueError("this input is not overridable")
    return value
