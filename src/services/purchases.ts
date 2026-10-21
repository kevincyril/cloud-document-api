import { z } from "zod";

const DAY = 86_400_000;
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31") return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export const calendarDate = z.string().refine(isCalendarDate, "Use a real date in YYYY-MM-DD format (1900-9999)");

// Explicit initial currency support, including zero- and three-decimal currencies.
export const currencyDigits = { USD: 2, CAD: 2, EUR: 2, GBP: 2, AUD: 2, JPY: 0, KWD: 3 } as const;
export type Currency = keyof typeof currencyDigits;
export function amountToMinor(amount: string, currency: Currency): string {
  const digits = currencyDigits[currency];
  const pattern = new RegExp(`^(0|[1-9]\\d{0,8})${digits ? `(\\.\\d{1,${digits}})?` : ""}$`);
  if (!pattern.test(amount)) throw new Error("Invalid amount or precision for currency");
  const [whole, fraction = ""] = amount.split(".");
  return (BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0")).toString();
}
export function calculateDeadline(date: string, days: number, purchaseDayCounts: boolean): string {
  if (!isCalendarDate(date) || !Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Invalid return window");
  const result = new Date(Date.parse(`${date}T00:00:00Z`) + (days - (purchaseDayCounts ? 1 : 0)) * DAY).toISOString().slice(0, 10);
  if (!isCalendarDate(result)) throw new Error("Deadline is outside supported dates");
  return result;
}
export function deadlineState(deadline: string | null, today: string, returned: boolean) {
  if (!isCalendarDate(today) || (deadline !== null && !isCalendarDate(deadline))) throw new Error("Invalid calendar date");
  if (returned) return { status: "returned", daysRemaining: null };
  if (!deadline) return { status: "no_deadline", daysRemaining: null };
  const daysRemaining = (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY;
  return { status: daysRemaining < 0 ? "deadline_passed" : daysRemaining === 0 ? "due_today" : daysRemaining <= 7 ? "due_soon" : "upcoming", daysRemaining };
}

const deadlineSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("none") }).strict(),
  z.object({ source: z.literal("manual"), date: calendarDate, confirmed: z.literal(true) }).strict(),
  z.object({ source: z.literal("window"), date: calendarDate, days: z.number().int().min(1).max(3650), purchaseDayCounts: z.boolean(), confirmed: z.literal(true) }).strict(),
]);
const suggestionsSchema = z.object({
  merchant: z.string().max(160).nullable().optional(),
  purchaseDate: z.string().max(40).nullable().optional(),
  amount: z.string().max(40).nullable().optional(),
  currency: z.string().max(10).nullable().optional(),
  warnings: z.array(z.string().max(200)).max(20).optional(),
}).strict();
export const purchaseSchema = z.object({
  merchant: z.string().trim().min(1).max(160),
  purchaseDate: calendarDate.nullable(),
  amount: z.string().max(20).nullable(),
  currency: z.enum(["USD", "CAD", "EUR", "GBP", "AUD", "JPY", "KWD"]).nullable(),
  description: z.string().trim().max(500).default(""),
  policyNotes: z.string().trim().max(2000).default(""),
  receiptDocumentId: z.string().uuid().nullable().default(null),
  policyDocumentId: z.string().uuid().nullable().default(null),
  rawOcrText: z.string().max(30000).default(""),
  suggestions: suggestionsSchema.default({}),
  deadline: deadlineSchema,
  returned: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  const invalid = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  // PostgreSQL text/JSONB cannot represent NUL; reject before persistence so
  // untrusted OCR produces a validation response rather than a database error.
  const containsNul = (input: unknown): boolean => typeof input === "string"
    ? input.includes("\0")
    : input !== null && typeof input === "object" && Object.values(input).some(containsNul);
  if (containsNul(value)) invalid("input", "Text must not contain NUL characters");
  if ((value.amount === null) !== (value.currency === null)) invalid("amount", "Amount and currency must both be supplied or both be null");
  if (value.amount !== null && value.currency !== null) {
    try { amountToMinor(value.amount, value.currency); } catch { invalid("amount", "Invalid amount or precision for currency"); }
  }
  if (value.deadline.source === "window") {
    try {
      if (!value.purchaseDate || calculateDeadline(value.purchaseDate, value.deadline.days, value.deadline.purchaseDayCounts) !== value.deadline.date) {
        invalid("deadline", "Review the calculated date and confirm it explicitly");
      }
    } catch { invalid("deadline", "Invalid calculated deadline"); }
  }
  if (value.deadline.source !== "none" && value.purchaseDate && value.deadline.date < value.purchaseDate) invalid("deadline", "Deadline cannot precede purchase date");
});
export type PurchaseInput = z.infer<typeof purchaseSchema>;
