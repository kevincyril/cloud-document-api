import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { pool } from "../database";
import { loginLimiter } from "../middleware/rate-limit.middleware";

export const managedAuthRouter = Router();
managedAuthRouter.get("/config", (_req, res) => {
  res.json(config.AUTH_MODE === "legacy" ? { mode: "legacy" } : {
    mode: "supabase", url: config.SUPABASE_AUTH_URL, key: config.SUPABASE_PUBLISHABLE_KEY,
    providers: config.AUTH_PROVIDERS.split(",").filter(Boolean),
    emailEnabled: config.AUTH_EMAIL_ENABLED === "true", redirectTo: config.APP_URL,
    restricted: config.AUTH_PUBLIC_ENABLED !== "true",
  });
});
const input = z.object({ accessToken: z.string().min(1).max(16000), legacyPassword: z.string().min(1).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72).optional() });
managedAuthRouter.post("/exchange", loginLimiter, async (req, res) => {
  if (config.AUTH_MODE !== "supabase") { res.status(404).json({ message: "Managed sign-in is not enabled" }); return; }
  const parsed = input.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: "Invalid sign-in request" }); return; }
  try {
    // A new client per request; never trust browser-supplied profile or role claims.
    const auth = createClient(config.SUPABASE_AUTH_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) },
    });
    const { data, error } = await auth.auth.getUser(parsed.data.accessToken);
    if (error) { res.status(error.status && error.status < 500 ? 401 : 503).json({ message: "Unable to verify sign-in. Try again." }); return; }
    const identity = data.user;
    if (!identity || !z.uuid().safeParse(identity.id).success || !identity.email_confirmed_at || identity.is_anonymous || !z.email().max(255).safeParse(identity.email).success) {
      res.status(401).json({ message: "Verify your email before signing in." }); return;
    }
    const email = identity.email!.toLowerCase();
    if (config.AUTH_EMAIL_ENABLED !== "true") {
      // getUser above has authenticated this exact JWT with the Auth server.
      // In social-only mode, a password session must not bypass the UI setting.
      const claims = jwt.decode(parsed.data.accessToken) as { amr?: { method?: string }[] } | null;
      const providers = config.AUTH_PROVIDERS.split(",").filter(Boolean);
      if (!Array.isArray(claims?.amr) || !claims.amr.some(method => method.method === "oauth") || !identity.identities?.some(value => providers.includes(value.provider))) {
        res.status(403).json({ message: "Use one of the configured social sign-in providers." }); return;
      }
    }
    if (config.AUTH_PUBLIC_ENABLED !== "true" && !config.AUTH_ALLOWED_EMAILS.split(",").map(value => value.trim().toLowerCase()).includes(email)) {
      res.status(403).json({ message: "Sign-in is limited to invited testers while this release is being checked." }); return;
    }
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      // Serialize both identity and email to protect concurrent first sign-ins.
      for (const key of [email, identity.id].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      const linked = await client.query("SELECT id, name, email, role FROM users WHERE auth_user_id = $1", [identity.id]);
      user = linked.rows[0];
      if (!user) {
        const existing = (await client.query("SELECT * FROM users WHERE lower(email) = $1 FOR UPDATE", [email])).rows[0];
        if (existing) {
          if (existing.auth_user_id) { await client.query("ROLLBACK"); res.status(409).json({ message: "This workspace is linked to another identity. Contact support." }); return; }
          if (!parsed.data.legacyPassword) { await client.query("ROLLBACK"); res.status(428).json({ code: "link_required", message: "Enter your previous workspace password once to keep your existing receipts." }); return; }
          if (!await bcrypt.compare(parsed.data.legacyPassword, existing.password_hash)) { await client.query("ROLLBACK"); res.status(401).json({ message: "Incorrect previous workspace password" }); return; }
          user = (await client.query("UPDATE users SET auth_user_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, email, role", [identity.id, existing.id])).rows[0];
        } else {
          // Unusable random local password keeps the existing schema constraint intact.
          const hash = await bcrypt.hash(randomBytes(48).toString("base64url"), 12);
          const name = typeof identity.user_metadata?.name === "string" ? identity.user_metadata.name.trim().slice(0, 100) : "";
          user = (await client.query("INSERT INTO users (name,email,password_hash,auth_user_id) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role", [name || email.split("@")[0].slice(0, 100), email, hash, identity.id])).rows[0];
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { algorithm: "HS256", expiresIn: "1h" });
    res.json({ status: "success", token, user });
  } catch {
    console.error("Managed sign-in failed");
    res.status(503).json({ message: "Sign-in is temporarily unavailable. Please try again." });
  }
});
