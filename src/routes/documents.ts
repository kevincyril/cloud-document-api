import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware";
import { upload } from "../middleware/upload";
import { pool } from "../database";
import { analyzeText } from "../services/text-processing";
import {
  saveFile,
  deleteFile,
  getFilePath,
  readTextFile,
} from "../services/storage";
const router = Router();

router.post(
  "/upload",
  authenticate,
  upload.single("document"),
  async (req, res, next) => {
    if (!req.file) {
      res.status(400).json({
        status: "error",
        message: "A document file is required",
      });
      return;
    }

    try {
      const storageKey = await saveFile(req.file.buffer);

      let document;

      try {
        const result = await pool.query(
          `INSERT INTO documents
             (user_id, original_name, mime_type, size_bytes, storage_key)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, original_name, mime_type, size_bytes,
                     status, created_at`,
          [
            req.user!.userId,
            req.file.originalname,
            req.file.mimetype,
            req.file.size,
            storageKey,
          ],
        );

        document = result.rows[0];
      } catch (databaseError) {
        try {
          await deleteFile(storageKey);
        } catch (cleanupError) {
          console.error("Failed to clean up uploaded file:", cleanupError);
        }

        throw databaseError;
      }

      res.status(201).json({
        status: "ok",
        message: "Document uploaded successfully",
        document,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get("/", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, original_name, mime_type, size_bytes,
              status, created_at
       FROM documents
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.userId],
    );

    res.status(200).json({
      status: "ok",
      documents: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", authenticate, async (req, res, next) => {
  const documentId = req.params.id;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (typeof documentId !== "string" || !uuidPattern.test(documentId)) {
    res.status(400).json({
      status: "error",
      message: "Invalid document ID",
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, original_name, mime_type, size_bytes,
              status, created_at, extracted_text,
              word_count, character_count, processed_at
       FROM documents
       WHERE id = $1 AND user_id = $2`,
      [documentId, req.user!.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        status: "error",
        message: "Document not found",
      });
      return;
    }

    res.status(200).json({
      status: "ok",
      document: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/download", authenticate, async (req, res, next) => {
  const documentId = req.params.id;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (typeof documentId !== "string" || !uuidPattern.test(documentId)) {
    res.status(400).json({
      status: "error",
      message: "Invalid document ID",
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT original_name, storage_key
       FROM documents
       WHERE id = $1 AND user_id = $2`,
      [documentId, req.user!.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        status: "error",
        message: "Document not found",
      });
      return;
    }

    const document = result.rows[0];
    const filePath = getFilePath(document.storage_key);

    res.download(filePath, document.original_name, (error) => {
      if (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/process", authenticate, async (req, res, next) => {
  const documentId = req.params.id;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (typeof documentId !== "string" || !uuidPattern.test(documentId)) {
    res.status(400).json({
      status: "error",
      message: "Invalid document ID",
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, mime_type, storage_key
       FROM documents
       WHERE id = $1 AND user_id = $2`,
      [documentId, req.user!.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        status: "error",
        message: "Document not found",
      });
      return;
    }

    const document = result.rows[0];

    if (document.mime_type !== "text/plain") {
      res.status(415).json({
        status: "error",
        message: "Processing currently supports only text files",
      });
      return;
    }

    const text = await readTextFile(document.storage_key);
    const analysis = analyzeText(text);

    const savedResult = await pool.query(
      `UPDATE documents
   SET extracted_text = $1,
       word_count = $2,
       character_count = $3,
       processed_at = CURRENT_TIMESTAMP,
       status = 'completed',
       updated_at = CURRENT_TIMESTAMP
   WHERE id = $4 AND user_id = $5
   RETURNING id`,
      [
        analysis.text,
        analysis.wordCount,
        analysis.characterCount,
        documentId,
        req.user!.userId,
      ],
    );

    if (savedResult.rows.length === 0) {
      res.status(404).json({
        status: "error",
        message: "Document not found",
      });
      return;
    }

    res.status(200).json({
      status: "ok",
      documentId: document.id,
      analysis,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
