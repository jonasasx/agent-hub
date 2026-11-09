// S3 bucket of the hub (design D7): raw transcript segments, content-addressed blobs, side files.
// Only the hub talks to S3; agents never get AWS credentials (Goals).
import { DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Keys under a prefix, sorted. */
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
  /** Health check (/healthz). */
  check(): Promise<void>;
}

/** Where the store is and how to sign in to it; only `region` — AWS with the SDK's default credential chain. */
export interface S3Location {
  region: string;
  /** S3-compatible endpoint (MinIO, Ceph RGW and others). */
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}

/** The S3 client of a location: static keys only when both are given, otherwise the default chain. */
export function createS3Client(loc: S3Location): S3Client {
  const credentials = loc.accessKeyId && loc.secretAccessKey ? { accessKeyId: loc.accessKeyId, secretAccessKey: loc.secretAccessKey } : undefined;
  return new S3Client({
    region: loc.region,
    ...(loc.endpoint ? { endpoint: loc.endpoint } : {}),
    ...(loc.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
}

export class S3Store implements ObjectStore {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    /** All keys are written under this prefix (`test/` for the integration check). */
    private readonly prefix = '',
    client?: S3Client,
  ) {
    // Without a client (tests, tools): AWS by region, credentials from the SDK's default chain. The hub passes createS3Client.
    this.s3 = client ?? new S3Client({ region });
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.k(prefix), ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key.slice(this.prefix.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const part = keys.slice(i, i + 1000);
      if (part.length) await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: part.map(key => ({ Key: this.k(key) })) } }));
    }
  }

  async check(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/** In-process store for tests and local runs without S3. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  puts = 0;

  put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    this.puts++;
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.objects.get(key)?.body ?? null);
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter(k => k.startsWith(prefix)).sort());
  }
  delete(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve();
  }
  check(): Promise<void> {
    return Promise.resolve();
  }
}
