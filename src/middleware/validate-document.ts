import { RequestHandler } from "express";
import sharp from "sharp";

// Validation decodes only bounded images. Keep originals unchanged in storage.
sharp.cache(false);
sharp.concurrency(1);
export const MAX_IMAGE_PIXELS = 12_000_000;
export const MAX_IMAGE_DIMENSION = 8000;

export const validateDocument: RequestHandler = async (req, res, next) => {
  if (!req.file) { next(); return; }
  const { buffer, mimetype, originalname } = req.file;
  if (originalname.length > 255 || /[\x00-\x1f\x7f]/.test(originalname)) {
    res.status(400).json({ status: "error", message: "Invalid document filename" });
    return;
  } else if (mimetype === "image/jpeg" || mimetype === "image/png") {
    try {
      const expected = mimetype === "image/jpeg" ? "jpeg" : "png";
      const image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
      const metadata = await image.metadata();
      if (metadata.format !== expected || !metadata.width || !metadata.height ||
          metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION ||
          metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages ?? 1) > 1) throw new Error("Invalid image");
      // metadata/signatures alone do not catch malformed or truncated bodies.
      await image.raw().toBuffer();
    } catch {
      res.status(415).json({ status: "error", message: "Use a valid, single-frame JPEG or PNG, at most 12 megapixels and 8000 pixels per side" });
      return;
    }
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
