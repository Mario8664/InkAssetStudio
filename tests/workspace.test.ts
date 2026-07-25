import { describe, expect, it } from 'vitest';
import { createInkOutlineStroke, isInkCompiledCurrent, withCompiledInkGroup } from '../src/domain/ink/ink';
import {
  MAX_INK_GROUPS,
  addInkGroup,
  createStudioDocument,
  getInkSourceByReference,
  parseStudioWorkFile,
  serializeStudioDocument,
  updateInkShapeAuthor,
} from '../src/domain/workspace/workspace';
import { WorkspaceStore } from '../src/domain/workspace/WorkspaceStore';

describe('Ink Studio work files', () => {
  it('round-trips editable terrain and multiple Ink groups', () => {
    const initial = createStudioDocument('Round Trip');
    const added = addInkGroup(initial, 'Second Group', { x: 2, y: 1, z: -1 }).document;
    const parsed = parseStudioWorkFile(serializeStudioDocument(added));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.name).toBe('Round Trip');
    expect(parsed.document.terrain.tiles).toHaveLength(25);
    expect(parsed.document.ink.embeddedAssets).toHaveLength(2);
    expect(parsed.document.ink.assetReferences[1]?.anchorPosition).toEqual({ x: 2, y: 1, z: -1 });
  });

  it('exports only authoritative Ink author data and reconstructs derived caches on import', () => {
    const document = createStudioDocument('Source only');
    const group = document.ink.embeddedAssets[0]!.group;
    const shape = group.shapes[0]!;
    document.ink.embeddedAssets[0]!.group = withCompiledInkGroup({
      ...group,
      shapes: [{
        ...shape,
        strokes: [createInkOutlineStroke([
          { x: -0.25, y: 0, pressure: 0.4 },
          { x: 0.25, y: 0, pressure: 0.8 },
        ], '#ff004d', 0.04)],
      }],
    });
    const serialized = JSON.parse(serializeStudioDocument(document)) as any;
    expect(serialized.ink.embeddedAssets[0].group.compiled).toBeUndefined();
    expect(serialized.ink.embeddedAssets[0].group.visualFootprint).toBeUndefined();
    const parsed = parseStudioWorkFile(JSON.stringify(serialized));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.ink.embeddedAssets[0]!.group.compiled.shapes[0]!.ribbon.positions.length).toBeGreaterThan(0);
  });

  it('upgrades v11 work files to v14 and treats missing Normal Outset as disabled', () => {
    const legacy = structuredClone(createStudioDocument('Legacy v11')) as any;
    legacy.sourceCompatibility.paintingInkCompiledFormatVersion = 11;
    const shape = legacy.ink.embeddedAssets[0].group.shapes[0];
    delete shape.normalOutset;
    legacy.ink.embeddedAssets[0].group.compiled.formatVersion = 11;
    for (const compiled of legacy.ink.embeddedAssets[0].group.compiled.shapes) delete compiled.normalOutset;

    const parsed = parseStudioWorkFile(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const upgraded = parsed.document.ink.embeddedAssets[0]!.group;
    expect(parsed.document.sourceCompatibility.paintingInkCompiledFormatVersion).toBe(14);
    expect(upgraded.compiled.formatVersion).toBe(14);
    expect(upgraded.compiled.shapes[0]?.normalOutset).toBeNull();
  });

  it('retires v12 painted Normal Outset data into a disabled editable setting', () => {
    const legacy = structuredClone(createStudioDocument('Legacy v12')) as any;
    legacy.sourceCompatibility.paintingInkCompiledFormatVersion = 12;
    const shape = legacy.ink.embeddedAssets[0].group.shapes[0];
    shape.kind = 'cuboid';
    delete shape.orientation;
    shape.size = { x: 1, y: 1, z: 1 };
    shape.normalOutset = { distance: 0.22, fill: { surfaces: [] } };
    legacy.ink.embeddedAssets[0].group.compiled.formatVersion = 12;

    const parsed = parseStudioWorkFile(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const upgraded = parsed.document.ink.embeddedAssets[0]!.group;
    expect(upgraded.shapes[0]?.normalOutset).toEqual({ enabled: false, color: '#000000', distance: 0.22 });
    expect(upgraded.compiled.formatVersion).toBe(14);
    expect(upgraded.compiled.shapes[0]?.normalOutset).toBeNull();
  });

  it('rebuilds tampered derived Ink payloads even when their persisted hashes still match', () => {
    const document = createStudioDocument('Untrusted derived payload');
    const group = document.ink.embeddedAssets[0]!.group;
    const shape = group.shapes[0]!;
    const authored = {
      ...shape,
      strokes: [createInkOutlineStroke([
        { x: -0.25, y: 0, pressure: 0.5 },
        { x: 0.25, y: 0, pressure: 1 },
      ], '#ff004d', 0.04)],
    };
    document.ink.embeddedAssets[0]!.group = withCompiledInkGroup({ ...group, shapes: [authored] });
    const untrusted = structuredClone(document) as any;
    const persisted = untrusted.ink.embeddedAssets[0].group.compiled.shapes[0];
    expect(persisted.ribbon.positions.length).toBeGreaterThan(0);
    persisted.ribbon.positions = persisted.ribbon.positions.map(() => 999);

    const parsed = parseStudioWorkFile(JSON.stringify(untrusted));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rebuilt = parsed.document.ink.embeddedAssets[0]!.group.compiled.shapes[0]!;
    expect(rebuilt.sourceHash).toBe(persisted.sourceHash);
    expect(rebuilt.ribbon.positions).not.toContain(999);
  });

  it('rejects duplicate terrain cells', () => {
    const document = createStudioDocument();
    document.terrain.tiles.push({ ...document.terrain.tiles[0]! });
    const parsed = parseStudioWorkFile(JSON.stringify(document));
    expect(parsed.ok).toBe(false);
  });

  it('rejects payloads over the explicit Ink Group limit', () => {
    const document = createStudioDocument();
    document.ink.embeddedAssets = Array.from({ length: MAX_INK_GROUPS + 1 }, () => document.ink.embeddedAssets[0]!);
    expect(parseStudioWorkFile(serializeStudioDocument(document)).ok).toBe(false);
  });

  it('keeps committed author edits stale until the Worker-derived cache is reconciled', () => {
    const document = createStudioDocument();
    const referenceId = document.ink.assetReferences[0]!.id;
    const shapeId = getInkSourceByReference(document, referenceId)!.shapes[0]!.id;
    const edited = updateInkShapeAuthor(document, referenceId, shapeId, (shape) => ({
      ...shape,
      strokes: [...shape.strokes, createInkOutlineStroke([
        { x: -0.25, y: 0, pressure: 0.4 },
        { x: 0.25, y: 0, pressure: 0.8 },
      ], '#000000', 0.04)],
    }));
    const stale = getInkSourceByReference(edited, referenceId)!;
    expect(isInkCompiledCurrent(stale)).toBe(false);
    expect(isInkCompiledCurrent(withCompiledInkGroup(stale, stale))).toBe(true);
  });

  it('records a dragged placement as one undoable transaction', () => {
    const initial = createStudioDocument();
    const referenceId = initial.ink.assetReferences[0]!.id;
    const store = new WorkspaceStore(initial);
    store.transact('Move Ink Group', (document) => ({
      ...document,
      ink: {
        ...document.ink,
        assetReferences: document.ink.assetReferences.map((reference) => reference.id === referenceId
          ? { ...reference, anchorPosition: { x: 3, y: 1, z: -2 } }
          : reference),
      },
    }));
    expect(store.snapshot().canUndo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getDocument().ink.assetReferences[0]!.anchorPosition).toEqual({ x: 0, y: 1, z: 0 });
    expect(store.snapshot().canUndo).toBe(false);
  });

  it('coalesces rapid lighting-style inputs into one undo entry', () => {
    const initial = createStudioDocument('Initial');
    const store = new WorkspaceStore(initial);
    store.transactCoalesced('lighting:phase', 'Set preview lighting', (document) => ({ ...document, name: 'Input 1' }));
    store.transactCoalesced('lighting:phase', 'Set preview lighting', (document) => ({ ...document, name: 'Input 2' }));
    expect(store.getDocument().name).toBe('Input 2');
    expect(store.undo()).toBe(true);
    expect(store.getDocument().name).toBe('Initial');
    expect(store.snapshot().canUndo).toBe(false);
  });

  it('requires a real local save after replacing the current work scene', () => {
    const store = new WorkspaceStore(createStudioDocument('Old'));
    store.replace(createStudioDocument('New'), 'New work scene', false);
    const snapshot = store.snapshot();
    expect(snapshot.revision).toBeGreaterThan(snapshot.savedRevision);
    expect(snapshot.revision).toBeGreaterThan(snapshot.exportedRevision);
    store.markSaved();
    expect(store.snapshot().savedRevision).toBe(store.snapshot().revision);
  });
});
