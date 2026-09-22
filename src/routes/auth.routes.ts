import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../database";

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
});

router.post("/register", async (req, res) => {
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

    console.error("Registration error:", error);

    res.status(500).json({
      status: "error",
      message: "Unable to register user",
    });
  }
});

export default router;