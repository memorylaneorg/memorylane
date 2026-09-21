import fs from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
  heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", avi: "video/x-msvideo",
  mkv: "video/x-matroska", webm: "video/webm",
};

export function mimeTypeForExtension(extensionNoDot: string): string {
  return MIME_TYPES[extensionNoDot.toLowerCase()] ?? "application/octet-stream";
}

// Streams a file from disk with HTTP Range support (required for smooth video
// seeking; harmless/unused-by-default for images). Caller is responsible for
// having already verified the path is safe to serve (see PLAN.md section 24 /
// spec section 24 - resolve via DB id, verify scan root, verify existence).
export async function streamFile(
  request: FastifyRequest,
  reply: FastifyReply,
  absolutePath: string,
  mimeType: string,
): Promise<void> {
  const stat = await fs.promises.stat(absolutePath);
  const range = request.headers.range;

  if (!range) {
    reply.header("Content-Type", mimeType);
    reply.header("Content-Length", stat.size);
    reply.header("Accept-Ranges", "bytes");
    return reply.send(fs.createReadStream(absolutePath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    reply.code(416).header("Content-Range", `bytes */${stat.size}`);
    return reply.send();
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    reply.code(416).header("Content-Range", `bytes */${stat.size}`);
    return reply.send();
  }

  reply.code(206);
  reply.header("Content-Type", mimeType);
  reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Length", end - start + 1);
  return reply.send(fs.createReadStream(absolutePath, { start, end }));
}
