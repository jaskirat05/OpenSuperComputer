# Open SuperComputer

A Next.js multimodal creative workspace with an OpenAI-compatible Chat Completions endpoint and a server-side adapter for remote render services.

The app code is licensed under MIT; see [LICENSE](LICENSE). Third-party components retain their own licenses.

## Install and start on Windows

1. Run `install-open-supercomputer.bat` once. It installs a project-local Node.js 24 runtime, installs `uv` for your Windows user, uses `uv` to provision Python 3.12, installs the MCP service dependencies, and installs the locked web app dependencies.
2. Setup starts **both required services**: the Open SuperComputer web app and its local ComfyUI MCP bridge. The app opens at `http://localhost:3000`; keep both service windows open while using it.
3. In **Model settings → ComfyUI**, enter the regular URL for your running ComfyUI instance. The MCP bridge is part of this app setup; ComfyUI itself remains a separate server that you provide.

The setup is repeatable: it reuses downloaded runtimes and environments, and reinstalls web dependencies when the package manifests change. On later launches, run `start-open-supercomputer.bat`. The project-local Node runtime and MCP Python environment stay in the project folder; chat and media data remain in `%LOCALAPPDATA%\VFXGuru`.

The installer downloads Node.js from the official Node.js distribution and verifies its published SHA-256 checksum. It installs `uv` using Astral's official Windows installer; `uv` then provisions the Python 3.12 runtime and the service virtual environment.

## Start on macOS/Linux

Run `bash ./start-open-supercomputer.sh` from the project folder. This launcher expects Node.js and `uv` to be installed, and uses `uv` to provision Python 3.12 and the MCP service environment. It starts both the web app and required MCP bridge.

You still need a running, reachable ComfyUI instance. After launch, open **Model settings → ComfyUI** and register its normal URL. The MCP service manages the local API v2 proxy automatically when needed; there is no separate proxy process to start manually.

The in-app provider settings are held in `sessionStorage` for the current browser session, then sent to the Next.js server for requests. Set `OPENAI_API_KEY` on the server if you prefer not to enter it in the UI. The chat route uses the widely implemented `/chat/completions` API and function calling. Images are sent inline; other attachments are not forwarded as model-readable bytes by the generic route. Video/audio/PDF inputs need a provider-specific adapter (or frame/audio extraction in your execution service). A provider can say "OpenAI-compatible" while supporting only some of the API's features.

## Local media library and image editor

Chat uploads are saved as soon as they are attached, and edited image exports are stored as new local files. SQLite records which chats use each asset and keeps editable image scenes. On Windows the default location is `%LOCALAPPDATA%\VFXGuru`; set `VFXGURU_DATA_DIR` to choose a different folder. The database is `vfxguru.sqlite` and media files are under `assets/`. Each browser chat has a stable local chat ID; **New session** starts a new chat. Use **Media library** beside Attach to browse all saved assets and add one to the current chat. Image attachments show an **Edit image** action in the composer and can be opened in the embedded MIT-licensed `@fastlabai/design-editor`; exports create new files and preserve the source. The editor engine uses Fabric.js internally, so the app does not need a separate direct Fabric dependency.

The asset preview uses the open-source Apache-2.0 [Video.js React player](https://github.com/videojs/video.js) for video playback and browser-native image/audio elements. Playback still depends on browser codec support (MP4/H.264 is the safest common choice). EXR/DPX are professional render formats, not browser image formats; preview them by adding a decoder such as [JERI](https://github.com/disneyresearch/jeri) or converting a proxy with OpenImageIO/FFmpeg. The current UI lets you download unsupported formats rather than showing a broken preview.

## Connect a remote VFX service

Set `VFX_EXECUTION_URL` to a trusted service endpoint and optionally set `VFX_EXECUTION_TOKEN`. When the model decides the user explicitly wants a pipeline run, the server validates the requested pipeline against an allowlist and posts:

```json
{ "pipeline": "upscale", "prompt": "...", "inputFiles": ["shot.mov"] }
```

The service should respond with `{ "jobId": "...", "status": "queued", "artifacts": [], "logs": [] }`. The route at `/api/jobs/[id]` proxies `GET {VFX_EXECUTION_URL}/{jobId}` for status updates. For production, upload media to controlled object storage and pass signed URLs or asset IDs to the job service; browser-local filenames are not file references. Run long renders asynchronously and poll or stream job events from the backend.

The current UI shows the initial response's artifact and log payload. Polling and durable run history are the next integration layer once your target service API contract is known.
