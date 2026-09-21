import { SidecarProvider } from "./sidecar-provider.js";
import type { AiProvider } from "./types.js";

export const DEFAULT_AI_URL = "http://127.0.0.1:4281";
export const DEFAULT_AI_MODEL = "clip-vit-base-patch32@1";

// MEMORYLANE_AI_PROVIDER=none disables every provider-backed analyzer; the
// default is the sidecar at MEMORYLANE_AI_URL, which may simply not be
// running - that's an outage the worker backs off from, not a config error.
export function createProvider(env: NodeJS.ProcessEnv = process.env): AiProvider | null {
  const kind = env.MEMORYLANE_AI_PROVIDER ?? "sidecar";
  if (kind === "none") return null;
  if (kind !== "sidecar") throw new Error(`Unknown MEMORYLANE_AI_PROVIDER "${kind}" (expected sidecar or none)`);
  return new SidecarProvider(env.MEMORYLANE_AI_URL ?? DEFAULT_AI_URL, {
    token: env.MEMORYLANE_AI_TOKEN || undefined,
    expectedModel: env.MEMORYLANE_AI_MODEL ?? DEFAULT_AI_MODEL,
  });
}
