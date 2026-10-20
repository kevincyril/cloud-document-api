import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";

const uploadDirectory = path.resolve("uploads");

export async function saveFile(
  buffer: Buffer
): Promise<string> {
  await mkdir(uploadDirectory, { recursive: true });

  const storageKey = randomUUID();
  const filePath = path.join(uploadDirectory, storageKey);

  await writeFile(filePath, buffer, { flag: "wx" });

  return storageKey;
}

export async function deleteFile(storageKey: string): Promise<void> {
  const filePath = path.join(uploadDirectory, storageKey);

  await unlink(filePath);
}