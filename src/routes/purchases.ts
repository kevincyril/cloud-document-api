import { Router } from "express";
import { z } from "zod";
import { pool } from "../database";
import { authenticate } from "../middleware/auth.middleware";
import { purchaseWriteLimiter } from "../middleware/rate-limit.middleware";
import { amountToMinor, purchaseSchema, PurchaseInput, calendarDate } from "../services/purchases";
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
  q: z.string().trim().max(200).refine(value => !value.includes("\0")).default(""),
  status: z.enum(["all", "active", "due_soon", "deadline_passed", "no_deadline", "returned"]).default("all"),
  sort: z.enum(["deadline", "newest", "merchant"]).default("deadline"),
  today: calendarDate.optional(),
}).strict();
router.get(["/", "/export"], async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ status: "error", message: "Invalid purchase filters or pagination" }); return; }
  const { returned, q, status, sort, today } = parsed.data;
  const exporting = req.path === "/export";
  const limit = exporting ? 10001 : parsed.data.limit, offset = exporting ? 0 : parsed.data.offset;
  try {
    const order = sort === "newest" ? "created_at DESC, id ASC" : sort === "merchant" ? "lower(merchant) ASC, id ASC" : "deadline_date ASC NULLS LAST, id ASC";
    const pattern = q ? `%${q.replace(/[\\%_]/g, value => "\\" + value)}%` : null;
    const result = await pool.query(`WITH owned AS MATERIALIZED (SELECT id,merchant,description,policy_notes,returned,deadline_date,created_at FROM purchases WHERE user_id=$1),
      filtered AS (SELECT * FROM owned WHERE ($2::boolean IS NULL OR returned=$2)
        AND ($5::text IS NULL OR concat_ws(' ',merchant,description,policy_notes) ILIKE $5)
        AND (CASE $6::text WHEN 'active' THEN NOT returned WHEN 'returned' THEN returned
          WHEN 'due_soon' THEN NOT returned AND deadline_date BETWEEN COALESCE($7::date,CURRENT_DATE) AND COALESCE($7::date,CURRENT_DATE)+7
          WHEN 'deadline_passed' THEN NOT returned AND deadline_date<COALESCE($7::date,CURRENT_DATE)
          WHEN 'no_deadline' THEN NOT returned AND deadline_date IS NULL ELSE true END)),
      page AS (SELECT ${exporting ? "id,created_at,merchant,purchase_date::text,amount_minor::text,currency,deadline_date::text,returned,description,policy_notes" : columns} FROM purchases WHERE user_id=$1 AND id IN (SELECT id FROM filtered ORDER BY ${order} LIMIT $3 OFFSET $4) ORDER BY ${order})
      SELECT COALESCE((SELECT jsonb_agg(page ORDER BY ${order}) FROM page),'[]'::jsonb) AS purchases,
        (SELECT count(*)::int FROM filtered) AS total,
        (SELECT jsonb_build_object('active',count(*) FILTER(WHERE NOT returned),'returned',count(*) FILTER(WHERE returned),
          'dueSoon',count(*) FILTER(WHERE NOT returned AND deadline_date BETWEEN COALESCE($7::date,CURRENT_DATE) AND COALESCE($7::date,CURRENT_DATE)+7)) FROM owned) AS summary`,
    [req.user!.userId, returned ?? null, limit, offset, pattern, status, today ?? null]);
    const row = result.rows[0];
    if (exporting) {
      if (row.total > 10000) { res.status(422).json({ message: "Export is limited to 10,000 purchases. Narrow your search or status filter." }); return; }
      const { purchasesCsv } = require("../../public/receipt-utils.js") as { purchasesCsv: (values: unknown[]) => string };
      res.attachment("return-keeper-purchases.csv").type("text/csv").send(purchasesCsv(row.purchases)); return;
    }
    res.json({ status: "ok", purchases: row.purchases, summary: row.summary, pagination: { limit, offset, total: row.total, hasMore: offset + row.purchases.length < row.total } });
  } catch (error) { next(error); }
});
router.patch("/:id/returned", purchaseWriteLimiter, async (req, res, next) => {
  const id = z.uuid().safeParse(req.params.id);
  const input = z.object({ revision: z.number().int().min(1).max(2147483646), returned: z.boolean() }).strict().safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ message: "Invalid purchase or revision" }); return; }
  try {
    const result = await pool.query(`UPDATE purchases SET returned=$1,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND user_id=$3 AND revision=$4 RETURNING ${columns}`, [input.data.returned,id.data,req.user!.userId,input.data.revision]);
    if (!result.rowCount) {
      const exists = await pool.query("SELECT id FROM purchases WHERE id=$1 AND user_id=$2", [id.data,req.user!.userId]);
      res.status(exists.rowCount ? 409 : 404).json({ message: exists.rowCount ? "Purchase changed; refresh before trying again" : "Purchase not found" }); return;
    }
    res.json({ purchase: result.rows[0] });
  } catch (error) { next(error); }
});
router.delete("/:id", purchaseWriteLimiter, async (req, res, next) => {
  const id = z.uuid().safeParse(req.params.id);
  const input = z.object({ revision: z.number().int().min(1) }).strict().safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ message: "Invalid purchase or revision" }); return; }
  try {
    const result = await pool.query("DELETE FROM purchases WHERE id=$1 AND user_id=$2 AND revision=$3 RETURNING id", [id.data,req.user!.userId,input.data.revision]);
    if (!result.rowCount) {
      const exists = await pool.query("SELECT id FROM purchases WHERE id=$1 AND user_id=$2", [id.data,req.user!.userId]);
      res.status(exists.rowCount ? 409 : 404).json({ message: exists.rowCount ? "Purchase changed; refresh before deleting" : "Purchase not found" }); return;
    }
    res.json({ status: "ok", message: "Purchase details deleted. Original documents were kept in your private library." });
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
