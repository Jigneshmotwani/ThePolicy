"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { Overview, RunSheet, StoryRow } from "@/lib/console";

/**
 * The newsroom console: design/Admin.dc.html rebuilt on live data.
 * Everything shown is polled from /api/admin/*; every button is a POST there.
 */

const POLL_MS = 4000;
const AGENTS = ["Wire Scout", "Desk Sorter", "Fact Checker", "Rewrite Desk", "Copy Editor", "Picture Desk", "Press Room"];
const SHORT = ["Scout", "Sort", "Check", "Write", "Copy", "Picture", "Print"];
const FILTERS: [string, string][] = [
  ["desk", "On the desk now"], ["waiting", "Waiting"], ["held", "Held"], ["printed", "Printed"], ["spiked", "Spiked"], ["retracted", "Retracted"], ["all", "All"],
];
const DESKS: [string, string][] = [["india", "India"], ["world", "World"], ["business", "Business"], ["sport", "Sport"], ["entertainment", "Entertainment"]];
const END_LABEL: Record<string, string> = { printed: "Printed", spiked: "Spiked", retracted: "Retracted" };

const sans: CSSProperties = { fontFamily: "'Libre Franklin', Arial, sans-serif" };
const time = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : "";
const dur = (sec: number | null | undefined) => (sec == null ? "" : sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`);
function ago(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`;

class Unauthorized extends Error {}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401 && path !== "login") throw new Unauthorized();
  return (await res.json()) as T;
}
type Result = { ok: boolean; message: string };
type List = { filter: string; page: number; pages: number; total: number; rows: StoryRow[] };

export default function Console({ initialAuthed }: { initialAuthed: boolean }) {
  const [authed, setAuthed] = useState(initialAuthed);
  return authed ? <Desk onLoggedOut={() => setAuthed(false)} /> : <Login onDone={() => setAuthed(true)} />;
}

/* ------------------------------------------------------------------ login */

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await api<Result>("login", { password }).catch(() => ({ ok: false, message: "Could not reach the app." }));
    setBusy(false);
    if (res.ok) onDone();
    else setErr(res.message);
  };
  return (
    <div className="np console" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 style={{ margin: 0, fontFamily: "'UnifrakturCook', 'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 34, lineHeight: "44px", textAlign: "center" }}>The Second Source</h1>
        <div aria-hidden="true" style={{ height: 7, boxSizing: "border-box", borderTop: "3px solid var(--ink)", borderBottom: "1px solid var(--ink)" }} />
        <span className="lab" style={{ textAlign: "center" }}>Newsroom console</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="pw" className="lab" style={{ color: "var(--ink)" }}>Password</label>
          <input id="pw" className="field" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setErr(""); }} />
        </div>
        <button className="btn act solid" type="submit" disabled={busy || !password}>Open the console</button>
        {err && <p role="alert" className="alert" style={{ margin: 0 }}>{err}</p>}
      </form>
    </div>
  );
}

/* ---------------------------------------------------------------- console */

