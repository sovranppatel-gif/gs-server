import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import multer from "multer";

const uploadRoot = path.join(process.cwd(), "uploads", "faculty");

function ensureUploadDir() {
  if (!fs.existsSync(uploadRoot)) {
    fs.mkdirSync(uploadRoot, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, uploadRoot);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    const safeExt = allowed.includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}${safeExt}`);
  },
});

// Mirrors the frontend's 400 KB guard — enforced independently here since the
// client-side check can be bypassed.
export const facultyPhotoUpload = multer({
  storage,
  limits: { fileSize: 400 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error("Only JPEG, PNG or WebP images are allowed"));
  },
});
