/**
 * Where a dropdown panel drawn in its own layer should sit.
 *
 * Under its trigger, and pulled back inside the window when the trigger is
 * near an edge - the date filter now lives in a panel against the right-hand
 * side of the screen, where a menu opening at the trigger's left edge could
 * otherwise run off it.
 */

export const FLOATING_PANEL_GAP = 6;
export const FLOATING_EDGE_MARGIN = 8;

export function floatingPanelPosition(
  trigger: { bottom: number; left: number },
  panelWidth: number,
  viewportWidth: number,
): { top: number; left: number } {
  const maxLeft = Math.max(FLOATING_EDGE_MARGIN, viewportWidth - panelWidth - FLOATING_EDGE_MARGIN);
  return {
    top: trigger.bottom + FLOATING_PANEL_GAP,
    left: Math.min(Math.max(trigger.left, FLOATING_EDGE_MARGIN), maxLeft),
  };
}
