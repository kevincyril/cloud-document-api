import { Router } from "express";
import { z } from "zod";
import { pool } from "../database";
import { authenticate } from "../middleware/auth.middleware";
import { purchaseWriteLimiter } from "../middleware/rate-limit.middleware";
import { amountToMinor, purchaseSchema, PurchaseInput } from "../services/purchases";
import { purchaseCalendar } from "../services/calendar";

const router = Router();
router.use(authenticate);
// Cast DATE columns explicitly: pg's default DATE parser creates local-midnight
// Date objects, which can change the date when serialized in another timezone.
const columns = `id, merchant, purchase_date::text, amount_minor::text, currency,
 description, policy_notes, receipt_document_id, policy_document_id, raw_ocr_text,
 suggestions, deadline_source, deadline_date::text, return_window_days,
 purchase_day_counts, deadline_confirmed_at, returned, revision, created_at, updated_at`;
const fields = ["merchant", "purchase_date", "amount_minor", "currency", "description", "policy_notes", "receipt_document_id", "policy_document_id", "raw_ocr_text", "suggestions", "deadline_source", "deadline_date", "return_window_days", "purchase_day_counts", "deadline_confirmed_at", "returned"];
function values(p: PurchaseInput) {
  const d = p.deadline;
  return [p.merchant, p.purchaseDate, p.amount !== null && p.currency !== null ? amountToMinor(p.amount, p.currency) : null,
    p.currency, p.description, p.policyNotes, p.receiptDocumentId, p.policyDocumentId, p.rawOcrText,
    JSON.stringify(p.suggestions), d.source, d.source === "none" ? null : d.date,
    d.source === "window" ? d.days : null, d.source === "window" ? d.purchaseDayCounts : null,
    d.source === "none" ? null : new Date(), p.returned];
}
function isForeignKeyError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
}
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  returned: z.enum(["true", "false"]).optional(),
}).strict();
router.get("/", async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ status: "error", message: "Invalid purchase filters or pagination" }); return; }
  const { limit, offset, returned } = parsed.data;
  try {
    const result = await pool.query(`SELECT ${columns} FROM purchases WHERE user_id = $1
      AND ($2::boolean IS NULL OR returned = $2) ORDER BY deadline_date ASC NULLS LAST, id ASC LIMIT $3 OFFSET $4`,
    [req.user!.userId, returned ?? null, limit, offset]);
    res.json({ status: "ok", purchases: result.rows, pagination: { limit, offset } });
  } catch (error) { next(error); }
});
router.get("/:id", async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ status: "error", message: "Invalid purchase ID" }); return; }
  try {
    const result = await pool.query(`SELECT ${columns} FROM purchases WHERE id = $1 AND user_id = $2`, [id.data, req.user!.userId]);
    if (!result.rowCount) { res.status(404).json({ status: "error", message: "Purchase not found" }); return; }
    res.json({ status: "ok", purchase: result.rows[0] });
  } catch (error) { next(error); }
});
router.get("/:id/calendar", async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ status: "error", message: "Invalid purchase ID" }); return; }
  try {
    const result = await pool.query(`SELECT merchant, deadline_date::text, deadline_confirmed_at FROM purchases WHERE id = $1 AND user_id = $2`, [id.data, req.user!.userId]);
    const purchase = result.rows[0];
    if (!purchase) { res.status(404).json({ status: "error", message: "Purchase not found" }); return; }
    if (!purchase.deadline_date || !purchase.deadline_confirmed_at) { res.status(409).json({ status: "error", message: "Confirm a deadline before adding it to a calendar" }); return; }
    res.attachment(`return-deadline-${id.data}.ics`).type("text/calendar").send(purchaseCalendar(id.data, purchase.merchant, purchase.deadline_date));
  } catch (error) { next(error); }
});
router.post("/", purchaseWriteLimiter, async (req, res, next) => {
  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ status: "error", message: "Invalid purchase; review fields and explicitly confirm any deadline", issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) }); return; }
  try {
    // Composite foreign keys enforce document ownership atomically, including
    // races with attachment deletion; no object storage writes occur here.
    const args = [req.user!.userId, ...values(parsed.data)];
    const result = await pool.query(`INSERT INTO purchases (user_id, ${fields.join(", ")})
      VALUES (${args.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${columns}`, args);
    res.status(201).json({ status: "ok", purchase: result.rows[0] });
  } catch (error) {
    if (isForeignKeyError(error)) { res.status(400).json({ status: "error", message: "An attached document is unavailable" }); return; }
    next(error);
  }
});
// Full replacement requires a freshly confirmed deadline. Requiring the current
// revision prevents a stale browser tab from overwriting more recent edits.
router.put("/:id", purchaseWriteLimiter, async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const revision = z.number().int().min(1).max(2147483646).safeParse(req.body?.revision);
  const { revision: ignored, ...body } = req.body && typeof req.body === "object" ? req.body : {};
  const parsed = purchaseSchema.safeParse(body);
  if (!id.success || !revision.success || !parsed.success) {
    res.status(400).json({ status: "error", message: "Invalid purchase, revision, or unconfirmed deadline",
      issues: parsed.success ? [] : parsed.error.issues.map(i => ({ path: i.path, message: i.message })) }); return;
  }
  try {
    const args = values(parsed.data);
    args.push(id.data, req.user!.userId, revision.data);
    const result = await pool.query(`UPDATE purchases SET ${fields.map((f, i) => `${f} = $${i + 1}`).join(", ")},
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $17 AND user_id = $18 AND revision = $19 RETURNING ${columns}`, args);
    if (!result.rowCount) {
      const existing = await pool.query("SELECT id FROM purchases WHERE id = $1 AND user_id = $2", [id.data, req.user!.userId]);
      res.status(existing.rowCount ? 409 : 404).json({ status: "error", message: existing.rowCount ? "Purchase changed; reload before saving" : "Purchase not found" }); return;
    }
    res.json({ status: "ok", purchase: result.rows[0] });
  } catch (error) {
    if (isForeignKeyError(error)) { res.status(400).json({ status: "error", message: "An attached document is unavailable" }); return; }
    next(error);
  }
});
export default router;
