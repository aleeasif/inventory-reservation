/** `mm:ss` remaining, floored at zero so a lapsed hold never shows a negative. */
export const formatCountdown = (expiresAtIso: string, nowMs: number): string => {
  const remainingMs = Math.max(0, new Date(expiresAtIso).getTime() - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
};

export const remainingFraction = (
  createdAtIso: string,
  expiresAtIso: string,
  nowMs: number,
): number => {
  const start = new Date(createdAtIso).getTime();
  const end = new Date(expiresAtIso).getTime();
  if (end <= start) {
    return 0;
  }
  return Math.min(1, Math.max(0, (end - nowMs) / (end - start)));
};
