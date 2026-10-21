import { ErrorRequestHandler } from "express";
import multer from "multer";
import { UnsupportedFileTypeError } from "./upload";
import { StorageUnavailableError } from "../services/storage-provider";

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  // A download may fail after its response has started. Express must finish it.
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof UnsupportedFileTypeError) {
    res.status(415).json({ status: "error", message: error.message });
    return;
  }

  if (error instanceof StorageUnavailableError) {
    res.status(503).json({ status: "error", message: "Document storage is unavailable" });
    return;
  }

  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 400).json({
      status: "error",
      message: tooLarge
        ? "Document must be 5 MB or smaller"
        : "Invalid file upload; use a single file in the document field",
    });
    return;
  }

  // express.json() tags parsing errors; never echo the submitted body.
  if (error instanceof Error && "type" in error) {
    if (error.type === "entity.parse.failed") {
      res.status(400).json({ status: "error", message: "Invalid JSON request body" });
      return;
    }
    if (error.type === "entity.too.large") {
      res.status(413).json({ status: "error", message: "Request body is too large" });
      return;
    }
  }

  // Do not log raw errors: they can contain SQL, credentials, or request data.
  console.error("Unhandled request error");
  res.status(500).json({ status: "error", message: "An unexpected error occurred" });
};
