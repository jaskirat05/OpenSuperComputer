from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import data_dir


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    """SQLite holds replaceable instance config and durable run/asset metadata."""

    def __init__(self) -> None:
        self.root = data_dir()
        self.db_path = self.root / "comfy-service.sqlite3"
        self.assets_dir = self.root / "assets"
        self.outputs_dir = self.root / "outputs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS comfy_instance (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    base_url TEXT NOT NULL,
                    comfy_url TEXT,
                    managed_proxy INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    inputs_json TEXT NOT NULL DEFAULT '{}',
                    comfy_job_id TEXT,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    message TEXT NOT NULL,
                    error TEXT,
                    error_details_json TEXT,
                    outputs_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    stored_name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            run_columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)").fetchall()}
            if "inputs_json" not in run_columns:
                db.execute("ALTER TABLE runs ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '{}'")
            if "error_details_json" not in run_columns:
                db.execute("ALTER TABLE runs ADD COLUMN error_details_json TEXT")
            instance_columns = {row["name"] for row in db.execute("PRAGMA table_info(comfy_instance)").fetchall()}
            if "comfy_url" not in instance_columns:
                db.execute("ALTER TABLE comfy_instance ADD COLUMN comfy_url TEXT")
            if "managed_proxy" not in instance_columns:
                db.execute("ALTER TABLE comfy_instance ADD COLUMN managed_proxy INTEGER NOT NULL DEFAULT 0")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def instance(self) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT base_url, comfy_url, managed_proxy, updated_at FROM comfy_instance WHERE singleton=1").fetchone()
        if not row:
            return None
        instance = dict(row)
        # Older versions stored the SDK's API v2 URL only.
        if not instance["comfy_url"]:
            instance["comfy_url"] = instance["base_url"]
        instance["managed_proxy"] = bool(instance["managed_proxy"])
        return instance

    def replace_instance(self, comfy_url: str, base_url: str, managed_proxy: bool) -> dict[str, Any]:
        updated_at = now()
        with self._connect() as db:
            db.execute(
                "INSERT INTO comfy_instance(singleton, base_url, comfy_url, managed_proxy, updated_at) VALUES(1, ?, ?, ?, ?) "
                "ON CONFLICT(singleton) DO UPDATE SET base_url=excluded.base_url, comfy_url=excluded.comfy_url, managed_proxy=excluded.managed_proxy, updated_at=excluded.updated_at",
                (base_url, comfy_url, int(managed_proxy), updated_at),
            )
        return {"base_url": base_url, "comfy_url": comfy_url, "managed_proxy": managed_proxy, "updated_at": updated_at}

    def clear_instance(self) -> bool:
        with self._connect() as db:
            return db.execute("DELETE FROM comfy_instance WHERE singleton=1").rowcount > 0

    def create_run(self, workflow_id: str, base_url: str, parameters: dict[str, Any], asset_inputs: dict[str, str]) -> dict[str, Any]:
        run = {
            "id": str(uuid4()), "workflow_id": workflow_id, "base_url": base_url,
            "inputs": {"parameters": parameters, "asset_inputs": asset_inputs},
            "comfy_job_id": None, "status": "queued", "progress": 0.0,
            "message": "Waiting to submit to ComfyUI.", "error": None, "outputs": [],
            "created_at": now(), "updated_at": now(),
        }
        with self._connect() as db:
            db.execute(
                "INSERT INTO runs(id, workflow_id, base_url, inputs_json, comfy_job_id, status, progress, message, error, outputs_json, created_at, updated_at) "
                "VALUES(:id, :workflow_id, :base_url, :inputs_json, :comfy_job_id, :status, :progress, :message, :error, :outputs_json, :created_at, :updated_at)",
                {**run, "inputs_json": json.dumps(run["inputs"], ensure_ascii=False), "outputs_json": "[]"},
            )
        return run

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        run = dict(row)
        run["outputs"] = json.loads(run.pop("outputs_json"))
        run["inputs"] = json.loads(run.pop("inputs_json"))
        details = run.pop("error_details_json", None)
        run["error_details"] = json.loads(details) if details else None
        # Never return internal target URLs as part of an LLM-facing run record.
        run.pop("base_url", None)
        return run

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return recent run summaries without exposing configured Comfy URLs or inputs."""
        limit = max(1, min(100, int(limit)))
        with self._connect() as db:
            rows = db.execute(
                "SELECT id, workflow_id, status, progress, message, outputs_json, created_at, updated_at "
                "FROM runs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        runs = []
        for row in rows:
            item = dict(row)
            item["outputs"] = json.loads(item.pop("outputs_json"))
            runs.append(item)
        return runs

    def get_run_internal(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        run = dict(row)
        run["outputs"] = json.loads(run.pop("outputs_json"))
        run["inputs"] = json.loads(run.pop("inputs_json"))
        details = run.pop("error_details_json", None)
        run["error_details"] = json.loads(details) if details else None
        return run

    def update_run(self, run_id: str, **values: Any) -> None:
        allowed = {"comfy_job_id", "status", "progress", "message", "error", "error_details", "outputs"}
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            return
        if "outputs" in updates:
            updates["outputs_json"] = json.dumps(updates.pop("outputs"), ensure_ascii=False)
        if "error_details" in updates:
            details = updates.pop("error_details")
            updates["error_details_json"] = json.dumps(details, ensure_ascii=False, default=str) if details is not None else None
        updates["updated_at"] = now()
        assignments = ", ".join(f"{key}=?" for key in updates)
        with self._connect() as db:
            db.execute(f"UPDATE runs SET {assignments} WHERE id=?", (*updates.values(), run_id))

    def mark_interrupted(self) -> None:
        with self._connect() as db:
            db.execute(
                "UPDATE runs SET status='interrupted', message='Service restarted while this run was active; inspect or resubmit.', updated_at=? "
                "WHERE status IN ('queued', 'running', 'cancel_requested')",
                (now(),),
            )

    def save_asset(self, filename: str, content_type: str, size_bytes: int, stored_name: str) -> dict[str, Any]:
        asset = {"id": str(uuid4()), "filename": filename, "content_type": content_type, "size_bytes": size_bytes, "stored_name": stored_name, "created_at": now()}
        with self._connect() as db:
            db.execute(
                "INSERT INTO assets(id, filename, content_type, size_bytes, stored_name, created_at) VALUES(?, ?, ?, ?, ?, ?)",
                (asset["id"], filename, content_type, size_bytes, stored_name, asset["created_at"]),
            )
        return asset

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return dict(row) if row else None
