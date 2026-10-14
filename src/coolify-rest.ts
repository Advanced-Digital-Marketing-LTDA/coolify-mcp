import { isSafeCoolifyOrigin } from "./config.js";
import { NotConfiguredError } from "./errors.js";
import { validateApplicationConfig, type ApplicationConfigField, type ApplicationConfigValue } from "./policy.js";

/** Fixed Coolify REST PATCH adapter; callers cannot provide a URL or extra fields. */
export class CoolifyApplicationConfigWriter {
  constructor(private readonly origin: string | undefined, private readonly token: string | undefined, private readonly request: typeof fetch = fetch) {}

  async update(uuid: string, field: ApplicationConfigField, value: ApplicationConfigValue, signal?: AbortSignal): Promise<void> {
    if (!isSafeCoolifyOrigin(this.origin) || !this.token?.trim()) throw new NotConfiguredError("Coolify application configuration writer is not configured");
    if (!/^[A-Za-z0-9-]{1,128}$/.test(uuid) || !validateApplicationConfig(field, value)) throw new Error("Invalid application configuration request");
    const url = new URL(`/api/v1/applications/${encodeURIComponent(uuid)}`, this.origin);
    const timeout = AbortSignal.timeout(30_000);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    boundedSignal.throwIfAborted();
    const response = await this.request(url, {
      method: "PATCH",
      redirect: "error",
      signal: boundedSignal,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Coolify application configuration update failed");
    }
    let responseUuid: unknown;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing response body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4_096) { await reader.cancel(); throw new Error("oversized response"); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      responseUuid = (JSON.parse(new TextDecoder().decode(bytes)) as { uuid?: unknown }).uuid;
    } catch { throw new Error("Coolify application configuration response was invalid"); }
    if (responseUuid !== uuid) throw new Error("Coolify application configuration response did not match the requested application");
  }
}
