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
  AUTH_MODE: z.enum(["legacy", "supabase"]).default("legacy"),
  AUTH_EMAIL_ENABLED: z.enum(["true", "false"]).default("false"),
  AUTH_PROVIDERS: z.string().default(""),
  AUTH_PUBLIC_ENABLED: z.enum(["true", "false"]).default("false"),
  AUTH_ALLOWED_EMAILS: z.string().default(""),
  SUPABASE_PUBLISHABLE_KEY: z.string().default(""),
  SUPABASE_AUTH_URL: z.string().default(""),
  APP_URL: z.string().default(""),
});

const parsed = configuration.safeParse(process.env);
if (!parsed.success) {
  // Zod issues can include input values; report only variable names.
  throw new Error(`Invalid configuration: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
}
export const config = parsed.data;

export function validateServerConfiguration(): void {
  if (config.AUTH_MODE === "supabase") {
    const authUrl = new URL(config.SUPABASE_AUTH_URL);
    const appUrl = new URL(config.APP_URL);
    for (const url of [authUrl, appUrl]) {
      if (url.protocol !== "https:" && !(config.NODE_ENV !== "production" && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("Authentication URLs require HTTPS");
      if (url.username || url.password || url.search || url.hash) throw new Error("Invalid authentication URL");
    }
    if (!config.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) throw new Error("Use a Supabase publishable key for authentication");
    const providers = config.AUTH_PROVIDERS.split(",").filter(Boolean);
    if (providers.some(provider => !["google", "apple", "github"].includes(provider))) throw new Error("Invalid AUTH_PROVIDERS");
    if (!providers.length && config.AUTH_EMAIL_ENABLED !== "true") throw new Error("Enable an authentication provider");
    if (config.AUTH_ALLOWED_EMAILS.split(",").filter(Boolean).some(email => !z.email().safeParse(email.trim()).success)) throw new Error("Invalid AUTH_ALLOWED_EMAILS");
  }
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
