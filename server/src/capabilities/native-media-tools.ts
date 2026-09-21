import type { VideoTranscodeQuality } from "@memorylane/shared";
import type { MediaToolCapabilities, MetadataTags, VideoProbe } from "./media-tools.js";
import { extractLargestEmbeddedPreview, getExifToolVersion, isExifToolAvailable, readTags } from "../media/exiftool-client.js";
import { extractPosterFrame, isFfmpegAvailable, probeVideo, transcodeVideo } from "../media/video-client.js";

// Metadata/RAW-preview and video tooling both run in-process, same as sharp
// already does for thumbnails - they're required: true (every install needs
// them, nobody opts out), so the plugin platform's install/update/health-check
// machinery buys no real flexibility here, only overhead. See exiftool-client.ts
// and video-client.ts for the actual implementations (restored from before the
// plugin-platform refactor, where this is exactly how they worked).
export class NativeMediaToolCapabilities implements MediaToolCapabilities {
  metadata = {
    available: () => isExifToolAvailable(),
    read: (sourcePath: string): Promise<MetadataTags | null> => readTags(sourcePath) as Promise<MetadataTags | null>,
    version: () => getExifToolVersion(),
  };
  rawPreview = { extract: (sourcePath: string): Promise<Buffer | null> => extractLargestEmbeddedPreview(sourcePath) };
  video = {
    available: () => isFfmpegAvailable(),
    probe: (sourcePath: string): Promise<VideoProbe | null> => probeVideo(sourcePath),
    poster: (sourcePath: string): Promise<Buffer | null> => extractPosterFrame(sourcePath),
    transcode: (sourcePath: string, destinationPath: string, quality: VideoTranscodeQuality): Promise<boolean> =>
      transcodeVideo(sourcePath, destinationPath, quality),
  };
}
