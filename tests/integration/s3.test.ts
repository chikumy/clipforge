import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStorageEnv } from "@clipforge/shared";
import { presignUpload, storedSize, UPLOAD_URL_TTL_SECONDS } from "../../apps/web/lib/storage";
import { s3Store, TooLargeError } from "../../apps/worker/src/store";

// Real S3 API (MinIO in CI, moto locally). Skipped unless S3_ENDPOINT is set; see docs/setup.md.
const maybe = process.env.S3_ENDPOINT ? describe : describe.skip;
const enforces = process.env.S3_ENFORCES_POLICY === "true"; // MinIO/AWS enforce POST policies, moto does not

maybe("object storage", () => {
  const key = `workspaces/w/assets/${crypto.randomUUID()}/source`;
  const env = () => parseStorageEnv(process.env);
  let dir: string;

  const post = async (k: string, bytes: Uint8Array, declared: number, type = "video/mp4") => {
    const { url, fields } = await presignUpload(k, "video/mp4", declared);
    const form = new FormData();
    for (const [n, v] of Object.entries({ ...fields, "Content-Type": type })) form.append(n, v);
    form.append("file", new Blob([bytes], { type }));
    return fetch(url, { method: "POST", body: form });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-s3-"));
    const e = env();
    const s3 = new S3Client({ region: e.S3_REGION, endpoint: e.S3_ENDPOINT, forcePathStyle: e.S3_FORCE_PATH_STYLE, credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } });
    await s3.send(new CreateBucketCommand({ Bucket: e.S3_BUCKET })).catch((err) => { if (!/BucketAlready/.test(String(err.name))) throw err; });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("signs a policy tied to this key, type, exact size and a short expiry", async () => {
    const { fields } = await presignUpload(key, "video/mp4", 1234);
    const policy = JSON.parse(Buffer.from(fields.Policy!, "base64").toString());
    expect(policy.conditions).toEqual(expect.arrayContaining([["content-length-range", 1234, 1234], ["eq", "$Content-Type", "video/mp4"], { key }]));
    const ttl = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(UPLOAD_URL_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(UPLOAD_URL_TTL_SECONDS + 5);
  });

  it("stores an upload made with the signed form, and reports its size", async () => {
    expect(await storedSize(key)).toBeNull();
    const body = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const res = await post(key, body, body.length);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(await storedSize(key)).toBe(5000);
  });

  it("downloads for the worker, and refuses objects over the cap", async () => {
    const store = s3Store(env());
    const dest = join(dir, "dl");
    expect(await store.download(key, dest, 5000)).toBe(5000);
    expect(readFileSync(dest)[250]).toBe(250);
    await expect(store.download(key, join(dir, "dl2"), 100)).rejects.toBeInstanceOf(TooLargeError);
  });

  it.skipIf(!enforces)("refuses a file whose size differs from the declared size", async () => {
    const k = `workspaces/w/assets/${crypto.randomUUID()}/source`;
    const res = await post(k, new Uint8Array(100), 50);
    expect([400, 403]).toContain(res.status);
    expect(await storedSize(k)).toBeNull();
  });

  it.skipIf(!enforces)("refuses a different content type than the one signed", async () => {
    const k = `workspaces/w/assets/${crypto.randomUUID()}/source`;
    const res = await post(k, new Uint8Array(10), 10, "application/x-msdownload");
    expect(res.ok).toBe(false);
    expect(await storedSize(k)).toBeNull();
  });
});
