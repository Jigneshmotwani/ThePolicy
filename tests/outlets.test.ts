import { describe, expect, it } from "vitest";
import { countIndependentOutlets, independentGroups, qualifies, type OutletReport } from "@/pipeline/outlets";
import { fingerprint, fingerprintSimilarity } from "@/lib/text";
import { buildFactSheet } from "@/pipeline/factChecker";
import { Meter } from "@/lib/llm";
import { scriptedLlm } from "./helpers";

let nextId = 1;
const report = (outletId: string, extra: Partial<OutletReport> = {}): OutletReport => ({
  id: nextId++, outletId, wireAgency: null, fingerprint: null, ...extra,
});
const isContent = (id: string) => ["toi", "ht", "ie"].includes(id);

const COPY =
  "The state government on Tuesday announced a relief package of five hundred crore rupees for farmers hit by unseasonal rain " +
  "across eleven districts, the chief minister told reporters after a cabinet meeting in the capital. Officials said crop loss " +
  "surveys would be completed within two weeks and payments would be credited directly to bank accounts of affected cultivators " +
  "before the end of the month, with priority given to small and marginal farmers who lost more than a third of their standing crop.";

describe("outlet-count rule", () => {
  it("one outlet is one outlet, however many reports it files", () => {
    expect(countIndependentOutlets([report("toi"), report("toi"), report("toi")])).toBe(1);
  });

  it("a single-outlet event does not qualify", () => {
    const q = qualifies([report("toi"), report("toi")], 2, isContent);
    expect(q.ok).toBe(false);
    expect(q.count).toBe(1);
  });

  it("two distinct outlets with their own reporting qualify", () => {
    const q = qualifies([report("toi"), report("ht")], 2, isContent);
    expect(q).toMatchObject({ ok: true, count: 2 });
  });

  it("counts each outlet once across many reports", () => {
    expect(countIndependentOutlets([report("toi"), report("ht"), report("ht"), report("ndtv")])).toBe(3);
  });

  it("respects a higher MIN_OUTLETS", () => {
    expect(qualifies([report("toi"), report("ht")], 3, isContent).ok).toBe(false);
    expect(qualifies([report("toi"), report("ht"), report("hindu")], 3, isContent).ok).toBe(true);
  });

  it("corroboration-only outlets cannot carry a story between themselves", () => {
    const q = qualifies([report("ndtv"), report("hindu")], 2, isContent);
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/content outlet/);
  });

  it("an empty event does not qualify", () => {
    expect(qualifies([], 2, isContent).ok).toBe(false);
  });
});

describe("wire-copy rule", () => {
  it("the same PTI copy on two sites counts as one outlet", () => {
    const reports = [report("toi", { wireAgency: "PTI" }), report("ht", { wireAgency: "PTI" })];
    expect(countIndependentOutlets(reports)).toBe(1);
    const q = qualifies(reports, 2, isContent);
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/same wire copy/);
  });

  it("ANI copy on three sites is still one outlet", () => {
    expect(countIndependentOutlets([
      report("toi", { wireAgency: "ANI" }), report("ht", { wireAgency: "ANI" }), report("ndtv", { wireAgency: "ANI" }),
    ])).toBe(1);
  });

  it("wire copy plus one outlet's own report is two", () => {
    expect(countIndependentOutlets([report("toi", { wireAgency: "PTI" }), report("ht", { wireAgency: "PTI" }), report("ie")])).toBe(2);
  });

  it("different agencies are different sources", () => {
    expect(countIndependentOutlets([report("toi", { wireAgency: "PTI" }), report("ht", { wireAgency: "ANI" })])).toBe(2);
  });

  it("near-identical text counts as one outlet even with no agency credit", () => {
    const a = fingerprint(COPY);
    const b = fingerprint(COPY.replace("on Tuesday", "on Tuesday evening"));
    expect(fingerprintSimilarity(a, b)).toBeGreaterThan(0.6);
    expect(countIndependentOutlets([report("toi", { fingerprint: a }), report("ie", { fingerprint: b })])).toBe(1);
  });

  it("independently written reports of the same event stay separate", () => {
    const a = fingerprint(COPY);
    const b = fingerprint(
      "Farmers in eleven rain-hit districts will receive compensation under a package worth Rs 500 crore cleared by the cabinet. " +
      "The chief minister said surveys of damaged fields are under way and that money will reach accounts this month. Opposition " +
      "leaders called the amount inadequate and demanded a full loan waiver for growers in the worst affected talukas of the region.",
    );
    expect(fingerprintSimilarity(a, b)).toBeLessThan(0.3);
    expect(countIndependentOutlets([report("toi", { fingerprint: a }), report("ie", { fingerprint: b })])).toBe(2);
  });

  it("is strict when links chain: an outlet's own report does not rescue its wire copy", () => {
    // TOI staff report + TOI's PTI copy + HT's PTI copy => all one group.
    const groups = independentGroups([report("toi"), report("toi", { wireAgency: "PTI" }), report("ht", { wireAgency: "PTI" })]);
    expect(groups).toHaveLength(1);
  });
});

