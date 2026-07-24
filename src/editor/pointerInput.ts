/** Authoring input is deliberately narrower than generic Pointer Events. */
export function isApplePencilPointer(event: Pick<PointerEvent, 'pointerType'>): boolean {
  return event.pointerType === 'pen';
}

/** OrbitControls is configured so only this pointer class can navigate. */
export function isFingerNavigationPointer(event: Pick<PointerEvent, 'pointerType'>): boolean {
  return event.pointerType === 'touch';
}
