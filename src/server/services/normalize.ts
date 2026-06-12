/**
 * Normalization for accent-insensitive search (SPEC.md).
 *
 * `*_norm` companion columns store this form, written by the services on every
 * create/update; search input goes through the same function before matching.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
