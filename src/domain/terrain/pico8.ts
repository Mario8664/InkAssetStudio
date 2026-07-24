/** Painting-compatible fixed terrain palette. */
export const PICO_8_COLORS = [
  { id: 'black', label: 'Black', hex: '#000000' },
  { id: 'dark-blue', label: 'Dark Blue', hex: '#1d2b53' },
  { id: 'dark-purple', label: 'Dark Purple', hex: '#7e2553' },
  { id: 'dark-green', label: 'Dark Green', hex: '#008751' },
  { id: 'brown', label: 'Brown', hex: '#ab5236' },
  { id: 'dark-gray', label: 'Dark Gray', hex: '#5f574f' },
  { id: 'light-gray', label: 'Light Gray', hex: '#c2c3c7' },
  { id: 'white', label: 'White', hex: '#fff1e8' },
  { id: 'red', label: 'Red', hex: '#ff004d' },
  { id: 'orange', label: 'Orange', hex: '#ffa300' },
  { id: 'yellow', label: 'Yellow', hex: '#ffec27' },
  { id: 'green', label: 'Green', hex: '#00e436' },
  { id: 'blue', label: 'Blue', hex: '#29adff' },
  { id: 'lavender', label: 'Lavender', hex: '#83769c' },
  { id: 'pink', label: 'Pink', hex: '#ff77a8' },
  { id: 'light-peach', label: 'Light Peach', hex: '#ffccaa' },
] as const;

export type Pico8ColorId = typeof PICO_8_COLORS[number]['id'];
export const DEFAULT_TILE_COLOR: Pico8ColorId = 'white';

const byId = new Map(PICO_8_COLORS.map((color) => [color.id, color]));

export function isPico8ColorId(value: unknown): value is Pico8ColorId {
  return typeof value === 'string' && byId.has(value as Pico8ColorId);
}

export function getPico8ColorHex(id: Pico8ColorId): string {
  return byId.get(id)?.hex ?? '#fff1e8';
}
