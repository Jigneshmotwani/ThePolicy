"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, TouchEvent, WheelEvent } from "react";
import type { Story } from "@/lib/stories";

type Topic = "front" | Story["desk"];
type Flip = "next" | "prev" | null;
type Edition = "night" | "paper";
type Flags = Record<string, boolean>;

const TOPICS: { id: Topic; label: string }[] = [
  { id: "front", label: "Front page" },
  { id: "india", label: "India" },
  { id: "world", label: "World" },
  { id: "business", label: "Business" },
  { id: "sport", label: "Sport" },
  { id: "entertainment", label: "Entertainment" },
];

const FLIP_MS = 620;
const WHEEL_COOLDOWN_MS = 1000;
const REFRESH_MS = 60_000;
const LS_EDITION = "tss:edition";
const LS_LIKED = "tss:liked";
const LS_CLIPPED = "tss:clipped";

/* ---- Time: always Asia/Kolkata (UTC+5:30, no daylight saving), computed by
   hand so the server and every browser print exactly the same string. ---- */
const IST_OFFSET_MS = 5.5 * 3600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ist(iso: string): Date | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + IST_OFFSET_MS);
}
/** "4:12 pm" */
function istTime(iso: string): string {
  const d = ist(iso);
  if (!d) return "";
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
/** "Wed 11 Nov 2026" */
function istDate(iso: string): string {
  const d = ist(iso);
  if (!d) return "";
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ---- Device-only storage ---- */
function readFlags(key: string): Flags {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Flags) : {};
  } catch {
    return {};
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or full storage: the choice simply does not persist */
  }
}

const listFor = (stories: Story[], topic: Topic) =>
  topic === "front" ? stories : stories.filter((s) => s.desk === topic);

type PageModel =
  | { kind: "blank" }
  | { kind: "end" }
  | { kind: "empty"; section: string }
  | { kind: "story"; story: Story; index: number; total: number };

interface View {
  stories: Story[];
  topic: Topic;
  idx: number;
  flip: Flip;
}

