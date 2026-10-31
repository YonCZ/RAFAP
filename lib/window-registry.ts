// Round 16.3 — plugin-window identity with memory.
//
// Round 16.2 counted *held* long-polls to detect how many Figma windows
// run the plugin. That undercounts: a backgrounded window's plugin
// iframe is throttled between poll cycles, so at the instant a tool
// snapshots the count, that window holds no poll (field report: two
// windows with selections, two agent builds, no ask — each build
// silently went to whichever window was frontmost). Identity + memory
// fixes it: every plugin panel stamps a random window id (`?wid=`) on
// its polls; the bridge remembers who was seen recently — even between
// their polls — and can tell exactly which window answered a command.

/** How long a window stays "known" after its last poll. Long enough to
 *  bridge a throttled backgrounded window's poll gaps, short enough to
 *  forget a closed window promptly. */
export const WINDOW_MEMORY_MS = 45_000;

/** The id used when a plugin polls without a wid (pre-16.3 builds) —
 *  they cannot be told apart, so they share one identity. Still
 *  counted: the ask must protect against stale windows too. */
export const ANONYMOUS_WINDOW = "(anonymous)";

export class WindowRegistry {
  private lastSeen = new Map<string, number>();
  /** which window took which command (stamped at /pending delivery). */
  private takenBy = new Map<string, string>();
  /** windows with at least one completed command result (success or
   *  error — "nothing is selected" is heard, not silent). */
  private heard = new Set<string>();

  /** Record a poll from a window id (polls without wid → anonymous). */
  touch(wid: string, now = Date.now()): void {
    this.lastSeen.set(wid || ANONYMOUS_WINDOW, now);
  }

  /** Distinct windows seen within the memory window. */
  activeCount(now = Date.now()): number {
    let n = 0;
    for (const t of this.lastSeen.values()) if (now - t <= WINDOW_MEMORY_MS) n++;
    return n;
  }

  /** Stamp which window a /pending delivery went to. */
  deliveredTo(commandId: string, wid: string): void {
    if (this.takenBy.size > 256) this.takenBy.clear(); // bursts are ≤ ~12; keep it small
    this.takenBy.set(commandId, wid || ANONYMOUS_WINDOW);
  }

  /** Mark a command result as having answered its window. */
  heardResult(commandId: string): void {
    const wid = this.takenBy.get(commandId);
    if (wid) this.heard.add(wid);
  }

  /** Known windows that have not answered anything yet. */
  unheard(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [wid, t] of this.lastSeen) {
      if (now - t <= WINDOW_MEMORY_MS && !this.heard.has(wid)) out.push(wid);
    }
    return out;
  }

  /** Forget windows silent past the memory window (opportunistic). */
  prune(now = Date.now()): void {
    for (const [wid, t] of this.lastSeen) {
      if (now - t > WINDOW_MEMORY_MS) {
        this.lastSeen.delete(wid);
        this.heard.delete(wid);
      }
    }
  }
}
