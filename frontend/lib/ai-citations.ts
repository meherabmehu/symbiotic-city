/**
 * Citation view models for the AI features.
 *
 * Kept out of the React layer so it can be unit-tested directly: this is where
 * the duplicate-key bug lived (`entity_type + "-" + entity_id` collapses when a
 * plan assigns the same asset three times), and where an unsafe link would be
 * built if a citation's entity type or id were ever taken on trust.
 *
 * Two rules hold here:
 *
 * 1. Every rendered citation gets a key unique within the list, derived from
 *    its position. Repeated references to one entity are *kept* -- they are
 *    separate assignments -- and distinguished by an occurrence marker.
 * 2. A link is built only for a known entity type with a numeric id, so an
 *    unknown type or a hostile id renders as plain text instead of a URL.
 */

export interface AiCitationLike {
  entity_type: string;
  entity_id: string | number;
  label: string;
  snippet?: string;
}

export interface CitationView {
  /** Unique within the citation list, including repeats of one entity. */
  key: string;
  /** A same-origin application path, or null when no safe route exists. */
  href: string | null;
  /** Human name of the entity kind ("Asset", "Incident", ...). */
  typeLabel: string;
  /** Meaningful name, e.g. "HO-01 — Aurora Central Hospital". */
  label: string;
  /** Secondary line, e.g. the assignment rationale from the backend. */
  detail?: string;
  /** 1-based position among citations of the same entity, only when repeated. */
  occurrence?: number;
  /** How many citations share this entity, only when repeated. */
  occurrences?: number;
}

/** Routes a citation may link to. Anything absent renders as plain text. */
const CITATION_ROUTES: Record<string, (id: string) => string> = {
  asset: (id) => `/infrastructure/${id}`,
  incident: (id) => `/incidents/${id}`,
  task: (id) => `/tasks/${id}`,
  optimization_plan: (id) => `/optimization/plans/${id}`,
};

const TYPE_LABELS: Record<string, string> = {
  asset: "Asset",
  incident: "Incident",
  task: "Repair task",
  optimization_plan: "Plan",
};

const NUMERIC_ID = /^\d+$/;

/** Safe application path for a citation, or null. */
export function citationHref(entityType: string, entityId: string | number): string | null {
  const build = CITATION_ROUTES[entityType];
  if (!build) return null;
  const raw = String(entityId ?? "").trim();
  if (!NUMERIC_ID.test(raw)) return null;
  return build(raw);
}

/** Human label for an entity kind, falling back to a title-cased type. */
export function citationTypeLabel(entityType: string): string {
  const known = TYPE_LABELS[entityType];
  if (known) return known;
  if (!entityType) return "Record";
  return entityType.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detailOf(citation: AiCitationLike): string | undefined {
  const snippet = (citation.snippet ?? "").trim();
  return snippet.length > 0 ? snippet : undefined;
}

/**
 * Turn backend citations into render-ready views with unique keys.
 *
 * The key is `type:id:index`; the index makes it unique even when the same
 * asset appears five times, while repeated entities also receive an
 * occurrence marker ("2 of 3") so an operator can tell the assignments apart.
 */
export function buildCitationViews(citations: readonly AiCitationLike[]): CitationView[] {
  const totals = new Map<string, number>();
  for (const citation of citations) {
    const identity = `${citation.entity_type}:${citation.entity_id}`;
    totals.set(identity, (totals.get(identity) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return citations.map((citation, index) => {
    const identity = `${citation.entity_type}:${citation.entity_id}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    const occurrences = totals.get(identity) ?? 1;

    const view: CitationView = {
      key: `${identity}:${index}`,
      href: citationHref(citation.entity_type, citation.entity_id),
      typeLabel: citationTypeLabel(citation.entity_type),
      label: citation.label,
    };
    const detail = detailOf(citation);
    if (detail) view.detail = detail;
    if (occurrences > 1) {
      view.occurrence = occurrence;
      view.occurrences = occurrences;
    }
    return view;
  });
}

/** "2 of 3" for repeated citations, null for a single mention. */
export function occurrenceText(view: CitationView): string | null {
  if (!view.occurrence || !view.occurrences || view.occurrences < 2) return null;
  return `${view.occurrence} of ${view.occurrences}`;
}
