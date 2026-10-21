import { pool } from "../database";
import type { ExtractedDocument } from "./document-extraction";
import { analyzeText } from "./text-processing";

/** Invalidate old results atomically with the processing claim. */
export async function claimDocumentProcessing(documentId: string, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `UPDATE documents SET status = 'processing', extracted_text = NULL,
       word_count = NULL, character_count = NULL, processed_at = NULL,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND status <> 'processing' RETURNING id`,
      [documentId, userId],
    );
    if (claimed.rowCount) {
      await client.query(
        `DELETE FROM document_pages p USING documents d
         WHERE p.document_id = d.id AND d.id = $1 AND d.user_id = $2`,
        [documentId, userId],
      );
    }
    await client.query("COMMIT");
    return claimed.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Publish pages, search vectors, counts, and completion in one transaction. */
export async function saveDocumentResults(documentId: string, userId: string, extraction: ExtractedDocument) {
  const analysis = analyzeText(extraction.text);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      "SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND status = 'processing' FOR UPDATE",
      [documentId, userId],
    );
    if (!owned.rowCount) { await client.query("ROLLBACK"); return null; }
    await client.query(
      `INSERT INTO document_pages (document_id, unit_index, page_number, text)
       SELECT d.id, u.unit_index, u.page_number, u.text
       FROM documents d CROSS JOIN jsonb_to_recordset($3::jsonb)
         AS u(unit_index integer, page_number integer, text text)
       WHERE d.id = $1 AND d.user_id = $2`,
      [documentId, userId, JSON.stringify(extraction.units.map((unit, index) => ({
        unit_index: index + 1, page_number: unit.pageNumber, text: unit.text,
      })))],
    );
    await client.query(
      `UPDATE documents SET extracted_text = $3, word_count = $4, character_count = $5,
       processed_at = CURRENT_TIMESTAMP, status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [documentId, userId, analysis.text, analysis.wordCount, analysis.characterCount],
    );
    await client.query("COMMIT");
    return analysis;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
