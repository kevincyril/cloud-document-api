import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { cookieToken, validCsrf } from "../services/session";

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authorizationHeader = req.headers.authorization;

  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.substring(7) : !authorizationHeader ? cookieToken(req) : undefined;
  if (!token) {
    res.status(401).json({
      status: "error",
      message: "Authentication token is required",
    });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured");

    res.status(500).json({
      status: "error",
      message: "Authentication is not configured",
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });

    if (
      typeof decoded === "string" ||
      typeof decoded.userId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.userId) ||
      (decoded.role !== "user" && decoded.role !== "admin")
    ) {
      res.status(401).json({
        status: "error",
        message: "Invalid authentication token",
      });
      return;
    }

    if (!authorizationHeader && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !validCsrf(req.headers["x-csrf-token"], decoded.csrf)) {
      res.status(403).json({ status: "error", message: "Session security check failed. Refresh and try again." }); return;
    }
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
    };

    next();
  } catch {
    res.status(401).json({
      status: "error",
      message: "Invalid or expired authentication token",
    });
  }
}
export function authorize(...allowedRoles: string[]) {
  return (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      res.status(401).json({
        status: "error",
        message: "Authentication is required",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        status: "error",
        message: "You do not have permission to perform this action",
      });
      return;
    }

    next();
  };
}
