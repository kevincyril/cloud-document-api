import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const configuration = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_SSL: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),
  UPLOAD_DIR: z.string().min(1).default("uploads"),
});

const parsed = configuration.safeParse(process.env);
if (!parsed.success) {
  // Zod issues can include input values; report only variable names.
  throw new Error(`Invalid configuration: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
}
export const config = parsed.data;

export function validateServerConfiguration(): void {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
  if (config.NODE_ENV === "production") {
    if (Buffer.byteLength(process.env.JWT_SECRET) < 32) {
      throw new Error("JWT_SECRET must be at least 32 bytes in production");
    }
    if (config.STORAGE_DRIVER !== "supabase") {
      throw new Error("Production requires durable Supabase storage");
    }
    if (config.DB_SSL !== "true") throw new Error("Production requires DB_SSL=true");
  }
  if (config.STORAGE_DRIVER === "supabase") {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"]) {
      if (!process.env[key]) throw new Error(`${key} is required for Supabase storage`);
    }
  }
}
