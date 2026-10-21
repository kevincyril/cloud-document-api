import { RequestHandler } from "express";

export const validateDocument: RequestHandler = (req, res, next) => {
  if (!req.file) { next(); return; }
  const { buffer, mimetype, originalname } = req.file;
  if (originalname.length > 255 || /[\x00-\x1f\x7f]/.test(originalname)) {
    res.status(400).json({ status: "error", message: "Invalid document filename" });
    return;
  }
  if (mimetype === "application/pdf") {
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      res.status(415).json({ status: "error", message: "File content does not match the PDF type" });
      return;
    }
  } else if (mimetype === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) throw new Error("Binary content");
    } catch {
      res.status(415).json({ status: "error", message: "Text documents must contain valid UTF-8 text" });
      return;
    }
  }
  next();
};