export default function Feed({ stories: initial, now }: { stories: Story[]; now: string }) {
  const [view, setView] = useState<View>({ stories: initial, topic: "front", idx: 0, flip: null });
  const [edition, setEdition] = useState<Edition>("night");
  const [liked, setLiked] = useState<Flags>({});
  const [clipped, setClipped] = useState<Flags>({});
  const [angle, setAngle] = useState<Record<string, number>>({});
  const [today, setToday] = useState(now);
  const [toast, setToast] = useState("");

  // The handlers below run from timers and window listeners, so they read
  // the latest view from a ref that is written together with the state.
  const viewRef = useRef(view);
  const update = useCallback((patch: Partial<View>) => {
    viewRef.current = { ...viewRef.current, ...patch };
    setView(viewRef.current);
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cool = useRef(0);
  const touchY = useRef<number | null>(null);
  const mouseY = useRef<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const turn = useCallback(
    (dir: "next" | "prev") => {
      const v = viewRef.current;
      const total = listFor(v.stories, v.topic).length;
      const idx = Math.max(0, Math.min(v.idx, total));
      if (v.flip) return;
      if (dir === "next" && idx >= total) return;
      if (dir === "prev" && idx <= 0) return;
      cool.current = Date.now() + WHEEL_COOLDOWN_MS;
      update({ flip: dir });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const cur = viewRef.current;
        const curTotal = listFor(cur.stories, cur.topic).length;
        const curIdx = Math.max(0, Math.min(cur.idx, curTotal));
        update({ idx: curIdx + (dir === "next" ? 1 : -1), flip: null });
      }, FLIP_MS);
    },
    [update],
  );

  const pickTopic = (topic: Topic) => {
    clearTimeout(timer.current);
    update({ topic, idx: 0, flip: null });
  };

  // Stored choices are read after hydration so the first paint matches the server.
  useEffect(() => {
    try {
      if (localStorage.getItem(LS_EDITION) === "paper") setEdition("paper");
    } catch {
      /* storage unavailable */
    }
    setLiked(readFlags(LS_LIKED));
    setClipped(readFlags(LS_CLIPPED));
    return () => {
      clearTimeout(timer.current);
      clearTimeout(toastTimer.current);
    };
  }, []);

  // New stories: re-fetch every minute and when the tab comes back, keeping
  // the reader on the story they are on (matched by id, not by position).
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/stories", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as Story[];
        if (stopped || !Array.isArray(next)) return;
        setToday(new Date().toISOString());
        const v = viewRef.current;
        if (v.flip) return; // mid-turn: the next refresh will pick it up
        if (JSON.stringify(next) === JSON.stringify(v.stories)) return;
        const curList = listFor(v.stories, v.topic);
        const nextList = listFor(next, v.topic);
        const reading = curList[v.idx];
        let idx: number;
        if (reading) {
          const at = nextList.findIndex((s) => s.id === reading.id);
          idx = at >= 0 ? at : Math.min(v.idx, nextList.length);
        } else {
          // On the end page stay at the end; on an empty section show what arrived.
          idx = curList.length === 0 ? 0 : nextList.length;
        }
        update({ stories: next, idx });
      } catch {
        /* offline: keep what is on the page */
      }
    };
    const id = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [update]);

  // Arrow keys turn the page too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        turn("next");
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        turn("prev");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn]);

  /* ---- Derived view ---- */
  const list = listFor(view.stories, view.topic);
  const total = list.length;
  const idx = Math.max(0, Math.min(view.idx, total));
  const flip = view.flip;
  const section = TOPICS.find((t) => t.id === view.topic)?.label ?? "";

  const pageAt = (i: number): PageModel => {
    if (total === 0) return i === 0 ? { kind: "empty", section } : { kind: "blank" };
    if (i < 0 || i > total) return { kind: "blank" };
    if (i === total) return { kind: "end" };
    return { kind: "story", story: list[i], index: i, total };
  };

  const topI = flip === "prev" ? idx - 1 : idx;
  const underI = flip === "prev" ? idx : idx + 1;
  const underCls = "page under" + (flip === "next" ? " reveal" : flip === "prev" ? " cover" : " rest");
  const topCls = "page top" + (flip === "next" ? " flip-up" : flip === "prev" ? " flip-down" : "");

  const cur = idx < total ? list[idx] : null;
  const isLiked = !!(cur && liked[cur.id]);
  const isClipped = !!(cur && clipped[cur.id]);

  const toggleFlag = (key: string, flags: Flags, set: (f: Flags) => void) => {
    if (!cur) return;
    const next = { ...flags };
    if (next[cur.id]) delete next[cur.id];
    else next[cur.id] = true;
    set(next);
    writeLocal(key, JSON.stringify(next));
  };

  const toggleEdition = () => {
    const next: Edition = edition === "paper" ? "night" : "paper";
    setEdition(next);
    writeLocal(LS_EDITION, next);
  };

  const say = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 1800);
  };

  const share = async () => {
    if (!cur) return;
    const url = cur.sources[0]?.href;
    if (!url) return;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: cur.headline, url });
      } else {
        await navigator.clipboard.writeText(url);
        say("Source link copied");
      }
    } catch (e) {
      // The reader closing the share sheet is not an error worth reporting.
      if (!(e instanceof DOMException && e.name === "AbortError")) say("Could not share");
    }
  };

  const swipe = (d: number) => {
    if (d < -40) turn("next");
    else if (d > 40) turn("prev");
  };
  const onTouchStart = (e: TouchEvent) => {
    touchY.current = e.touches[0] ? e.touches[0].clientY : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (touchY.current == null || !e.changedTouches[0]) return;
    const d = e.changedTouches[0].clientY - touchY.current;
    touchY.current = null;
    swipe(d);
  };
  const onMouseDown = (e: MouseEvent) => {
    mouseY.current = e.clientY;
  };
  const onMouseUp = (e: MouseEvent) => {
    if (mouseY.current == null) return;
    const d = e.clientY - mouseY.current;
    mouseY.current = null;
    swipe(d);
  };
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) < 24) return;
    if (cool.current && Date.now() < cool.current) return;
    turn(e.deltaY > 0 ? "next" : "prev");
  };

  const renderPage = (p: PageModel) => {
    if (p.kind === "story") {
      const st = p.story;
      const picked = Math.min(angle[st.id] ?? 0, st.angles.length - 1);
      const pageNo = `Page ${p.index + 1} of ${p.total}`;
      const filed = `Filed ${istTime(st.printedAt)}`;
      const manyAngles = st.angles.length > 1;
      return (
        <div className="f-story">
          <div className="f-meta">
            <span className="f-meta-desk">{st.deskLabel}</span>
            <span className="f-meta-page">{manyAngles ? pageNo : `${filed} · ${pageNo}`}</span>
          </div>
          <h2 className="f-headline">{st.headline}</h2>
          {manyAngles && (
            <div className="f-readas">
              <span className="f-readas-label">Read as</span>
              {st.angles.map((a, k) => (
                <button
                  key={a.key}
                  type="button"
                  className={"btn angle" + (k === picked ? " on" : "")}
                  aria-pressed={k === picked}
                  onClick={() => setAngle((prev) => ({ ...prev, [st.id]: k }))}
                >
                  {a.label}
                </button>
              ))}
              <span className="f-filed">{filed}</span>
            </div>
          )}
          <div className="plate f-plate">
            <span className="f-plate-tag">[STORY IMAGE]</span>
            <span className="f-plate-cap">Licensed photo, or an illustration labelled as AI-made</span>
          </div>
          <p className="dropcap f-body">{st.angles[picked].body}</p>
          <div className="f-sources">
            <div className="f-sources-row">
              <span className="f-sources-label">Sources</span>
              <span className="f-stamp">
                <svg className="ico sm" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                <span>{`Corroborated · ${st.outletCount} outlets`}</span>
              </span>
            </div>
            <div className="f-links">
              {st.sources.map((src) => (
                <a
                  key={src.outletId}
                  className="f-link"
                  href={src.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  draggable={false}
                >
                  {src.name}
                </a>
              ))}
            </div>
          </div>
        </div>
      );
    }
    if (p.kind === "end") {
      return (
        <div className="f-end">
          <div className="f-end-mark">— 30 —</div>
          <div className="f-end-kicker">The old newsroom mark for end of copy</div>
          <p className="f-end-lede">That is the edition.</p>
          <p className="f-end-note">
            New stories are printed the moment a second outlet confirms them. Nothing runs on one source
            alone.
          </p>
          <button type="button" className="btn f-end-btn" onClick={() => pickTopic("front")}>
            Back to the front page
          </button>
        </div>
      );
    }
    if (p.kind === "empty") {
      return (
        <div className="f-end">
          <div className="f-end-kicker">{p.section}</div>
          <p className="f-end-lede">Nothing has been corroborated yet.</p>
          <p className="f-end-note">
            {view.topic === "front"
              ? "No story has been confirmed by a second outlet so far."
              : `No ${p.section} story has been confirmed by a second outlet so far.`}{" "}
            Nothing runs on one source alone.
          </p>
          {view.topic !== "front" && (
            <button type="button" className="btn f-end-btn" onClick={() => pickTopic("front")}>
              Back to the front page
            </button>
          )}
        </div>
      );
    }
    return null;
  };

  const storyCount = view.stories.length;
  const canPrev = idx > 0;
  const canNext = idx < total;

  return (
    <div className="shell">
      <div className={"np" + (edition === "paper" ? " paper" : "")}>
        <header className="f-head">
          <div className="f-head-row">
            <span>{istDate(today)}</span>
            <span>
              {edition === "paper" ? "Paper edition" : "Night edition"} · {storyCount}{" "}
              {storyCount === 1 ? "story" : "stories"}
            </span>
            <button
              type="button"
              className="btn f-edition-btn"
              aria-label={edition === "paper" ? "Switch to the night edition" : "Switch to the paper edition"}
              onClick={toggleEdition}
            >
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 4a8 8 0 0 0 0 16z" style={{ fill: "currentColor" }} />
              </svg>
            </button>
          </div>
          <h1 className="f-masthead">The Second Source</h1>
          <div aria-hidden="true" className="f-head-rule" />
        </header>

        <nav aria-label="Sections" className="noscroll f-nav">
          {TOPICS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={"btn topic" + (t.id === view.topic ? " on" : "")}
              aria-pressed={t.id === view.topic}
              onClick={() => pickTopic(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <main
          className="stage f-stage"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
        >
          <article key="under" className={underCls} aria-hidden={flip ? undefined : true}>
            {renderPage(pageAt(underI))}
          </article>
          <article key="top" className={topCls}>
            {renderPage(pageAt(topI))}
          </article>
        </main>

        <footer className="f-foot">
          {toast && <span className="f-toast">{toast}</span>}
          <span className="f-sr" role="status" aria-live="polite">
            {toast}
          </span>
          {cur && (
            <div className="f-acts">
              <button
                type="button"
                className={"btn act f-sq" + (isLiked ? " on" : "")}
                aria-pressed={isLiked}
                aria-label="Like this story"
                onClick={() => toggleFlag(LS_LIKED, liked, setLiked)}
              >
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20s-7-4.4-7-9.6A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z" />
                </svg>
              </button>
              <button
                type="button"
                className={"btn act f-sq" + (isClipped ? " on" : "")}
                aria-pressed={isClipped}
                aria-label="Clip this story to read later"
                onClick={() => toggleFlag(LS_CLIPPED, clipped, setClipped)}
              >
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 4h10v16l-5-3.5L7 20z" />
                </svg>
              </button>
              <button type="button" className="btn f-sq" aria-label="Share this story" onClick={share}>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" />
                </svg>
              </button>
            </div>
          )}
          <span className="f-spacer" />
          <button
            type="button"
            className="btn f-sq"
            aria-label="Previous page"
            aria-disabled={!canPrev}
            onClick={() => turn("prev")}
          >
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <button type="button" className="btn f-turn" aria-disabled={!canNext} onClick={() => turn("next")}>
            <span>Turn page</span>
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        </footer>
      </div>
    </div>
  );
}
