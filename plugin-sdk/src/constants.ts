export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_CATALOG_FORMAT_VERSION = 1 as const;

export const PLUGIN_PLATFORMS = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
] as const;

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

// Dev-catalog mode only (a service-kind manifest declaring `devPort`): the
// fixed bearer token a plugin author's own independently-run process should
// require on its /health and other endpoints, since core never spawns it and
// so has no random per-launch token to hand it the way production does.
// Loopback-only, no real threat model in dev - fixed and shared, not secret.
export const DEV_SERVICE_TOKEN = "memorylane-dev";

export function currentPluginPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PluginPlatform | null {
  const candidate = `${platform}-${arch}`;
  return (PLUGIN_PLATFORMS as readonly string[]).includes(candidate)
    ? (candidate as PluginPlatform)
    : null;
}
