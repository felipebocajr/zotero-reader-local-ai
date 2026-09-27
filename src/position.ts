export function placePopup(anchor: { left: number; top: number; bottom: number; width: number }, width: number, height: number,
  viewport: { width: number; height: number }): { left: number; top: number } {
  const margin = 12;
  const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - width / 2, viewport.width - width - margin));
  const below = anchor.bottom + 8;
  const preferred = below + height <= viewport.height - margin ? below : anchor.top - height - 8;
  return { left, top: Math.max(margin, Math.min(preferred, viewport.height - height - margin)) };
}
