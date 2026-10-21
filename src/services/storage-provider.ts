import path from "node:path";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

export interface StorageProvider {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor() { super("Document storage is unavailable"); }
}

export function createLocalStorage(directory: string): StorageProvider {
  return {
    async put(key, buffer) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, key), buffer, { flag: "wx" });
    },
    async get(key) { return readFile(path.join(directory, key)); },
    async remove(key) { await unlink(path.join(directory, key)); },
  };
}

export function createSupabaseStorage(url: string, secret: string, bucket: string): StorageProvider {
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      }),
    },
  });
  const files = client.storage.from(bucket);
  return {
    async put(key, buffer, contentType) {
      const { error } = await files.upload(key, buffer, { contentType, upsert: false });
      if (error) throw new StorageUnavailableError();
    },
    async get(key) {
      const { data, error } = await files.download(key);
      if (error || !data) throw new StorageUnavailableError();
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(key) {
      const { error } = await files.remove([key]);
      if (error) throw new StorageUnavailableError();
    },
  };
}
