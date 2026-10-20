import { z } from "zod";

export const MEDIA_QUEUE = "media";
export const PROBE_JOB = "probe";
export const probeJobData = z.object({ jobId: z.string().uuid() });
export type ProbeJobData = z.infer<typeof probeJobData>;

/** Same options wherever a probe job is enqueued. jobId makes adding the same render job twice a no-op. */
export const probeJobOptions = (jobId: string, backoffMs = 5000) => ({
  jobId,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: backoffMs },
  removeOnComplete: 1000,
  removeOnFail: 1000,
});

export const VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"] as const;

export const DEFAULT_LIMITS = {
  maxBytes: 2 * 1024 ** 3, // 2 GiB
  maxDurationSeconds: 3 * 60 * 60, // 3 hours
  minDimension: 64,
  maxDimension: 7680,
  maxStreams: 16,
} as const;
export type MediaLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

export const uploadRequestSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.enum(VIDEO_CONTENT_TYPES),
  size: z.number().int().min(1),
});

// Container names ffprobe reports (comma-separated) that we accept.
const ACCEPTED_FORMATS = ["mov", "mp4", "matroska", "webm"];

export type ProbeSummary = {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  fps: number | null;
  formatName: string;
  bitRate: number | null;
};

export type ProbeVerdict = { ok: true; summary: ProbeSummary } | { ok: false; reason: string };

type Stream = {
  codec_type?: string; codec_name?: string; width?: number; height?: number;
  avg_frame_rate?: string; disposition?: { attached_pic?: number };
};
export type FfprobeOutput = { format?: { format_name?: string; duration?: string; bit_rate?: string }; streams?: Stream[] };

const fraction = (s?: string) => {
  const [n, d] = (s ?? "").split("/").map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
};

/** Decides whether an ffprobe result is acceptable. Reasons are safe to show to users. */
export function validateProbe(probe: FfprobeOutput, limits: MediaLimits): ProbeVerdict {
  const streams = probe.streams ?? [];
  if (streams.length === 0 || streams.length > limits.maxStreams) return { ok: false, reason: "This file does not look like a normal video." };

  const formats = (probe.format?.format_name ?? "").split(",");
  if (!formats.some((f) => ACCEPTED_FORMATS.includes(f))) return { ok: false, reason: "Unsupported video format. Use MP4, MOV, WebM or MKV." };

  // Cover art in an audio file shows up as a video stream; it is not a video.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) return { ok: false, reason: "No video track found in this file." };

  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, reason: "Could not read the video length." };
  if (duration > limits.maxDurationSeconds) return { ok: false, reason: `Video is longer than the ${Math.round(limits.maxDurationSeconds / 60)} minute limit.` };

  const { width = 0, height = 0 } = video;
  if (Math.min(width, height) < limits.minDimension || Math.max(width, height) > limits.maxDimension) {
    return { ok: false, reason: "Video dimensions are outside the supported range." };
  }

  const audio = streams.find((s) => s.codec_type === "audio");
  const bitRate = Number(probe.format?.bit_rate);
  return {
    ok: true,
    summary: {
      durationSeconds: Math.round(duration * 100) / 100,
      width, height,
      videoCodec: video.codec_name ?? "unknown",
      audioCodec: audio?.codec_name ?? null,
      fps: fraction(video.avg_frame_rate),
      formatName: probe.format?.format_name ?? "",
      bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : null,
    },
  };
}

/** Container check on the first bytes. Runs before ffprobe so a text/playlist file can never reach a demuxer. */
/** Returns the ffprobe demuxer name to force (`-f`), so ffprobe never auto-detects playlist or concat formats. */
export function sniffContainer(head: Uint8Array): "mov" | "matroska" | null {
  if (head.length >= 12 && String.fromCharCode(...head.slice(4, 8)) === "ftyp") return "mov";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "matroska";
  return null;
}

export const assetStorageKey = (workspaceId: string, assetId: string) => `workspaces/${workspaceId}/assets/${assetId}/source`;

const BY_EXTENSION: Record<string, (typeof VIDEO_CONTENT_TYPES)[number]> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
};
/** Browsers often send an empty or generic type (notably for .mkv), so fall back to the extension. */
export function contentTypeFor(filename: string, browserType: string): string {
  if ((VIDEO_CONTENT_TYPES as readonly string[]).includes(browserType)) return browserType;
  return BY_EXTENSION[filename.split(".").pop()?.toLowerCase() ?? ""] ?? browserType;
}
