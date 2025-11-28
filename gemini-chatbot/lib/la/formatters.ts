// lib/la/formatters.ts
import type { OverlayCard } from "./types"; // adjust path if needed

type ZoningSummary = {
  jurisdiction?: string;
  baseZone?: string;
  fullZoneLabel?: string;
  notes?: string;
};

type AssessorSummary = {
  ain?: string;
  apn?: string;
  situsAddress?: string;
  useCode?: string;
  useDescription?: string;
};

export function renderZoningSection(z: ZoningSummary | null | undefined): string {
  if (!z) return "";
  const lines: string[] = ["Zoning:"];

  if (z.jurisdiction)  lines.push(`JURISDICTION: ${z.jurisdiction}`);
  if (z.baseZone)      lines.push(`BASE_ZONE: ${z.baseZone}`);
  if (z.fullZoneLabel) lines.push(`ZONE_LABEL: ${z.fullZoneLabel}`);
  if (z.notes)         lines.push(`NOTES: ${z.notes}`);

  return lines.join("\n");
}

export function renderOverlaysSection(overlays: OverlayCard[] | null | undefined): string {
  if (!overlays || overlays.length === 0) {
    return "Overlays:\nNONE_FOUND: true";
  }

  const lines: string[] = ["Overlays:"];

  overlays.forEach((ov, idx) => {
    const n = idx + 1;
    const src =
      ov.source === "City"
        ? "LA City"
        : ov.source === "County"
        ? "LA County"
        : ov.source;

    lines.push(`OVERLAY_${n}_SOURCE: ${src}`);
    lines.push(`OVERLAY_${n}_PROGRAM: ${ov.program}`);
    lines.push(`OVERLAY_${n}_NAME: ${ov.name}`);

    if (ov.details) {
      lines.push(`OVERLAY_${n}_DETAILS: ${ov.details}`);
    }

    // Add ONE or TWO important attributes here if you want
    // Example:
    if (ov.attributes?.CPA) lines.push(`OVERLAY_${n}_CPA: ${ov.attributes.CPA}`);

    lines.push(""); // blank line break
  });

  return lines.join("\n").trimEnd();
}

export function renderAssessorSection(a: AssessorSummary | null | undefined): string {
  if (!a) return "";
  const lines: string[] = ["Assessor:"];

  if (a.ain)           lines.push(`AIN: ${a.ain}`);
  if (a.apn)           lines.push(`APN: ${a.apn}`);
  if (a.situsAddress)  lines.push(`ADDRESS: ${a.situsAddress}`);
  if (a.useCode)       lines.push(`USE_CODE: ${a.useCode}`);
  if (a.useDescription)lines.push(`USE_DESC: ${a.useDescription}`);

  return lines.join("\n");
}

export function buildStructuredSections(opts: {
  zoning?: ZoningSummary | null;
  overlays?: OverlayCard[] | null;
  assessor?: AssessorSummary | null;
}): string {
  const blocks: string[] = [];

  const z = renderZoningSection(opts.zoning);
  if (z) blocks.push(z);

  const o = renderOverlaysSection(opts.overlays ?? []);
  if (o) blocks.push(o);

  const a = renderAssessorSection(opts.assessor);
  if (a) blocks.push(a);

  return blocks.join("\n\n");
}
