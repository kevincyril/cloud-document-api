import { isCalendarDate } from "./purchases";

function escapeText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}
function fold(line: string): string {
  const parts: string[] = []; let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > 75) { parts.push(current); current = " "; }
    current += character;
  }
  return [...parts, current].join("\r\n");
}
export function purchaseCalendar(id: string, merchant: string, date: string, now = new Date()): string {
  if (!/^[a-f0-9-]{36}$/i.test(id) || !isCalendarDate(date)) throw new Error("Invalid calendar input");
  // RFC 5545: a DATE DTSTART with no DTEND/DURATION lasts one calendar day.
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Return Keeper//Return Deadline//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${id}@return-keeper`, `DTSTAMP:${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
    `DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`, `SUMMARY:${escapeText(`Return deadline: ${merchant}`)}`,
    "DESCRIPTION:User-confirmed deadline. Check the applicable return policy and conditions. This calendar event does not schedule an app notification.",
    "TRANSP:TRANSPARENT", "END:VEVENT", "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}
