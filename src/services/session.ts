import { randomBytes, timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export const sessionCookie = config.NODE_ENV === "production" ? "__Host-return_keeper" : "return_keeper";
const options = { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "strict" as const, path: "/" };
export function cookieToken(req: Request): string | undefined {
  const value = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1);
  if (!value || value.length > 4096) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}
export function issueSession(res: Response, user: { id: string; role: string }) {
  const csrfToken = randomBytes(32).toString("hex");
  const token = jwt.sign({ userId: user.id, role: user.role, csrf: csrfToken }, process.env.JWT_SECRET!, { algorithm: "HS256", expiresIn: "1h" });
  const expiresAt = (jwt.decode(token) as jwt.JwtPayload).exp! * 1000;
  res.cookie(sessionCookie, token, { ...options, maxAge: 3600000 });
  return { token, cookieSession: true, csrfToken, expiresAt };
}
export function clearSession(res: Response) { res.clearCookie(sessionCookie, options); }
export function validCsrf(actual: unknown, expected: unknown): boolean {
  return typeof actual === "string" && typeof expected === "string" && /^[a-f0-9]{64}$/.test(actual) && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
