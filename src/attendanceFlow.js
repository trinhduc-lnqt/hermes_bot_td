export function buildAttendanceStateAfterReason(action, reason) {
  return {
    action,
    reason,
    stage: "adj_minute"
  };
}

export function parseAdjMinuteInput(input) {
  const text = String(input || "").trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

export function buildAttendanceStateAfterMinute(pending, adjMinute) {
  return {
    action: pending.action,
    reason: pending.reason,
    adjMinute,
    stage: "location"
  };
}
