/** A PDF page, or a complete text file with no PDF page number. */
export interface ExtractedUnit {
  pageNumber: number | null;
  text: string;
}

export interface ExtractedDocument {
  text: string;
  units: ExtractedUnit[];
  /** False means no non-whitespace text, not a diagnosis of an image-only PDF. */
  hasExtractableText: boolean;
}

// Upload content validation remains responsible for rejecting invalid UTF-8.
export function extractTextDocument(text: string): ExtractedDocument {
  return {
    text,
    units: [{ pageNumber: null, text }],
    hasExtractableText: text.trim().length > 0,
  };
}
