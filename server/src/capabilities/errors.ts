export class CapabilityUnavailableError extends Error {
  constructor(public readonly capability: string, message = `Capability is unavailable: ${capability}`) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}