function Desk({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [list, setList] = useState<List | null>(null);
  const [sheet, setSheet] = useState<RunSheet | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [filter, setFilter] = useState("desk");
  const [desk, setDesk] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [flash, setFlash] = useState<Result | null>(null);
  const [lost, setLost] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const view = useRef({ filter, desk, q, page, sel });
  view.current = { filter, desk, q, page, sel };

  const load = useCallback(async () => {
    const v = view.current;
    try {
      const qs = new URLSearchParams({ filter: v.filter, page: String(v.page), ...(v.desk ? { desk: v.desk } : {}), ...(v.q.trim() ? { q: v.q.trim() } : {}) });
      const [o, l] = await Promise.all([api<Overview>("overview"), api<List>(`stories?${qs}`)]);
      setOv(o);
      setList(l);
      setLost(false);
      setNow(Date.now());
      // Keep a story selected: the chosen one, else the first row on view.
      const id = v.sel ?? l.rows[0]?.id ?? null;
      if (v.sel === null && id !== null) setSel(id);
      if (id !== null) {
        const s = await api<RunSheet | Result>(`stories/${id}`);
        if ("steps" in s && view.current.sel === id) setSheet(s);
      } else setSheet(null);
    } catch (e) {
      if (e instanceof Unauthorized) onLoggedOut();
      else setLost(true);
    }
  }, [onLoggedOut]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    load();
  }, [filter, desk, page, sel, load]);
  useEffect(() => {
    const t = setTimeout(load, 350); // search as you type, gently
    return () => clearTimeout(t);
  }, [q, load]);

  const post = async (path: string, body: unknown) => {
    try {
      const res = await api<Result>(path, body);
      setFlash(res);
      await load();
      return res;
    } catch (e) {
      if (e instanceof Unauthorized) onLoggedOut();
      else setFlash({ ok: false, message: "Could not reach the app." });
      return { ok: false, message: "" };
    }
  };
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 7000);
    return () => clearTimeout(t);
  }, [flash]);

  if (!ov || !list) {
    return <div className="np console" style={{ padding: 28 }}><p className="hint">{lost ? "Could not reach the app. Retrying…" : "Opening the console…"}</p></div>;
  }
  const stopped = ov.pressesStopped;
  const h = ov.health;
  const pick = (id: number) => {
    if (id === sel) return;
    setSel(id);
    setSheet(null);
  };
  const changeFilter = (f: string) => { setFilter(f); setPage(1); setSel(null); setSheet(null); };

  return (
    <div className={`np console${stopped ? " stopped" : ""}`}>
      <div style={{ maxWidth: 1360, margin: "0 auto", boxSizing: "border-box", padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

        <header>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px 24px", paddingBottom: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 16px" }}>
              <h1 style={{ margin: 0, fontFamily: "'UnifrakturCook', 'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 34, lineHeight: "44px" }}>The Second Source</h1>
              <span style={{ ...sans, fontSize: 12, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--soft)" }}>Newsroom console</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 18px" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9, ...sans, fontSize: 13, fontWeight: 500 }}>
                <span className="dot press" aria-hidden="true" />
                <span>{stopped ? "Presses stopped. Nothing new will print." : `Presses running. Feeds are read every ${ov.sweepMinutes} minutes.`}</span>
              </span>
              <button className={`btn act${stopped ? " solid" : ""}`} onClick={() => post("presses", { stopped: !stopped })}>{stopped ? "Restart the presses" : "Stop the presses"}</button>
              <button className="btn sans" style={{ fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3, minHeight: 44 }} onClick={async () => { await api("logout", {}).catch(() => null); onLoggedOut(); }}>Log out</button>
            </div>
          </div>
          <div aria-hidden="true" style={{ height: 7, boxSizing: "border-box", borderTop: "3px solid var(--ink)", borderBottom: "1px solid var(--ink)" }} />

          <div className="health" role="status" aria-label="Pipeline health">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className={`dot${h.workerAlive ? "" : " off"}`} aria-hidden="true" />
              <span>Worker <b>{h.workerAlive ? (h.workerState === "sweeping" ? "sweeping now" : "alive") : "not running"}</b></span>
            </span>
            <span>Last sweep <b>{h.lastSweep ? (h.lastSweep.running ? `started ${time(h.lastSweep.startedAt)}, running` : `${time(h.lastSweep.startedAt)} · ${h.lastSweep.error ? h.lastSweep.error : `took ${dur(h.lastSweep.seconds)}`}`) : "none yet"}</b></span>
            {h.lastSweep && !h.lastSweep.running && <span>Failures in it <b style={h.lastSweep.failed ? { color: "var(--accent)" } : undefined}>{h.lastSweep.failed}</b></span>}
            {h.nextSweepAt && h.workerState !== "sweeping" && <span>Next sweep <b>{time(h.nextSweepAt)}</b></span>}
            <span>Spend today <b style={h.budgetPaused ? { color: "var(--accent)" } : undefined}>{usd(h.spendToday)} of ${h.cap.toFixed(2)}</b></span>
            <span style={{ marginLeft: "auto" }}>
              <button className="btn act" style={{ minHeight: 36 }} disabled={!h.workerAlive || h.sweepRequested || h.workerState === "sweeping"} onClick={() => post("sweep", {})}>
                {h.sweepRequested ? "Sweep requested" : h.workerState === "sweeping" ? "Sweeping" : "Sweep now"}
              </button>
            </span>
          </div>
          {h.budgetPaused && <p role="alert" className="alert" style={{ margin: "8px 0 0" }}>Daily budget reached. Feeds are still read, but no stories are checked or written until {time(h.resumesAt)} IST (midnight).</p>}
          {!h.workerAlive && <p role="alert" className="alert" style={{ margin: "8px 0 0" }}>The worker is not running, so nothing is being read, checked or printed. Start it with “npm run worker”.</p>}
          {lost && <p role="alert" className="alert" style={{ margin: "8px 0 0" }}>Lost contact with the app. Showing the last figures; retrying.</p>}
          {flash && <p role="status" className="sans" style={{ margin: "8px 0 0", fontSize: 13, fontWeight: 600, color: flash.ok ? "var(--ink)" : "var(--accent)" }}>{flash.message}</p>}
        </header>

        <section aria-label="At a glance" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "16px 28px" }}>
          {([[ov.stats.onDesk, "On the desk"], [ov.stats.waiting, "Waiting for a second source"], [ov.stats.printedToday, "Printed today"], [ov.stats.spikedToday, "Spiked today"], [ov.stats.retractedToday, "Retracted today"]] as [number, string][]).map(([n, label]) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 12, borderBottom: "1px solid var(--rule)" }}>
              <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 900, fontSize: 42, lineHeight: "46px" }}>{n}</span>
              <span style={{ ...sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--soft)" }}>{label}</span>
            </div>
          ))}
        </section>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 32 }}>
          <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 28 }}>

            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "4px 16px" }}>
                <h2 className="h2">On the desk</h2>
                <span className="hint">Pick a story to open its run sheet.</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 12px", alignItems: "center" }}>
                <span style={{ display: "inline-flex", flexWrap: "wrap" }} role="group" aria-label="Show">
                  {FILTERS.map(([id, label]) => (
                    <button key={id} className={`btn seg${filter === id ? " on" : ""}`} style={{ minHeight: 36 }} aria-pressed={filter === id} onClick={() => changeFilter(id)}>{label}</button>
                  ))}
                </span>
                <select className="field" aria-label="Desk" style={{ width: 150, minHeight: 36 }} value={desk} onChange={(e) => { setDesk(e.target.value); setPage(1); }}>
                  <option value="">All desks</option>
                  {DESKS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <input className="field" aria-label="Search stories" type="search" placeholder="Search headlines" style={{ flex: "1 1 160px", width: "auto", minHeight: 36 }} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
              </div>
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 700 }}>
                  <div className="cols" style={{ padding: "8px 12px", borderTop: "1px solid var(--ink)", borderBottom: "1px solid var(--ink)", ...sans, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--soft)" }}>
                    <span>Story</span><span>Stage</span><span>Agent at work</span><span>Outlets</span><span>On desk</span>
                  </div>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {list.rows.map((r) => {
                      const live = r.status === "working" || r.status === "waiting" || r.status === "held";
                      return (
                        <li key={r.id} className={`cols row${r.id === sel ? " sel" : ""}`}>
                          <div style={{ minWidth: 0 }}>
                            <button className="btn ttl" aria-pressed={r.id === sel} onClick={() => pick(r.id)} style={{ display: "block", width: "100%", minHeight: 44, fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 17, lineHeight: "22px" }}>{r.title}</button>
                            <span style={{ ...sans, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent)" }}>{r.deskLabel}</span>
                            {r.fromEditor && <span className="tag">Sent by an editor</span>}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div aria-hidden="true" style={{ display: "flex", gap: 3 }}>
                              {AGENTS.map((a, i) => <span key={a} className={`pip${i < r.stage ? " on" : i === r.stage && live ? " now" : ""}`} />)}
                            </div>
                            <span style={{ ...sans, fontSize: 12, fontWeight: 500 }}>{live ? `${SHORT[Math.min(6, r.stage)]} · step ${Math.min(7, r.stage + 1)} of 7` : END_LABEL[r.status] ?? r.status}</span>
                          </div>
                          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ ...sans, fontSize: 13, fontWeight: 600 }}>{r.agent}</span>
                            <span style={{ fontSize: 13, fontStyle: "italic", color: "var(--soft)" }}>{stopped && r.status === "working" ? "Finishing; the press will hold it" : r.state}</span>
                            {r.status === "waiting" && <span className="meta">Rechecked {r.recheckCount}×{r.lastCheckedAt ? `, last ${time(r.lastCheckedAt)}` : ""}</span>}
                          </div>
                          <span style={{ ...sans, fontSize: 13, fontWeight: 500 }}>{r.outlets}</span>
                          <span style={{ ...sans, fontSize: 13, color: "var(--soft)" }}>{ago(r.createdAt, now)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {!list.rows.length && (
                    <p className="hint" style={{ margin: 0, padding: "18px 12px", borderBottom: "1px solid var(--rule)" }}>
                      {q.trim() ? "No story matches that search." : filter === "desk" ? "Nothing is on the desk right now. Stories appear here while the agents work on them, or when one is held for you." : "No stories here."}
                    </p>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, ...sans, fontSize: 13 }}>
                <span style={{ color: "var(--soft)" }}>{list.total} {list.total === 1 ? "story" : "stories"}{list.pages > 1 ? ` · page ${list.page} of ${list.pages}` : ""}</span>
                {list.pages > 1 && (
                  <span style={{ display: "inline-flex" }}>
                    <button className="btn seg" style={{ minHeight: 36 }} disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>Previous</button>
                    <button className="btn seg" style={{ minHeight: 36 }} disabled={list.page >= list.pages} onClick={() => setPage(list.page + 1)}>Next</button>
                  </span>
                )}
              </div>
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "4px 16px" }}>
                <h2 className="h2">Desk rules</h2>
                <span className="hint">Auto-print publishes once checks pass. Review first holds each story for your sign-off.</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0 32px", borderTop: "1px solid var(--ink)" }}>
                {ov.desks.map((d) => (
                  <div key={d.desk} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "8px 12px", padding: "8px 0", borderBottom: "1px solid var(--rule)" }}>
                    <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 17 }}>{d.label}</span>
                    <span style={{ display: "inline-flex" }}>
                      <button className={`btn seg${d.rule === "auto" ? " on" : ""}`} aria-pressed={d.rule === "auto"} onClick={() => d.rule !== "auto" && post("desks", { desk: d.desk, rule: "auto" })}>Auto-print</button>
                      <button className={`btn seg${d.rule === "review" ? " on" : ""}`} aria-pressed={d.rule === "review"} onClick={() => d.rule !== "review" && post("desks", { desk: d.desk, rule: "review" })}>Review first</button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", gap: 28 }}>
            <Sheet sheet={sheet} selected={sel !== null} post={post} />
            <Lead submissions={ov.submissions} post={post} pick={(id) => { setFilter("all"); setPage(1); pick(id); }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- run sheet */

function Sheet({ sheet, selected, post }: { sheet: RunSheet | null; selected: boolean; post: (path: string, body: unknown) => Promise<Result> }) {
  const [asking, setAsking] = useState<"" | "retract" | "spike">("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const id = sheet?.id;
  useEffect(() => { setAsking(""); setReason(""); setErr(""); }, [id]);

  const box: CSSProperties = { boxSizing: "border-box", padding: "18px 20px 20px", background: "var(--panel)", border: "1px solid var(--rule)", display: "flex", flexDirection: "column", gap: 10 };
  if (!sheet) {
    return (
      <section aria-label="Run sheet" style={box}>
        <span className="lab">Run sheet</span>
        <p className="hint" style={{ margin: 0 }}>{selected ? "Opening…" : "Pick a story from the table to see its seven steps, its fact sheet and its article."}</p>
      </section>
    );
  }
  const act = (action: string, why = "") => post(`stories/${sheet.id}/action`, { action, reason: why });
  const confirm = async () => {
    if (asking === "retract" && !reason.trim()) return setErr("Give a reason. It is kept with the story.");
    const res = await act(asking, reason.trim());
    if (res.ok) { setAsking(""); setReason(""); }
  };
  const roleLabel: Record<string, string> = { core: "Core", supporting: "Supporting", background: "Background" };

  return (
    <section aria-label="Run sheet" style={box}>
      <span className="lab">Run sheet · {sheet.deskLabel} · story {sheet.id}</span>
      <h2 style={{ margin: 0, fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 800, fontSize: 22, lineHeight: "27px" }}>{sheet.title}</h2>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: "21px", fontStyle: "italic", color: "var(--soft)" }}>{sheet.statusLine}</p>
      {sheet.status === "waiting" && <span className="meta">Rechecked {sheet.recheckCount}×{sheet.lastCheckedAt ? `, last at ${time(sheet.lastCheckedAt)}` : ""}. Expires {time(sheet.expiresAt)} if nothing new is reported.</span>}

      <ol style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
        {sheet.steps.map((s) => {
          const tokens = s.promptTokens + s.completionTokens;
          const meta = [
            s.startedAt && s.mark !== "idle" ? time(s.startedAt) : "",
            s.seconds != null && s.mark !== "idle" ? `took ${dur(s.seconds)}` : "",
            s.model ?? "",
            tokens ? `${tokens.toLocaleString("en-IN")} tokens` : "",
            s.costUsd ? usd(s.costUsd) : "",
            s.runs > 1 ? `${s.runs} runs` : "",
          ].filter(Boolean).join(" · ");
          return (
            <li key={s.agent} style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", columnGap: 12, alignItems: "start", padding: "10px 0", borderTop: "1px solid var(--rule)" }}>
              <span className={`mk ${s.mark === "idle" ? "" : s.mark}`} aria-hidden="true" style={{ marginTop: 4 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ ...sans, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>{s.agent}</span>
                <span style={{ fontSize: 14, lineHeight: "20px", color: "var(--soft)", overflowWrap: "anywhere" }}>{s.note}</span>
                {meta && <span className="meta">{meta}</span>}
              </div>
              <span style={{ ...sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: s.mark === "failed" ? "var(--accent)" : "var(--soft)" }}>{s.status}</span>
            </li>
          );
        })}
      </ol>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 6 }}>
        {sheet.can.approve && <button className="btn act solid" onClick={() => act("approve")}>{sheet.can.approveLabel}</button>}
        {sheet.can.hold && <button className="btn act" onClick={() => act("hold")}>Hold for review</button>}
        {sheet.can.retract && <button className="btn act" onClick={() => { setAsking("retract"); setErr(""); }}>Retract</button>}
        {sheet.can.spike && <button className="btn act" onClick={() => { setAsking("spike"); setErr(""); }}>Spike story</button>}
      </div>
      {asking && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="why" className="lab" style={{ color: "var(--ink)" }}>{asking === "retract" ? "Reason for the retraction" : "Reason (optional)"}</label>
          <input id="why" className="field" autoFocus value={reason} onChange={(e) => { setReason(e.target.value); setErr(""); }} maxLength={300} placeholder={asking === "retract" ? "It leaves the feed as soon as you confirm" : "Why this will not run"} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn act solid" onClick={confirm}>{asking === "retract" ? "Retract it" : "Spike it"}</button>
            <button className="btn act" onClick={() => setAsking("")}>Cancel</button>
          </div>
          {err && <p role="alert" className="alert" style={{ margin: 0 }}>{err}</p>}
        </div>
      )}

      {sheet.article && (
        <div style={{ borderTop: "3px double var(--rule)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="lab">{sheet.article.printed ? `Printed article${sheet.printedAt ? ` · ${time(sheet.printedAt)}` : ""}` : sheet.status === "retracted" ? "Retracted article" : "Draft article"} · {sheet.article.words} words</span>
          <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 800, fontSize: 18, lineHeight: "23px" }}>{sheet.article.headline}</span>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: "21px" }}>{sheet.article.body}</p>
        </div>
      )}

      <div style={{ borderTop: "3px double var(--rule)", paddingTop: 10 }}>
        <span className="lab">Fact sheet · {sheet.facts.length} claim{sheet.facts.length === 1 ? "" : "s"}</span>
        {!sheet.facts.length && <p className="hint" style={{ margin: "6px 0 0" }}>No fact sheet yet. One is built once two independent outlets have reported the story.</p>}
        {sheet.facts.map((f) => (
          <div key={f.id} className="claim">
            <span className="lab" style={f.role === "core" ? { color: "var(--accent)" } : undefined}>{roleLabel[f.role] ?? f.role}</span>
            <span>{f.text}<br /><span className="meta">{f.outlets.join(" · ")}</span></span>
          </div>
        ))}
        {sheet.conflicts.length > 0 && (
          <>
            <div style={{ paddingTop: 10 }}><span className="lab">Left out: outlets conflict</span></div>
            {sheet.conflicts.map((c) => (
              <div key={c.id} className="claim">
                <span className="lab">Disputed</span>
                <span style={{ color: "var(--soft)" }}>{c.text}<br /><span className="meta">{c.outlets.join(" · ")}</span></span>
              </div>
            ))}
          </>
        )}
      </div>

      <details style={{ borderTop: "1px solid var(--rule)" }}>
        <summary className="lab">Reports · {sheet.reports.length}</summary>
        {sheet.reports.map((r) => (
          <div key={r.id} style={{ padding: "6px 0", borderTop: "1px solid var(--rule)", fontSize: 14, lineHeight: "20px" }}>
            <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a><br />
            <span className="meta">{r.outlet} · {time(r.publishedAt)} · {r.live ? "live page, not used" : r.read}{r.wire ? ` · ${r.wire} copy` : ""}</span>
          </div>
        ))}
      </details>
      <details style={{ borderTop: "1px solid var(--rule)" }}>
        <summary className="lab">Every step · {sheet.history.length}</summary>
        {sheet.history.map((s) => (
          <div key={s.id} style={{ padding: "6px 0", borderTop: "1px solid var(--rule)", fontSize: 13.5, lineHeight: "19px", overflowWrap: "anywhere" }}>
            <span className="sans" style={{ fontWeight: 600 }}>{s.agent}</span> <span style={{ color: "var(--soft)" }}>{s.note}</span><br />
            <span className="meta">{time(s.startedAt)} · {s.status} · {dur(s.seconds)}{s.model ? ` · ${s.model}` : ""}{s.tokens ? ` · ${s.tokens.toLocaleString("en-IN")} tokens` : ""}{s.costUsd ? ` · ${usd(s.costUsd)}` : ""}</span>
          </div>
        ))}
      </details>
      {sheet.actions.length > 0 && (
        <details open style={{ borderTop: "1px solid var(--rule)" }}>
          <summary className="lab">Editor actions · {sheet.actions.length}</summary>
          {sheet.actions.map((a, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--rule)", fontSize: 13.5, lineHeight: "19px" }}>
              <span className="sans" style={{ fontWeight: 600 }}>{a.action.replace(/_/g, " ")}</span>{a.detail ? <span style={{ color: "var(--soft)" }}> {a.detail}</span> : null}<br />
              <span className="meta">{time(a.at)} · {new Date(a.at).toISOString().slice(0, 10)} · {a.actor}</span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/* ------------------------------------------------- send a story to the desk */

function Lead({ submissions, post, pick }: { submissions: Overview["submissions"]; post: (path: string, body: unknown) => Promise<Result>; pick: (id: number) => void }) {
  const [draft, setDraft] = useState("");
  const [desk, setDesk] = useState("india");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return setErr("Add a link or a topic first.");
    const res = await post("submissions", { input: draft, desk });
    if (res.ok) setDraft("");
    else setErr(res.message);
  };
  const strong = new Set(["waiting_second_outlet", "no_match", "rejected", "failed"]);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 className="h2">Send a story to the desk</h2>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: "21px", fontStyle: "italic", color: "var(--soft)" }}>Paste a link or name a topic. It goes through the same checks as every other story, including the two-outlet rule.</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="lead" className="lab" style={{ color: "var(--ink)" }}>Link or topic</label>
          <input id="lead" className="field" type="text" value={draft} maxLength={500} onChange={(e) => { setDraft(e.target.value); setErr(""); }} placeholder="Paste a link, or type a topic" />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="deskpick" className="lab" style={{ color: "var(--ink)" }}>Desk</label>
            <select id="deskpick" className="field" value={desk} onChange={(e) => setDesk(e.target.value)}>
              {DESKS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <button className="btn act solid" type="submit">Send to the desk</button>
        </div>
        {err && <p role="alert" className="alert" style={{ margin: 0 }}>{err}</p>}
      </form>
      {submissions.length > 0 && (
        <div aria-label="Recent submissions">
          {submissions.map((s) => (
            <div key={s.id} className="sub">
              <span className="sans" style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{s.input}</span>
              <span style={{ fontSize: 14, lineHeight: "20px", color: strong.has(s.state) ? "var(--accent)" : "var(--soft)" }}>{s.line}</span>
              <span className="meta">
                {time(s.createdAt)} · {s.kind}
                {s.eventId !== null && <> · <button className="btn" style={{ textDecoration: "underline", textUnderlineOffset: 3 }} onClick={() => pick(s.eventId!)}>open its run sheet</button></>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
