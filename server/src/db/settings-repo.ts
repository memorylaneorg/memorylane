import type Database from "better-sqlite3";
import type { SettingsDto, FaceModelName } from "@memorylane/shared";

const DEFAULTS: SettingsDto = {
  archiveTitle: "MemoryLane",
  bindAddress: "127.0.0.1",
  museumServiceEnabled: true,
  port: 4280,
  scanIntervalDays: null,
  scanScheduleEnabled: false,
  stackGapSeconds: 2,
  stackMaxHamming: 14,
  stackMinCosine: 0.9,
  stackSeriesGapSeconds: 120,
  aiEnabled: true,
  personsEnabled: false,
  faceAssignThreshold: 0.45,
  faceMinClusterSize: 3,
  faceLinkThreshold: 0.5,
  faceModel: "yunet-sface",
};

export class SettingsRepo {
  constructor(private db: Database.Database) {}

  getAll(): SettingsDto {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      archiveTitle: map.get("archiveTitle") ?? DEFAULTS.archiveTitle,
      bindAddress: map.get("bindAddress") ?? DEFAULTS.bindAddress,
      museumServiceEnabled: map.has("museumServiceEnabled")
        ? map.get("museumServiceEnabled") === "true"
        : DEFAULTS.museumServiceEnabled,
      port: map.has("port") ? Number(map.get("port")) : DEFAULTS.port,
      scanIntervalDays: map.has("scanIntervalDays")
        ? map.get("scanIntervalDays") === "null"
          ? null
          : Number(map.get("scanIntervalDays"))
        : DEFAULTS.scanIntervalDays,
      scanScheduleEnabled: map.has("scanScheduleEnabled")
        ? map.get("scanScheduleEnabled") === "true"
        : DEFAULTS.scanScheduleEnabled,
      stackGapSeconds: map.has("stackGapSeconds") ? Number(map.get("stackGapSeconds")) : DEFAULTS.stackGapSeconds,
      stackMaxHamming: map.has("stackMaxHamming") ? Number(map.get("stackMaxHamming")) : DEFAULTS.stackMaxHamming,
      stackMinCosine: map.has("stackMinCosine") ? Number(map.get("stackMinCosine")) : DEFAULTS.stackMinCosine,
      stackSeriesGapSeconds: map.has("stackSeriesGapSeconds") ? Number(map.get("stackSeriesGapSeconds")) : DEFAULTS.stackSeriesGapSeconds,
      aiEnabled: map.has("aiEnabled") ? map.get("aiEnabled") === "true" : DEFAULTS.aiEnabled,
      personsEnabled: map.has("personsEnabled") ? map.get("personsEnabled") === "true" : DEFAULTS.personsEnabled,
      faceAssignThreshold: map.has("faceAssignThreshold") ? Number(map.get("faceAssignThreshold")) : DEFAULTS.faceAssignThreshold,
      faceMinClusterSize: map.has("faceMinClusterSize") ? Number(map.get("faceMinClusterSize")) : DEFAULTS.faceMinClusterSize,
      faceLinkThreshold: map.has("faceLinkThreshold") ? Number(map.get("faceLinkThreshold")) : DEFAULTS.faceLinkThreshold,
      faceModel: (map.get("faceModel") as FaceModelName | undefined) ?? DEFAULTS.faceModel,
    };
  }

  update(patch: Partial<SettingsDto>): SettingsDto {
    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction((entries: [string, string][]) => {
      for (const [key, value] of entries) upsert.run(key, value);
    });

    const entries: [string, string][] = [];
    if (patch.archiveTitle !== undefined) entries.push(["archiveTitle", patch.archiveTitle]);
    if (patch.bindAddress !== undefined) entries.push(["bindAddress", patch.bindAddress]);
    if (patch.museumServiceEnabled !== undefined)
      entries.push(["museumServiceEnabled", String(patch.museumServiceEnabled)]);
    if (patch.port !== undefined) entries.push(["port", String(patch.port)]);
    if (patch.scanIntervalDays !== undefined)
      entries.push(["scanIntervalDays", patch.scanIntervalDays === null ? "null" : String(patch.scanIntervalDays)]);
    if (patch.scanScheduleEnabled !== undefined)
      entries.push(["scanScheduleEnabled", String(patch.scanScheduleEnabled)]);
    if (patch.stackGapSeconds !== undefined) entries.push(["stackGapSeconds", String(patch.stackGapSeconds)]);
    if (patch.stackMaxHamming !== undefined) entries.push(["stackMaxHamming", String(patch.stackMaxHamming)]);
    if (patch.stackMinCosine !== undefined) entries.push(["stackMinCosine", String(patch.stackMinCosine)]);
    if (patch.stackSeriesGapSeconds !== undefined) entries.push(["stackSeriesGapSeconds", String(patch.stackSeriesGapSeconds)]);
    if (patch.aiEnabled !== undefined) entries.push(["aiEnabled", String(patch.aiEnabled)]);
    if (patch.personsEnabled !== undefined) entries.push(["personsEnabled", String(patch.personsEnabled)]);
    if (patch.faceAssignThreshold !== undefined) entries.push(["faceAssignThreshold", String(patch.faceAssignThreshold)]);
    if (patch.faceMinClusterSize !== undefined) entries.push(["faceMinClusterSize", String(patch.faceMinClusterSize)]);
    if (patch.faceLinkThreshold !== undefined) entries.push(["faceLinkThreshold", String(patch.faceLinkThreshold)]);
    if (patch.faceModel !== undefined) entries.push(["faceModel", patch.faceModel]);

    if (entries.length > 0) tx(entries);
    return this.getAll();
  }
}
