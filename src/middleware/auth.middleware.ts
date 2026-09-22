import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authorizationHeader = req.headers.authorization;

  if (
    !authorizationHeader ||
    !authorizationHeader.startsWith("Bearer ")
  ) {
    res.status(401).json({
      status: "error",
      message: "Authentication token is required",
    });
    return;
  }

  const token = authorizationHeader.substring(7);
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
    const decoded = jwt.verify(token, jwtSecret);

    if (
      typeof decoded === "string" ||
      typeof decoded.userId !== "string" ||
      typeof decoded.role !== "string"
    ) {
      res.status(401).json({
        status: "error",
        message: "Invalid authentication token",
      });
      return;
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