export const KIOSK_ACTIONS = Object.freeze({
  CHECK_IN: "CHECK_IN",
  CHECK_OUT: "CHECK_OUT",
  ALREADY_DONE: "ALREADY_DONE",
  TOO_EARLY: "TOO_EARLY",
  NOT_RECOGNISED: "NOT_RECOGNISED",
});

export function decideKioskAction({ matched, availability }) {
  if (!matched) return KIOSK_ACTIONS.NOT_RECOGNISED;
  switch (availability) {
    case "not_checked_in_today":
      return KIOSK_ACTIONS.CHECK_IN;
    case "available":
      return KIOSK_ACTIONS.CHECK_OUT;
    case "too_early":
      return KIOSK_ACTIONS.TOO_EARLY;
    case "already_checked_out_today":
      return KIOSK_ACTIONS.ALREADY_DONE;
    default:
      return KIOSK_ACTIONS.ALREADY_DONE;
  }
}

export function describeKioskAction(action, { instructorName, opensAtLabel, minutesRemaining } = {}) {
  const name = instructorName || "Instructor";
  switch (action) {
    case KIOSK_ACTIONS.CHECK_IN:
      return { title: `${name} checked in`, tone: "success" };
    case KIOSK_ACTIONS.CHECK_OUT:
      return { title: `${name} checked out`, tone: "success" };
    case KIOSK_ACTIONS.TOO_EARLY:
      return {
        title: `${name} is already checked in`,
        detail: opensAtLabel
          ? `Check-out opens at ${opensAtLabel}.`
          : minutesRemaining
            ? `Check-out opens in about ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`
            : "It is too early to check out.",
        tone: "info",
      };
    case KIOSK_ACTIONS.ALREADY_DONE:
      return {
        title: `${name} has already checked out today`,
        detail: "Nothing was recorded.",
        tone: "info",
      };
    case KIOSK_ACTIONS.NOT_RECOGNISED:
      return {
        title: "Not recognised",
        detail: "Nothing was recorded. Please try again, or ask an administrator to update your reference photo.",
        tone: "warning",
      };
    default:
      return { title: "Nothing recorded", tone: "info" };
  }
}

export function kioskActionRecorded(action) {
  return action === KIOSK_ACTIONS.CHECK_IN
    || action === KIOSK_ACTIONS.CHECK_OUT;
}
