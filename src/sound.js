let context,
  resumePromise,
  playedNotes = 0;
export const soundStatus = () => ({
  state: context?.state ?? "not-started",
  playedNotes,
});
export function unlockSound() {
  const Audio = window.AudioContext ?? window.webkitAudioContext;
  if (!Audio) return;
  context ??= new Audio();
  if (context.state === "suspended" && !resumePromise)
    resumePromise = context
      .resume()
      .catch(() => {})
      .finally(() => {
        resumePromise = null;
      });
  return resumePromise;
}
export async function playSound(name, volume = 0.2) {
  if (volume <= 0) return;
  await unlockSound();
  if (!context || context.state !== "running" || volume <= 0) return;
  const now = context.currentTime;
  const note = (frequency, start, duration, type = "sine", end = frequency) => {
    playedNotes++;
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now + start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, end),
      now + start + duration,
    );
    gain.gain.setValueAtTime(0.001, now + start);
    gain.gain.exponentialRampToValueAtTime(volume, now + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now + start);
    oscillator.stop(now + start + duration + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  };
  if (name === "war") {
    note(196, 0, 0.5, "triangle");
    note(233, 0.3, 0.6, "triangle");
    note(147, 0.6, 1, "triangle");
  } else if (name === "cannon") {
    note(100, 0, 0.28, "triangle", 24);
    note(190, 0.02, 0.15, "sawtooth", 28);
  } else if (name === "impact") note(75, 0, 0.2, "triangle", 25);
  else if (name === "musket") {
    for (const t of [0, 0.16, 0.32]) note(420, t, 0.055, "sawtooth", 90);
  } else if (name === "charge") {
    for (const t of [0, 0.14, 0.28, 0.42]) note(130, t, 0.06, "triangle", 60);
  } else if (name === "turn") {
    note(392, 0, 0.2);
    note(523, 0.14, 0.28);
  } else if (name === "build") {
    for (const t of [0, 0.38, 0.76, 1.14]) note(330, t, 0.065, "triangle", 150);
  } else if (name === "move") note(145, 0, 0.065, "triangle", 95);
  else note(620, 0, 0.045, "sine", 450);
}
