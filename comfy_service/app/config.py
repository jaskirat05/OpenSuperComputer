from __future__ import annotations

import os
from pathlib import Path


PACKAGE_DIR = Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    configured = os.getenv("COMFY_SERVICE_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "VFXGuru" / "comfy-service"
    return Path.home() / ".local" / "share" / "vfxguru" / "comfy-service"


def workflows_dir() -> Path:
    configured = os.getenv("COMFY_WORKFLOWS_DIR")
    return Path(configured).expanduser().resolve() if configured else PACKAGE_DIR / "workflows"


def service_token() -> str:
    return os.getenv("COMFY_SERVICE_TOKEN", "").strip()


def comfy_api_key() -> str:
    return os.getenv("COMFY_API_KEY", "").strip()


def allowed_origins() -> list[str]:
    value = os.getenv("VFX_GURU_ORIGINS", "http://localhost:3001,http://127.0.0.1:3001")
    return [origin.strip() for origin in value.split(",") if origin.strip()]
