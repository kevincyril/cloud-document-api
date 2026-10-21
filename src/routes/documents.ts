import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth.middleware";
import { upload } from "../middleware/upload";
import { pool } from "../database";
import { extractTextDocument, ExtractedDocument } from "../services/document-extraction";
import { claimDocumentProcessing, saveDocumentResults } from "../services/document-results";
import {
  saveFile,
  deleteFile,
  readTextFile,
  readFileBuffer,
} from "../services/storage";
import { extractPdfDocument } from "../services/pdf-processing";
import { FormatError, InvalidPDFException, PasswordException } from "pdf-parse";
import { uploadLimiter, processingLimiter } from "../middleware/rate-limit.middleware";
import { validateDocument } from "../middleware/validate-document";
const router = Router();
const paginationSchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(50),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(10000)).default(0),
});

router.post(
  "/upload",
  authenticate,
  uploadLimiter,
  upload.single("document"),
  validateDocument,
  async (req, res, next) => {
    if (!req.file) {
      res.status(400).json({
        status: "error",
        message: "A document file is required",
      });
      return;
    }

    try {
      const storageKey = await saveFile(req.file.buffer, req.file.mimetype);

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
          console.error("Failed to clean up uploaded file");
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
  const pagination = paginationSchema.safeParse(req.query);
  if (!pagination.success) {
    res.status(400).json({ status: "error", message: "Invalid pagination: limit must be 1-100 and offset 0-10000" });
    return;
  }
  const { limit, offset } = pagination.data;
  try {
    const result = await pool.query(
      `SELECT id, original_name, mime_type, size_bytes,
              status, created_at
       FROM documents
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user!.userId, limit, offset],
    );

    res.status(200).json({
      status: "ok",
      documents: result.rows,
      pagination: { limit, offset },
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
      [documentId, req.user!.userId],
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

router.get("/:id/units/:unitIndex", authenticate, async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const unit = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100000)).safeParse(req.params.unitIndex);
  if (!id.success || !unit.success) {
    res.status(400).json({ status: "error", message: "Invalid document ID or unit index" });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT p.document_id, p.unit_index, p.page_number, p.text
       FROM document_pages p JOIN documents d ON d.id = p.document_id
       WHERE d.id = $1 AND d.user_id = $2 AND p.unit_index = $3 AND d.status = 'completed'`,
      [id.data, req.user!.userId, unit.data],
    );
    if (!result.rowCount) { res.status(404).json({ status: "error", message: "Document unit not found" }); return; }
    res.json({ status: "ok", unit: result.rows[0] });
  } catch (error) { next(error); }
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
      `SELECT original_name, storage_key, mime_type
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
    const buffer = await readFileBuffer(document.storage_key);
    res.attachment(document.original_name);
    res.type(document.mime_type);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/process", authenticate, processingLimiter, async (req, res, next) => {
  const documentId = req.params.id;
  let claimed = false;

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

    if (!["text/plain", "application/pdf"].includes(document.mime_type)) {
      res.status(415).json({
        status: "error",
        message: "Processing supports only text and PDF files",
      });
      return;
    }

    // PostgreSQL checks and changes the status in one operation. Only one
    // request can claim the row, even when multiple API processes are running.
    const claimedNow = await claimDocumentProcessing(documentId, req.user!.userId);

    if (!claimedNow) {
      const existing = await pool.query(
        "SELECT id FROM documents WHERE id = $1 AND user_id = $2",
        [documentId, req.user!.userId],
      );
      res.status(existing.rows.length === 0 ? 404 : 409).json({
        status: "error",
        message: existing.rows.length === 0
          ? "Document not found"
          : "Document is already processing",
      });
      return;
    }
    claimed = true;

    let extraction: ExtractedDocument;
    if (document.mime_type === "text/plain") {
      extraction = extractTextDocument(await readTextFile(document.storage_key));
    } else {
      extraction = await extractPdfDocument(await readFileBuffer(document.storage_key));
    }
    const analysis = await saveDocumentResults(documentId, req.user!.userId, extraction);
    if (!analysis) {
      res.status(404).json({ status: "error", message: "Document not found" });
      return;
    }
    claimed = false;

    res.status(200).json({
      status: "ok",
      documentId: document.id,
      analysis,
      message: extraction.hasExtractableText
        ? "Document processed and searchable"
        : "No extractable text found. Scanned PDFs require OCR, which is not supported.",
    });
  } catch (error) {
    if (claimed) {
      try {
        await pool.query(
          `UPDATE documents
           SET status = 'failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND user_id = $2 AND status = 'processing'`,
          [documentId, req.user!.userId],
        );
      } catch {
        // Preserve the original error if the database is also unavailable.
        console.error("Failed to save document processing failure");
      }
    }

    if (
      error instanceof InvalidPDFException ||
      error instanceof PasswordException ||
      error instanceof FormatError
    ) {
      res.status(422).json({
        status: "error",
        message: error instanceof PasswordException
          ? "Password-protected PDFs are not supported"
          : "The PDF is invalid or damaged",
      });
      return;
    }
    next(error);
  }
});

export default router;
