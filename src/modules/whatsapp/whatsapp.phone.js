import { WA_CONFIG } from "./whatsapp.config.js";

/**
 * WhatsApp numbers are stored as E.164 digits without "+" (e.g. 919876543210).
 * Bare 10-digit Indian mobiles get the default country code. Returns "" when
 * the value cannot be a valid WhatsApp number.
 */
export function normalizeWaPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return "";
    return `${WA_CONFIG.defaultCountryCode}${digits}`;
  }
  if (digits.length < 11 || digits.length > 15) return "";
  return digits;
}

/** Last 10 digits — the format Leads/Admissions use for Indian mobiles. */
export function localPart(waPhone) {
  return String(waPhone || "").replace(/\D/g, "").slice(-10);
}

/**
 * Spellings of the same number that may exist in other modules' records
 * (they store phones inconsistently: 98…, 9198…, +9198…, 098…).
 */
export function phoneVariants(waPhone) {
  const full = normalizeWaPhone(waPhone);
  if (!full) return [];
  const local = localPart(full);
  return [...new Set([local, full, `+${full}`, `0${local}`, `+91 ${local}`, `91 ${local}`])];
}

export function maskPhone(waPhone) {
  const p = String(waPhone || "");
  return p.length > 4 ? `${"•".repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : p;
}
