import { rateLimit } from "express-rate-limit";

const minute = 60 * 1000;
const message = {
  status: "error",
  message: "Too many requests; try again later",
};
const commonOptions = {
  standardHeaders: "draft-8" as const,
  legacyHeaders: false,
  message,
};

// Before login, only the connection's IP is available. Keep separate budgets
// so registration attempts do not consume the login allowance.
export const loginLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * minute,
  limit: 20,
});

export const registrationLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * minute,
  limit: 5,
});

// These must run AFTER authenticate. Use only the verified JWT identity,
// never an ID submitted in the body, query string, or upload form.
export const uploadLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * minute,
  limit: 20,
  keyGenerator: (req) => req.user!.userId,
});

export const processingLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * minute,
  limit: 20,
  keyGenerator: (req) => req.user!.userId,
});

export const searchLimiter = rateLimit({
  ...commonOptions,
  windowMs: minute,
  limit: 60,
  keyGenerator: (req) => req.user!.userId,
});
