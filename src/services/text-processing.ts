export function analyzeText(text: string) {
  const trimmedText = text.trim();

  return {
    text,
    wordCount:
      trimmedText.length === 0
        ? 0
        : trimmedText.split(/\s+/).length,
    characterCount: Array.from(text).length,
  };
}