import type { VideoTranscodeQuality } from "@memorylane/shared";

export interface VideoProbe {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  codec: string | null;
  audioCodec: string | null;
}
export type MetadataTags = Record<string, unknown>;

// File paths never cross the public plugin contract. Core resolves and
// authorizes an opaque source token, then an adapter invokes the implementation.
export interface MediaToolCapabilities {
  metadata: { available(): boolean; read(sourcePath: string): Promise<MetadataTags | null>; version(): string };
  rawPreview: { extract(sourcePath: string): Promise<Buffer | null> };
  video: {
    available(): boolean;
    probe(sourcePath: string): Promise<VideoProbe | null>;
    poster(sourcePath: string): Promise<Buffer | null>;
    transcode(sourcePath: string, destinationPath: string, quality: VideoTranscodeQuality): Promise<boolean>;
  };
}

export class DeferredMediaToolCapabilities implements MediaToolCapabilities {
  private delegate: MediaToolCapabilities | null = null;
  setDelegate(delegate: MediaToolCapabilities): void { this.delegate = delegate; }
  metadata = {
    available: () => this.delegate?.metadata.available() ?? false,
    read: (sourcePath: string) => this.required().metadata.read(sourcePath),
    version: () => this.delegate?.metadata.version() ?? "unavailable",
  };
  rawPreview = { extract: (sourcePath: string) => this.required().rawPreview.extract(sourcePath) };
  video = {
    available: () => this.delegate?.video.available() ?? false,
    probe: (sourcePath: string) => this.required().video.probe(sourcePath),
    poster: (sourcePath: string) => this.required().video.poster(sourcePath),
    transcode: (sourcePath: string, destinationPath: string, quality: VideoTranscodeQuality) => this.required().video.transcode(sourcePath, destinationPath, quality),
  };
  private required(): MediaToolCapabilities {
    if (!this.delegate) throw new Error("Media tool plugins have not initialized");
    return this.delegate;
  }
}
