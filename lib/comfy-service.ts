import "server-only";

export async function comfyServiceRequest(path: string, init?: RequestInit) {
  const base = (process.env.COMFY_SERVICE_URL || "http://127.0.0.1:8012").replace(/\/$/, "");
  const headers = new Headers(init?.headers);
  const token = process.env.COMFY_SERVICE_TOKEN?.trim();
  if (token) headers.set("X-Service-Token", token);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch {
    return { response: null, data: { detail: "The local Comfy service is unavailable. Start it and try again." } };
  }
}
