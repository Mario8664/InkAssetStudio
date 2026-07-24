/**
 * Project-level contract for immutable runtime artifacts derived from editable
 * scene or asset source data. Producers own their payloads; this module owns
 * identity, versioning, stable source hashes, paths, and text-safe buffers.
 */
export const DERIVED_ASSET_DIRECTORY = 'public/data/derived-assets';
export const DERIVED_ASSET_MANIFEST_PATH = `${DERIVED_ASSET_DIRECTORY}/index.json`;
export const DERIVED_ASSET_MANIFEST_FORMAT_VERSION = 1;

export type DerivedAssetDescriptor = Readonly<{
  producer: string;
  sourceId: string;
  sourceHash: string;
  formatVersion: number;
  path: string;
}>;

export type DerivedAssetManifest = Readonly<{
  formatVersion: number;
  assets: readonly DerivedAssetDescriptor[];
}>;

export type DerivedAssetTextBundle = Readonly<{
  manifest: DerivedAssetManifest;
  files: Readonly<Record<string, string>>;
}>;

export type DerivedAssetWriteFile = Readonly<{
  relativePath: string;
  contents: string;
}>;

export type DerivedAssetTextReader = (relativePath: string) => Promise<string | null>;

export function createDerivedAssetKey(producer: string, sourceId: string): string {
  return `${producer}:${sourceId}`;
}

export function createDerivedAssetPath(producerDirectory: string, sourceId: string): string {
  return `${DERIVED_ASSET_DIRECTORY}/${producerDirectory}/${encodeURIComponent(sourceId)}.json`;
}

export function createDerivedAssetManifest(assets: readonly DerivedAssetDescriptor[]): DerivedAssetManifest {
  const keys = new Set<string>();
  const ordered = [...assets].sort((left, right) => createDerivedAssetKey(left.producer, left.sourceId)
    .localeCompare(createDerivedAssetKey(right.producer, right.sourceId)));
  for (const asset of ordered) {
    const key = createDerivedAssetKey(asset.producer, asset.sourceId);
    if (!asset.producer || !asset.sourceId || !asset.sourceHash || !asset.path || keys.has(key)) {
      throw new Error(`Invalid or duplicate derived asset descriptor "${key}".`);
    }
    keys.add(key);
  }
  return { formatVersion: DERIVED_ASSET_MANIFEST_FORMAT_VERSION, assets: ordered };
}

export function createDerivedAssetWriteFiles(bundle: DerivedAssetTextBundle): readonly DerivedAssetWriteFile[] {
  const files = Object.entries(bundle.files).map(([relativePath, contents]) => ({ relativePath, contents }));
  files.push({
    relativePath: DERIVED_ASSET_MANIFEST_PATH,
    contents: `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  });
  return files;
}

export function getDerivedAssetDescriptor(
  manifest: DerivedAssetManifest | null | undefined,
  producer: string,
  sourceId: string,
): DerivedAssetDescriptor | undefined {
  return manifest?.assets.find((asset) => asset.producer === producer && asset.sourceId === sourceId);
}

export function isDerivedAssetManifest(value: unknown): value is DerivedAssetManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DerivedAssetManifest>;
  return candidate.formatVersion === DERIVED_ASSET_MANIFEST_FORMAT_VERSION
    && Array.isArray(candidate.assets)
    && candidate.assets.every(isDerivedAssetDescriptor);
}

export async function loadDerivedAssetManifestFromFiles(
  readText: DerivedAssetTextReader,
): Promise<DerivedAssetManifest | null> {
  const text = await readText(DERIVED_ASSET_MANIFEST_PATH);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isDerivedAssetManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hashDerivedAssetSource(source: unknown): string {
  let hash = 0x811c9dc5;
  const write = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  writeCanonicalDerivedAssetSource(source, write);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Encodes typed-array bytes for the existing atomic project-text writer. */
export function encodeDerivedAssetBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

export function decodeDerivedAssetBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeDerivedAssetFloat32(values: Float32Array): string {
  return encodeDerivedAssetBytes(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export function decodeDerivedAssetFloat32(encoded: string): Float32Array {
  const bytes = decodeDerivedAssetBytes(encoded);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Derived Float32 payload has an invalid byte length.');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function encodeDerivedAssetInt32(values: Int32Array): string {
  return encodeDerivedAssetBytes(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export function decodeDerivedAssetInt32(encoded: string): Int32Array {
  const bytes = decodeDerivedAssetBytes(encoded);
  if (bytes.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Derived Int32 payload has an invalid byte length.');
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Int32Array.BYTES_PER_ELEMENT);
}

export function encodeDerivedAssetUint8(values: Uint8Array): string {
  return encodeDerivedAssetBytes(values);
}

export function decodeDerivedAssetUint8(encoded: string): Uint8Array {
  return decodeDerivedAssetBytes(encoded);
}

function isDerivedAssetDescriptor(value: unknown): value is DerivedAssetDescriptor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DerivedAssetDescriptor>;
  return typeof candidate.producer === 'string' && !!candidate.producer
    && typeof candidate.sourceId === 'string' && !!candidate.sourceId
    && typeof candidate.sourceHash === 'string' && !!candidate.sourceHash
    && typeof candidate.formatVersion === 'number' && Number.isInteger(candidate.formatVersion) && candidate.formatVersion > 0
    && typeof candidate.path === 'string' && !!candidate.path;
}

/**
 * Streams the existing canonical representation directly into a consumer.
 * This preserves the prior UTF-16 FNV input byte-for-byte without allocating
 * a large intermediate string for sparse Fill RGBA arrays.
 */
function writeCanonicalDerivedAssetSource(value: unknown, write: (text: string) => void): void {
  if (value === null) {
    write('null');
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    write(JSON.stringify(value));
    return;
  }
  if (typeof value === 'number') {
    write(Number.isFinite(value) ? serializeCanonicalNumber(value) : 'null');
    return;
  }
  if (Array.isArray(value)) {
    write('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) write(',');
      // Array#map preserves holes and Array#join writes them as an empty slot.
      if (index in value) writeCanonicalDerivedAssetSource(value[index], write);
    }
    write(']');
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    write('{');
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) write(',');
      const key = keys[index]!;
      write(JSON.stringify(key));
      write(':');
      writeCanonicalDerivedAssetSource(record[key], write);
    }
    write('}');
    return;
  }
  write('null');
}

function serializeCanonicalNumber(value: number): string {
  const rounded = Number(value.toFixed(12));
  return JSON.stringify(Object.is(rounded, -0) ? 0 : rounded);
}
