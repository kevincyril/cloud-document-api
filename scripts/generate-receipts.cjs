// Synthetic fixtures, no personal or payment information. No runtime generation
// or hard-coded OCR results: deployed PNG/JPEG files use the real OCR path.
const sharp = require('sharp');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const directory = path.resolve(__dirname, '../public/samples');
  await mkdir(directory, { recursive: true });
  const lines = ['MAPLE GOODS', 'SYNTHETIC SAMPLE RECEIPT', 'DEMO ONLY - NO REAL TRANSACTION', '',
    'Purchase date: 2026-10-21', 'Canvas tote                 24.00', 'Notebook                     8.00',
    'Subtotal USD                32.00', 'Tax USD                      2.56', '', 'TOTAL USD 34.56', '',
    'Check the store return policy.', 'No return window is implied.', '', 'No personal or payment data.'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1500"><rect width="1100" height="1500" fill="white"/><g fill="#111" font-family="DejaVu Sans,Arial,sans-serif" font-size="36">${lines.map((line, i) => `<text x="72" y="${100 + i * 78}">${line}</text>`).join('')}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(directory, 'maple-goods.png'));
  // Different format and date ambiguity intentionally exercise conservative review.
  const ambiguous = svg.replace('MAPLE GOODS', 'CEDAR MARKET').replace('2026-10-21', '10/11/2026').replace('TOTAL USD 34.56', 'TOTAL $34.56').replaceAll(' USD ', '     ');
  await sharp(Buffer.from(ambiguous)).jpeg({ quality: 88 }).toFile(path.join(directory, 'cedar-market.jpg'));
}
main().catch(() => { console.error('Synthetic receipt generation failed'); process.exitCode = 1; });
