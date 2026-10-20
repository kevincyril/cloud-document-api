import multer from "multer";

const allowedMimeTypes = ["application/pdf", "text/plain"];

export const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (_req, file, callback) => {
    if (allowedMimeTypes.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new Error("Only PDF and text files are allowed"));
    }
  },
});