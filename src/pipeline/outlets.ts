import { fingerprintSimilarity } from "@/lib/text";
import { outletById } from "@config/sources";

/**
 * THE RULE the whole product rests on: how many *independent* outlets stand
 * behind a set of reports.
 *
 *  - Two reports from the same outlet are one outlet.
 *  - Reports credited to the same wire agency (PTI, ANI, ...) are one outlet,
 *    whichever sites carried them.
 *  - Reports whose text is near-identical are one outlet, credited or not.
 *
 * These links are transitive (if A and B share an outlet, and B and C are the
 * same PTI copy, then A, B and C count once). That is deliberately strict:
 * when in doubt we under-count, and the story waits.
 */

export interface OutletReport {
  id: number;
  outletId: string;
  wireAgency: string | null;
  fingerprint: number[] | null;
}

export const NEAR_IDENTICAL = 0.6;

export function independentGroups(reports: OutletReport[]): OutletReport[][] {
  const parent = reports.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const a = reports[i];
      const b = reports[j];
      if (
        a.outletId === b.outletId ||
        (a.wireAgency !== null && a.wireAgency === b.wireAgency) ||
        fingerprintSimilarity(a.fingerprint, b.fingerprint) >= NEAR_IDENTICAL
      ) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, OutletReport[]>();
  reports.forEach((r, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  return [...groups.values()];
}

export const countIndependentOutlets = (reports: OutletReport[]): number => independentGroups(reports).length;

export interface Qualification {
  ok: boolean;
  count: number;
  reason: string;
}

/**
 * An event qualifies once minOutlets independent outlets have reported it and
 * at least one of them is a content outlet (corroboration-only outlets cannot
 * carry a story between themselves).
 */
export function qualifies(
  reports: OutletReport[],
  minOutlets: number,
  isContentOutlet: (outletId: string) => boolean = (id) => outletById(id)?.role === "content",
): Qualification {
  const count = countIndependentOutlets(reports);
  if (count < minOutlets) {
    const sites = new Set(reports.map((r) => r.outletId)).size;
    const why =
      sites >= minOutlets
        ? `${sites} sites carried it, but the copy traces to ${count} independent source${count === 1 ? "" : "s"} (same wire copy)`
        : `${count} independent outlet${count === 1 ? "" : "s"} so far`;
    return { ok: false, count, reason: `${why}; needs ${minOutlets}` };
  }
  if (!reports.some((r) => isContentOutlet(r.outletId))) {
    return { ok: false, count, reason: "only corroboration-only outlets have reported it; needs a content outlet" };
  }
  return { ok: true, count, reason: `${count} independent outlets` };
}

export function toOutletReport(r: {
  id: number;
  outlet_id: string;
  wire_agency: string | null;
  fingerprint: string | null;
}): OutletReport {
  let fp: number[] | null = null;
  if (r.fingerprint) {
    try {
      fp = JSON.parse(r.fingerprint) as number[];
    } catch {
      fp = null;
    }
  }
  return { id: r.id, outletId: r.outlet_id, wireAgency: r.wire_agency, fingerprint: fp };
}
