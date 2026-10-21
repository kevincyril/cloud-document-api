import { PDFParse } from "pdf-parse";
import type { ExtractedDocument } from "./document-extraction";

export async function extractPdfDocument(buffer: Buffer): Promise<ExtractedDocument> {
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
  });

  try {
    // Page labels are parser-generated text and should not affect our counts.
    const result = await parser.getText({ pageJoiner: "" });

    return {
      // Preserve the existing combined text/count behavior for API consumers.
      text: result.text,
      units: result.pages.map(page => ({ pageNumber: page.num, text: page.text })),
      hasExtractableText: result.pages.some(page => page.text.trim().length > 0),
    };
  } finally {
    await parser.destroy();
  }
}

// Existing processing route keeps its string-returning contract.
export async function extractPdfText(buffer: Buffer): Promise<string> {
  return (await extractPdfDocument(buffer)).text;
}
