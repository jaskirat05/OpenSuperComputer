from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx

from .config import comfy_api_key
from .store import Store


class ProxyError(RuntimeError):
    pass


class ComfyProxyManager:
    """Own the local Comfy API v2 proxy used by the official SDK."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.process: subprocess.Popen | None = None
        self.log_file: Any = None
        self.comfy_url: str | None = None
        self.base_url: str | None = None

    @staticmethod
    def _proxy_cli() -> Path:
        configured = os.getenv("COMFY_API_PROXY_PATH", "").strip()
        if configured:
            return Path(configured).expanduser().resolve()
        folder = Path(sys.executable).resolve().parent
        return folder / ("comfy-api-proxy.exe" if os.name == "nt" else "comfy-api-proxy")

    @staticmethod
    def _health_url(base_url: str) -> str:
        return f"{base_url.rstrip('/')}/api/v2/health"

    async def _is_api_v2(self, base_url: str) -> bool:
        headers = {"Authorization": f"Bearer {comfy_api_key()}"} if comfy_api_key() else {}
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(self._health_url(base_url), headers=headers)
                return response.is_success
        except httpx.HTTPError:
            return False

    async def _is_native_comfy(self, comfy_url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{comfy_url.rstrip('/')}/queue")
                return response.is_success
        except httpx.HTTPError:
            return False

    @staticmethod
    def _free_port(start: int = 8189, end: int = 8289) -> int:
        for port in range(start, end + 1):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                try:
                    probe.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    continue
        raise ProxyError(f"No free local port is available for the Comfy API proxy ({start}-{end}).")

    def _stop_process(self, process: subprocess.Popen | None) -> None:
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    async def configure(self, comfy_url: str) -> dict[str, Any]:
        if self.comfy_url == comfy_url and self.base_url and self.process and self.process.poll() is None:
            return {"comfy_url": comfy_url, "base_url": self.base_url, "managed_proxy": True}

        # A deployment may already expose v2; otherwise accept ordinary ComfyUI's /queue API.
        if await self._is_api_v2(comfy_url):
            await self.stop()
            return {"comfy_url": comfy_url, "base_url": comfy_url, "managed_proxy": False}
        if not await self._is_native_comfy(comfy_url):
            raise ProxyError(f"Could not reach ComfyUI at {comfy_url}. Check the URL and make sure ComfyUI is running and reachable from this machine.")

        cli = self._proxy_cli()
        if not cli.is_file():
            raise ProxyError("comfy-api-proxy is not installed in the VFX Guru service environment.")
        port = self._free_port()
        new_base_url = f"http://127.0.0.1:{port}"
        log_path = self.store.root / "comfy-api-proxy.log"
        log_file = log_path.open("ab")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            process = subprocess.Popen(
                [str(cli), "run", "--comfyui", comfy_url, "--host", "127.0.0.1", "--port", str(port), "--max-upload-mb", "2048"],
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                cwd=self.store.root,
                creationflags=flags,
                start_new_session=os.name != "nt",
            )
        except OSError as error:
            log_file.close()
            raise ProxyError(f"Could not start comfy-api-proxy ({type(error).__name__}).") from error

        ready = False
        async with httpx.AsyncClient(timeout=1.5) as client:
            for _ in range(50):
                if process.poll() is not None:
                    break
                try:
                    response = await client.get(self._health_url(new_base_url))
                    if response.is_success:
                        ready = True
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)

        if not ready:
            self._stop_process(process)
            log_file.close()
            detail = "The proxy did not become ready."
            try:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:].strip()
                if tail:
                    detail = tail
            except OSError:
                pass
            raise ProxyError(f"Could not start the Comfy API proxy: {detail}")

        old_process, old_log = self.process, self.log_file
        self.process, self.log_file = process, log_file
        self.comfy_url, self.base_url = comfy_url, new_base_url
        self._stop_process(old_process)
        if old_log:
            old_log.close()
        return {"comfy_url": comfy_url, "base_url": new_base_url, "managed_proxy": True}

    async def restore(self) -> None:
        instance = self.store.instance()
        if not instance or not instance.get("managed_proxy"):
            return
        comfy_url = str(instance.get("comfy_url") or "")
        if not comfy_url:
            return
        # A proxy may have survived an unclean service stop. Reuse it if its health endpoint still answers.
        base_url = str(instance["base_url"])
        if await self._is_api_v2(base_url):
            self.comfy_url, self.base_url = comfy_url, base_url
            return
        connection = await self.configure(comfy_url)
        self.store.replace_instance(comfy_url, connection["base_url"], bool(connection["managed_proxy"]))

    async def stop(self) -> None:
        self._stop_process(self.process)
        if self.log_file:
            self.log_file.close()
        self.process = None
        self.log_file = None
        self.comfy_url = None
        self.base_url = None

    async def close(self) -> None:
        await self.stop()
