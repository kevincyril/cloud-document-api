import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../config";
import { createLocalStorage, createSupabaseStorage, StorageProvider, StorageUnavailableError } from "./storage-provider";

const uploadDirectory = path.resolve(config.UPLOAD_DIR);
let provider: StorageProvider;

function getProvider(): StorageProvider {
  if (!provider) {
    if (config.STORAGE_DRIVER === "supabase") {
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET } = process.env;
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_STORAGE_BUCKET) {
        throw new StorageUnavailableError();
      }
      provider = createSupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET);
    } else {
      provider = createLocalStorage(uploadDirectory);
    }
  }
  return provider;
}

function validateStorageKey(key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    throw new Error("Invalid storage key");
  }
}

export async function saveFile(
  buffer: Buffer,
  contentType = "application/octet-stream",
): Promise<string> {
  const storageKey = randomUUID();
  await getProvider().put(storageKey, buffer, contentType);

  return storageKey;
}

export async function deleteFile(storageKey: string): Promise<void> {
  validateStorageKey(storageKey);
  await getProvider().remove(storageKey);
}

export function getFilePath(storageKey: string): string {
  validateStorageKey(storageKey);
  if (config.STORAGE_DRIVER !== "local") throw new Error("Cloud objects do not have local paths");
  return path.join(uploadDirectory, storageKey);
}

export async function readTextFile(storageKey: string): Promise<string> {
  return (await readFileBuffer(storageKey)).toString("utf8");
}

export async function readFileBuffer(storageKey: string): Promise<Buffer> {
  validateStorageKey(storageKey);
  return getProvider().get(storageKey);
}
