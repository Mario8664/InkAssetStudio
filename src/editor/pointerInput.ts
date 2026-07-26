/** Authoring input is deliberately narrower than generic Pointer Events. */
export function isApplePencilPointer(event: Pick<PointerEvent, 'pointerType'>): boolean {
  return event.pointerType === 'pen';
}

type PencilPresenceEvent = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'type'>;

/**
 * Tracks a Pencil while it is hovering over, or drawing on, the viewport.
 * A `pointerup` deliberately keeps the Pencil present: hover-capable iPads
 * continue to report the same pointer until it leaves the canvas.
 */
export class PencilPresenceTracker {
  private readonly pointerIds = new Set<number>();

  observe(event: PencilPresenceEvent): void {
    if (!isApplePencilPointer(event)) return;
    if (event.type === 'pointerout' || event.type === 'pointerleave' || event.type === 'pointercancel') {
      this.pointerIds.delete(event.pointerId);
      return;
    }
    this.pointerIds.add(event.pointerId);
  }

  get isPresent(): boolean {
    return this.pointerIds.size > 0;
  }
}

/** OrbitControls accepts touch only when no Pencil is in the viewport. */
export function isFingerNavigationPointer(event: Pick<PointerEvent, 'pointerType'>): boolean {
  return event.pointerType === 'touch';
}

export function canNavigateWithFinger(
  event: Pick<PointerEvent, 'pointerType'>,
  pencilIsPresent: boolean,
): boolean {
  return isFingerNavigationPointer(event) && !pencilIsPresent;
}
