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
