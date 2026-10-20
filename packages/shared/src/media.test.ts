import { describe, expect, it } from "vitest";
import { assetStorageKey, contentTypeFor, DEFAULT_LIMITS, parseStorageEnv, sniffContainer, validateProbe, validateSegments, type FfprobeOutput, type MediaLimits } from "./index";

const limits: MediaLimits = { ...DEFAULT_LIMITS };
const good: FfprobeOutput = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5", bit_rate: "800000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac" },
  ],
};

describe("validateProbe", () => {
  it("accepts a normal video and summarises it", () => {
    const v = validateProbe(good, limits);
    expect(v).toEqual({ ok: true, summary: { durationSeconds: 12.5, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", fps: 29.97, formatName: "mov,mp4,m4a,3gp,3g2,mj2", bitRate: 800000 } });
  });
  it("accepts webm/matroska and video without audio", () => {
    const v = validateProbe({ format: { format_name: "matroska,webm", duration: "5" }, streams: [{ codec_type: "video", width: 640, height: 360 }] }, limits);
    expect(v.ok && v.summary.audioCodec).toBe(null);
  });
  it.each([
    ["no streams", { format: good.format, streams: [] }],
    ["too many streams", { format: good.format, streams: Array(17).fill({ codec_type: "data" }) }],
    ["wrong container", { ...good, format: { ...good.format, format_name: "hls" } }],
    ["audio only", { format: good.format, streams: [{ codec_type: "audio" }] }],
    ["cover art only", { format: good.format, streams: [{ codec_type: "video", width: 500, height: 500, disposition: { attached_pic: 1 } }] }],
    ["no duration", { ...good, format: { format_name: "mp4" } }],
    ["zero duration", { ...good, format: { format_name: "mp4", duration: "0" } }],
    ["too long", { ...good, format: { format_name: "mp4", duration: String(limits.maxDurationSeconds + 1) } }],
    ["tiny frame", { ...good, streams: [{ codec_type: "video", width: 16, height: 16 }] }],
    ["huge frame", { ...good, streams: [{ codec_type: "video", width: 16000, height: 9000 }] }],
  ] as [string, FfprobeOutput][])("rejects %s", (_n, probe) => {
    const v = validateProbe(probe, limits);
    expect(v.ok).toBe(false);
  });
  it("gives a user-safe reason", () => {
    const v = validateProbe({ ...good, format: { format_name: "mp4", duration: "99999" } }, limits);
    expect(!v.ok && v.reason).toMatch(/minute limit/);
  });
});

describe("sniffContainer", () => {
  const bytes = (...b: number[]) => Uint8Array.from([...b, ...Array(16).fill(0)]);
  it("recognises mp4/mov and matroska/webm", () => {
    expect(sniffContainer(Uint8Array.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe("mov");
    expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("matroska");
  });
  it("rejects text playlists and anything else", () => {
    const text = (s: string) => new TextEncoder().encode(s.padEnd(16, " "));
    expect(sniffContainer(text("#EXTM3U\nfile:///etc/passwd"))).toBe(null);
    expect(sniffContainer(text("ffconcat version 1.0"))).toBe(null);
    expect(sniffContainer(new Uint8Array(0))).toBe(null);
  });
});

describe("parseStorageEnv", () => {
  const ok = { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", REDIS_URL: "redis://localhost:6379" };
  it("applies defaults", () => {
    const e = parseStorageEnv(ok);
    expect(e.S3_FORCE_PATH_STYLE).toBe(false);
    expect(e.MAX_UPLOAD_BYTES).toBe(2 * 1024 ** 3);
  });
  it("treats empty strings as unset", () => {
    const e = parseStorageEnv({ ...ok, S3_ENDPOINT: "", MAX_UPLOAD_BYTES: "" });
    expect(e.S3_ENDPOINT).toBeUndefined();
    expect(e.MAX_UPLOAD_BYTES).toBe(2 * 1024 ** 3);
  });
  it("names bad variables without echoing values", () => {
    expect(() => parseStorageEnv({ ...ok, S3_BUCKET: undefined, MAX_UPLOAD_BYTES: "-5" })).toThrow("S3_BUCKET, MAX_UPLOAD_BYTES");
    try { parseStorageEnv({ ...ok, S3_ENDPOINT: "not-a-url-secret" }); } catch (e) { expect((e as Error).message).not.toContain("not-a-url-secret"); }
  });
});

describe("contentTypeFor / assetStorageKey", () => {
  it("falls back to the extension when the browser type is unhelpful", () => {
    expect(contentTypeFor("clip.MKV", "")).toBe("video/x-matroska");
    expect(contentTypeFor("clip.mov", "application/octet-stream")).toBe("video/quicktime");
    expect(contentTypeFor("clip.mp4", "video/mp4")).toBe("video/mp4");
    expect(contentTypeFor("notes.exe", "")).toBe("");
  });
  it("builds keys from ids only", () => expect(assetStorageKey("w", "a")).toBe("workspaces/w/assets/a/source"));
});

describe("validateSegments", () => {
  it("accepts ordered segments inside the video", () => {
    expect(validateSegments([{ start: 0, end: 2, text: "a" }, { start: 2, end: 4, text: "b" }], 4)).toHaveLength(2);
  });
  it("rejects out-of-order, overlong, empty or reversed segments", () => {
    expect(() => validateSegments([{ start: 3, end: 4, text: "a" }, { start: 1, end: 2, text: "b" }], 10)).toThrow();
    expect(() => validateSegments([{ start: 0, end: 50, text: "a" }], 10)).toThrow();
    expect(() => validateSegments([{ start: 0, end: 1, text: "  " }], 10)).toThrow();
    expect(() => validateSegments([{ start: 2, end: 1, text: "a" }], 10)).toThrow();
    expect(() => validateSegments("nope", 10)).toThrow();
  });
});
