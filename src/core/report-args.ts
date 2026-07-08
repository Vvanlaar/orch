// Report-generation options and their CLI mapping for report.mjs.
//
// Kept in its own module (rather than inline in videoscan-runner.ts) so the
// pure arg-mapping can be unit-tested without importing that module's heavy
// graph (playwright, supabase client) or its import-time mkdirSync side effect.

export interface ReportOptions {
  orgName?: string;
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** URL path sections (first segment) to omit from the "Selectie van pagina's"
   *  example table only — they still count in stats and the section overview. */
  excludeExampleSections?: string[];
}

export function reportOptionsToArgs(options?: ReportOptions): string[] {
  if (!options) return [];
  const args: string[] = [];
  // Pass raw values — spawn() is called with an args array and NO shell, so each
  // element is one argv entry (spaces preserved). Do NOT wrap in quotes: without
  // a shell to strip them, quotes become literal chars and corrupt the value
  // (e.g. an image URL would arrive as `"https://…"` → url('"…"') → broken).
  if (options.orgName) args.push('--org-name', options.orgName);
  if (options.coverImageUrl) args.push('--cover-image', options.coverImageUrl);
  if (options.contactImageUrl) args.push('--contact-image', options.contactImageUrl);
  if (options.contactName) args.push('--contact-name', options.contactName);
  if (options.contactPhone) args.push('--contact-phone', options.contactPhone);
  if (options.contactEmail) args.push('--contact-email', options.contactEmail);
  if (options.excludeExampleSections?.length)
    args.push('--exclude-example-sections', options.excludeExampleSections.join(','));
  return args;
}
