import { PDFParse } from "pdf-parse";

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
  });

  try {
    // Page labels are parser-generated text and should not affect our counts.
    const result = await parser.getText({ pageJoiner: "" });

    return result.text;
  } finally {
    await parser.destroy();
  }
}
