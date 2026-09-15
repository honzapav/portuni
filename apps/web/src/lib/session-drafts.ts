// Per-session composer drafts, kept outside the React tree.
//
// SessionChat's composer used to be plain component state, and the component
// is mounted at a position in the tree that survives a change of session:
// WorkspaceView renders one detail surface and swaps which session feeds it,
// so React reused the same instance and the draft followed the user from one
// task to the next (and got overwritten by the next one), and any remount of
// the surface threw the draft away outright.
//
// A draft belongs to the session, not to whichever component happens to be
// showing it, so it lives here: keyed by session id, for as long as the
// window is open. Deliberately in memory only -- an unsent message is not
// something to resurrect days later in another launch.

export type DraftStore = {
  get(sessionId: string): string;
  set(sessionId: string, text: string): void;
  clear(sessionId: string): void;
};

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, string>();
  return {
    get: (sessionId) => drafts.get(sessionId) ?? "",
    set: (sessionId, text) => {
      // An emptied composer is the same thing as no draft -- keeping "" would
      // just grow the map for every session the user ever looked at.
      if (text === "") drafts.delete(sessionId);
      else drafts.set(sessionId, text);
    },
    clear: (sessionId) => {
      drafts.delete(sessionId);
    },
  };
}

// The window's own store. One per webview; nothing crosses windows.
export const sessionDrafts = createDraftStore();
