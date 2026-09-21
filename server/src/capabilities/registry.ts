import type { CapabilityId } from "@memorylane/plugin-sdk";
import { CapabilityUnavailableError } from "./errors.js";

export interface CapabilityProvider<T> {
  pluginId: string;
  invoke(request: unknown): Promise<T>;
}

export class CapabilityRegistry {
  private providers = new Map<CapabilityId, CapabilityProvider<unknown>>();

  register<T>(capability: CapabilityId, provider: CapabilityProvider<T>): () => void {
    if (this.providers.has(capability)) throw new Error(`Capability already registered: ${capability}`);
    this.providers.set(capability, provider);
    return () => { if (this.providers.get(capability) === provider) this.providers.delete(capability); };
  }

  has(capability: CapabilityId): boolean { return this.providers.has(capability); }

  async invoke<T>(capability: CapabilityId, request: unknown): Promise<T> {
    const provider = this.providers.get(capability);
    if (!provider) throw new CapabilityUnavailableError(capability);
    return provider.invoke(request) as Promise<T>;
  }
}
