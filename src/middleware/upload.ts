import multer from "multer";

const allowedMimeTypes = ["application/pdf", "text/plain"];

export class UnsupportedFileTypeError extends Error {
  constructor() {
    super("Only PDF and text files are allowed");
  }
}

export const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 2,
  },

  fileFilter: (_req, file, callback) => {
    if (allowedMimeTypes.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new UnsupportedFileTypeError());
    }
  },
});
