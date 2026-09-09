const validSnapshot = (snapshot) =>
  snapshot &&
  Number.isFinite(Number(snapshot.revision)) &&
  Number.isFinite(Number(snapshot.turn)) &&
  typeof snapshot.activePlayer === "string";

const comparable = (snapshot) => ({
  revision: Number(snapshot.revision),
  turn: Number(snapshot.turn),
  activePlayer: snapshot.activePlayer,
});

/**
 * Build a monotonic, remount-safe turn transition observer.
 *
 * The first snapshot for a match establishes the baseline and is silent.
 * Older/equal revisions are ignored, so polling races and StrictMode/HMR
 * effect replays cannot produce a false turn cue. A cue is emitted only when
 * a newer authoritative revision changes turn or active player.
 */
export function createTurnTransitionTracker() {
  const states = new Map();
  const seenTransitions = new Map();
  return {
    observe(matchId, snapshot, { baseline = false } = {}) {
      if (!matchId || !validSnapshot(snapshot)) return false;
      const next = comparable(snapshot);
      const previous = states.get(matchId);
      const transitionKey = `${next.turn}:${next.activePlayer}`;
      if (!previous) {
        // The first snapshot is a mount/remount/HMR baseline, not permission
        // to replay a transition that happened while this view was absent.
        states.set(matchId, next);
        seenTransitions.set(matchId, new Set([transitionKey]));
        return false;
      }
      if (baseline) {
        // A remounted view may receive a newer snapshot than the previous
        // view saw. Adopt it silently; a transition that happened while the
        // view was absent is history, not a new cue for this view.
        if (next.revision > Number(previous.revision)) {
          states.set(matchId, next);
          const seen = seenTransitions.get(matchId) ?? new Set();
          seen.add(transitionKey);
          seenTransitions.set(matchId, seen);
        }
        return false;
      }
      if (next.revision <= Number(previous.revision)) return false;
      states.set(matchId, next);
      const seen = seenTransitions.get(matchId) ?? new Set();
      if (seen.has(transitionKey)) return false;
      seen.add(transitionKey);
      seenTransitions.set(matchId, seen);
      return (
        next.turn !== Number(previous.turn) ||
        next.activePlayer !== previous.activePlayer
      );
    },
    reset(matchId) {
      states.delete(matchId);
      seenTransitions.delete(matchId);
    },
  };
}

const defaultTracker = createTurnTransitionTracker();
export const shouldPlayTurnTransition = (matchId, snapshot, options) =>
  defaultTracker.observe(matchId, snapshot, options);
