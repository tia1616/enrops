// Tabs for one provider's record (Jessica 2026-11-19: "the page is growing too
// long"). The summary stays above the tabs and the partner's decision below
// them, so both show on every tab; each section is one tab, the way vendor
// pages in TrustLayer and myCOI are laid out.
//
// Used by the partner's page AND the provider's own page for that partner, so
// both have the same layout. The row is TabStrip, the scroller every admin tab
// row already uses (sideways scroll + edge fade on a phone, active tab kept in
// view). Every panel stays MOUNTED and is only hidden, so each section loads
// once, its count can show on its tab, and switching tabs never refetches or
// loses an open roster.
//
// Each tab has its own link (#documents, #classes ...), so a partner can send
// someone straight to one. Plain #name only: that is all an artifact-style
// share or a pasted link keeps.

import { useCallback, useEffect, useState } from "react";
import TabStrip from "../../components/TabStrip.jsx";
import { tabFromHash as pickTab } from "../../lib/recordTabs.js";

export { alertFor } from "../../lib/recordTabs.js";

const DOT = { bad: "bg-red-500", attention: "bg-amber-400" };

const currentHash = () => (typeof window !== "undefined" ? window.location.hash : "");
const tabFromHash = (ids) => pickTab(currentHash(), ids);

/**
 * The active tab, kept in the address. `ids` are the tabs this page has; an
 * unknown or missing #name opens the first one.
 */
export function useRecordTab(ids) {
  const key = ids.join(",");
  const [active, setActive] = useState(() => tabFromHash(ids));

  useEffect(() => {
    const onHash = () => setActive(tabFromHash(ids));
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const choose = useCallback((id) => {
    setActive(id);
    // replaceState: a tab is a view, not a page; Back leaves the record.
    try { window.history.replaceState(window.history.state, "", `#${id}`); } catch { /* address bar is a convenience */ }
  }, []);

  return [active, choose];
}

/**
 * The tab row. `tabs`: [{ id, label, count?, alert? }] where alert is
 * 'bad' (red dot: something missing or expired) or 'attention' (amber dot:
 * expiring or in review). `sticky` pins the row to the top while scrolling.
 */
export function RecordTabRow({ tabs, active, onChange, label = "Record sections", sticky = false }) {
  function onKeyDown(e) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    document.getElementById(`record-tab-${next.id}`)?.focus();
  }

  return (
    // A background only when pinned (the partner shell's page colour, so content
    // scrolling under it is hidden); unpinned it takes the page's own.
    <div className={`${sticky ? "sticky top-0 z-30 bg-[#FBFBFB]" : ""} mt-5 border-b border-j2s-ink/10`} onKeyDown={onKeyDown}>
      <TabStrip role="tablist" label={label} style={{ gap: 4 }}>
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              id={`record-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`record-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              data-tab-active={on ? "true" : undefined}
              onClick={() => onChange(t.id)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold ${
                on ? "border-j2s-purple text-j2s-purple" : "border-transparent text-j2s-ink/60 hover:text-j2s-ink"
              }`}
            >
              {t.label}
              {t.count != null && (
                <span className={`rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-j2s-purple/10" : "bg-j2s-ink/5"}`}>{t.count}</span>
              )}
              {t.alert && DOT[t.alert] && (
                <>
                  <span className={`h-2 w-2 rounded-full ${DOT[t.alert]}`} aria-hidden="true" />
                  <span className="sr-only">{t.alert === "bad" ? "(needs attention)" : "(something coming up)"}</span>
                </>
              )}
            </button>
          );
        })}
      </TabStrip>
    </div>
  );
}

/** One tab's content. Hidden, never unmounted. */
export function RecordTabPanel({ id, active, children }) {
  return (
    <div id={`record-panel-${id}`} role="tabpanel" aria-labelledby={`record-tab-${id}`} hidden={id !== active}>
      {children}
    </div>
  );
}

