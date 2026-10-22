import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../database";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { managedAuthRouter } from "./managed-auth";
import { loginLimiter, registrationLimiter } from "../middleware/rate-limit.middleware";
import {
  authenticate,
  authorize,
} from "../middleware/auth.middleware";

const router = Router();
router.use(managedAuthRouter);
router.use(["/register", "/login"], (_req, res, next) => {
  if (config.AUTH_MODE === "supabase") { res.status(410).json({ message: "Use verified email or a configured sign-in provider." }); return; }
  next();
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes"),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes"),
});

router.post("/register", registrationLimiter, async (req, res) => {
  const validation = registerSchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({
      status: "error",
      message: "Invalid registration data",
      errors: validation.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, password } = validation.data;
  const email = validation.data.email.toLowerCase();

  try {
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      res.status(409).json({
        status: "error",
        message: "An account with this email already exists",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    );

    res.status(201).json({
      status: "success",
      message: "User registered successfully",
      user: result.rows[0],
    });
  } catch (error) {
    const databaseError = error as { code?: string };

    if (databaseError.code === "23505") {
      res.status(409).json({
        status: "error",
        message: "An account with this email already exists",
      });
      return;
    }

    console.error("Registration database operation failed");

    res.status(500).json({
      status: "error",
      message: "Unable to register user",
    });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  const validation = loginSchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({
      status: "error",
      message: "Invalid login data",
      errors: validation.error.flatten().fieldErrors,
    });
    return;
  }

  const email = validation.data.email.toLowerCase();
  const { password } = validation.data;

  try {
    const result = await pool.query(
      `SELECT id, name, email, password_hash, role
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        status: "error",
        message: "Incorrect email or password",
      });
      return;
    }

    const user = result.rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      res.status(401).json({
        status: "error",
        message: "Incorrect email or password",
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      throw new Error("JWT_SECRET is not configured");
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      jwtSecret,
      {
        expiresIn: "1h",
      }
    );

    res.status(200).json({
      status: "success",
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login operation failed");

    res.status(500).json({
      status: "error",
      message: "Unable to log in",
    });
  }
});

router.get("/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE id = $1`,
      [req.user!.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        status: "error",
        message: "User not found",
      });
      return;
    }

    res.status(200).json({
      status: "success",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("User profile database operation failed");

    res.status(500).json({
      status: "error",
      message: "Unable to retrieve user profile",
    });
  }
});

router.get(
  "/admin-test",
  authenticate,
  authorize("admin"),
  (_req, res) => {
    res.status(200).json({
      status: "success",
      message: "You have access to the admin endpoint",
    });
  }
);

export default router;