describe("fact sheet keeps only claims two independent outlets support", () => {
  const toi = report("toi");
  const ht = report("ht");
  const htWire = report("ht", { wireAgency: "PTI" });
  const ieWire = report("ie", { wireAgency: "PTI" });

  it("drops single-outlet claims, same-wire claims and conflicting claims", async () => {
    const llm = scriptedLlm(() => ({
      facts: [
        { text: "Two outlets agree on this.", support: ["R1.1", "R2.1"], role: "core" },
        { text: "Only one outlet says this.", support: ["R1.2"], role: "supporting" },
        { text: "Only the two PTI copies say this.", support: ["R3.1", "R4.1"], role: "supporting" },
        { text: "The outlets disagree on the toll.", support: ["R1.3", "R2.2"], role: "supporting" },
        { text: "The model invented support.", support: ["R9.9"], role: "supporting" },
      ],
      conflicts: [{ note: "Toll given as 4 and as 6", claims: ["R1.3", "R2.2"] }],
    }));
    const sheet = await buildFactSheet(llm, new Meter(), [
      { report: toi, claims: ["a", "b", "toll 4"] },
      { report: ht, claims: ["a", "toll 6"] },
      { report: htWire, claims: ["c"] },
      { report: ieWire, claims: ["c"] },
    ], 2);
    expect(sheet.facts.map((f) => f.text)).toEqual(["Two outlets agree on this."]);
    expect(sheet.facts[0].reportIds.sort()).toEqual([toi.id, ht.id].sort());
    expect(sheet.conflicts).toHaveLength(1);
  });

  it("keeps an undisputed detail of a bundled claim, but not the disputed point itself", async () => {
    const llm = scriptedLlm(() => ({
      conflicts: [{ note: "Number injured: two or three", claims: ["R1.1", "R2.1"] }],
      facts: [
        { text: "An attack took place in Kulgam on Wednesday.", support: ["R1.1", "R2.1", "R2.2"], role: "core" },
        { text: "Three people were injured.", support: ["R1.1", "R2.1"], role: "supporting" },
      ],
    }));
    const sheet = await buildFactSheet(llm, new Meter(), [
      { report: toi, claims: ["Three were injured in an attack in Kulgam on Wednesday."] },
      { report: ht, claims: ["Two were injured in an attack in Kulgam.", "The attack was on Wednesday."] },
    ], 2);
    expect(sheet.facts.map((f) => f.text)).toEqual(["An attack took place in Kulgam on Wednesday."]);
    expect(sheet.conflicts.map((c) => c.text)).toEqual(["Number injured: two or three"]);
  });

  it("does not even ask the model when only one independent outlet has claims", async () => {
    const llm = scriptedLlm(() => ({ facts: [], conflicts: [] }));
    const sheet = await buildFactSheet(llm, new Meter(), [{ report: htWire, claims: ["c"] }, { report: ieWire, claims: ["c"] }], 2);
    expect(sheet.facts).toEqual([]);
    expect(llm.calls).toBe(0);
  });
});
