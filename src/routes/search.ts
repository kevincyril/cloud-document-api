import { Router } from "express";
import { z } from "zod";
import { pool } from "../database";
import { authenticate } from "../middleware/auth.middleware";
import { searchLimiter } from "../middleware/rate-limit.middleware";

const router = Router();
const searchSchema = z.object({
  q: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(20),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(1000)).default(0),
}).strict();

router.get("/", authenticate, searchLimiter, async (req, res, next) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: "error", message: "Search requires q (1-200 characters), limit (1-50), and offset (0-1000); no other parameters are accepted" });
    return;
  }
  const { q, limit, offset } = parsed.data;
  try {
    // MATERIALIZED limits excerpt generation to the requested, already-owned
    // matches. Headline markers are empty: excerpts are plain text, never HTML.
    const result = await pool.query(
      `WITH query AS (SELECT plainto_tsquery('english', $2) AS terms),
       matches AS MATERIALIZED (
         SELECT d.id AS document_id, d.original_name AS document_name,
                p.unit_index, p.page_number, p.text,
                ts_rank_cd(p.search_vector, query.terms) AS rank
         FROM document_pages p JOIN documents d ON d.id = p.document_id CROSS JOIN query
         WHERE d.user_id = $1 AND d.status = 'completed'
           AND p.search_vector @@ query.terms
         ORDER BY rank DESC, d.id, p.unit_index LIMIT $3 OFFSET $4
       )
       SELECT document_id, document_name, unit_index, page_number, rank,
              left(ts_headline('english', text, query.terms,
                'StartSel="", StopSel="", MaxWords=35, MinWords=15, MaxFragments=1'), 600) AS excerpt
       FROM matches CROSS JOIN query ORDER BY rank DESC, document_id, unit_index`,
      [req.user!.userId, q, limit + 1, offset],
    );
    res.json({ status: "ok", results: result.rows.slice(0, limit), pagination: { limit, offset, hasMore: result.rows.length > limit && offset + limit <= 1000 } });
  } catch (error) { next(error); }
});

export default router;
