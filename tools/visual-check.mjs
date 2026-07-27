import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'],
});
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const baseUrl = process.env.INK_STUDIO_BASE_URL ?? 'http://127.0.0.1:4430/';
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

async function waitUntilReady() {
  await page.waitForFunction(() => !document.querySelector('.loading-cover'), undefined, { timeout: 15_000 });
  try {
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body?.innerText?.slice(0, 400) ?? '',
      controlled: !!navigator.serviceWorker?.controller,
      scripts: [...document.scripts].map((script) => script.src),
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    }));
    const cacheState = await page.evaluate(async () => Object.fromEntries(await Promise.all((await caches.keys()).map(async (key) => [key, (await (await caches.open(key)).keys()).map((request) => request.url)]))));
    throw new Error(`Studio canvas did not recover: ${JSON.stringify({ state, cacheState, errors })}`);
  }
}

async function dragPencil(fromX, fromY, toX, toY, force = 0.55) {
  const bounds = await page.locator('canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no layout bounds.');
  const start = { x: bounds.x + bounds.width * fromX, y: bounds.y + bounds.height * fromY };
  const end = { x: bounds.x + bounds.width * toX, y: bounds.y + bounds.height * toY };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start, pointerType: 'pen', button: 'none', buttons: 0, force: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force });
  for (let step = 1; step <= 14; step += 1) {
    const factor = step / 14;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + (end.x - start.x) * factor,
      y: start.y + (end.y - start.y) * factor,
      pointerType: 'pen',
      button: 'left',
      buttons: 1,
      force,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1, force: 0 });
}

async function dragMouse(fromX, fromY, toX, toY) {
  const bounds = await page.locator('canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no layout bounds.');
  await page.mouse.move(bounds.x + bounds.width * fromX, bounds.y + bounds.height * fromY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * toX, bounds.y + bounds.height * toY, { steps: 8 });
  await page.mouse.up();
}

async function exportWorkFile() {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Exported work file has no readable path.');
  return { json: JSON.parse(await readFile(path, 'utf8')), path };
}

async function layoutSummary(label) {
  return page.evaluate((name) => ({
    label: name,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
    canvas: !!document.querySelector('canvas'),
    groups: document.querySelectorAll('.group-row').length,
    tools: document.querySelectorAll('.tool-tabs button').length,
    lighting: !!document.querySelector('.day-phase-control'),
    viewportGuides: [...document.querySelectorAll('.viewport-guide-options input[type="checkbox"]')].map((input) => ({
      label: input.closest('label')?.textContent?.trim() ?? '',
      checked: input.checked,
    })),
    loading: !!document.querySelector('.loading-cover'),
    pressure: [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Pressure'))?.textContent?.trim() ?? null,
  }), label);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitUntilReady();
  if (await page.getByRole('button', { name: 'Navigate', exact: true }).count()) throw new Error('Retired Navigate mode is still present.');

  // Mouse is intentionally neither an authoring input nor a camera gesture.
  await dragMouse(0.488, 0.405, 0.512, 0.445);
  const mouseOnly = (await exportWorkFile()).json;
  const mouseStrokeCount = mouseOnly.ink.embeddedAssets.flatMap((asset) => asset.group.shapes).flatMap((shape) => shape.strokes).length;
  if (mouseStrokeCount !== 0) throw new Error('Mouse input incorrectly authored Ink.');

  await page.locator('.round-button[title="New Group"]').click();
  if (await page.locator('.group-row').count() !== 2) throw new Error('Creating a second Ink Group failed.');
  if (await page.locator('.group-list .list-delete-button').count() !== 2) throw new Error('Every Group row must expose its own delete button.');

  const pressure = page.getByRole('button', { name: /Pressure/ });
  await pressure.click();
  if (!(await pressure.textContent())?.includes('Off')) throw new Error('Pressure Off toggle did not update.');

  // Painting-compatible dynamic Planes start at a 1x1 authoring surface.
  // Keep the automated stroke inside that visible central surface.
  await dragPencil(0.488, 0.405, 0.512, 0.445);
  await page.getByRole('button', { name: 'Fill Paint' }).click();
  await dragPencil(0.495, 0.412, 0.507, 0.438);
  await page.waitForTimeout(350);

  await pressure.click();
  if (!(await pressure.textContent())?.includes('On')) throw new Error('Pressure On toggle did not update.');

  await page.getByRole('button', { name: 'Shape' }).click();
  for (const name of ['X', 'Y', 'Z', 'Camera']) {
    if (!await page.locator('.plane-create-row').getByRole('button', { name, exact: true }).isVisible()) throw new Error(`Plane ${name} creation button is missing.`);
  }
  await page.getByRole('button', { name: '+ Box', exact: true }).click();
  if (await page.locator('.shape-list-section .list-delete-button').count() !== 4) throw new Error('Every Shape row must expose its drawing visibility and delete buttons.');
  const localTransform = page.getByRole('button', { name: 'Local', exact: true });
  await localTransform.click();
  if (!await localTransform.evaluate((button) => button.classList.contains('active'))) throw new Error('Local Transform space did not activate.');
  const cuboidVisibility = page.locator('.shape-list-row.active .shape-visibility-button');
  if (await cuboidVisibility.count() !== 1) throw new Error('The active Shape must expose exactly one drawing visibility button.');
  await cuboidVisibility.click();
  if (await cuboidVisibility.getAttribute('title') !== 'Allow drawing on Shape') throw new Error('Shape drawing exclusion did not toggle.');
  await cuboidVisibility.click();
  if (await cuboidVisibility.getAttribute('title') !== 'Temporarily hide from drawing') throw new Error('Shape drawing exclusion did not restore.');
  await page.waitForTimeout(400);
  if (await page.locator('.toast.error').count()) throw new Error('Persisting the temporary Shape drawing exclusion failed.');
  if (await page.locator('.shape-inspector .surface-outline-settings').count()) throw new Error('Cuboid must not expose Surface Outline controls.');
  await page.getByRole('button', { name: '+ Cylinder', exact: true }).click();
  if (!await page.locator('.shape-inspector').getByLabel('Radius').isVisible() || !await page.locator('.shape-inspector').getByLabel('Height').isVisible()) {
    throw new Error('Cylinder Radius and Height controls are not visible.');
  }
  const surfaceOutline = page.locator('.shape-inspector .surface-outline-settings');
  if (!await surfaceOutline.isVisible()) throw new Error('Cylinder Surface Outline controls are not visible.');
  await surfaceOutline.getByLabel('Enabled').check();
  const surfaceOutlineWidth = surfaceOutline.getByLabel('Surface outline width');
  await surfaceOutlineWidth.fill('0.035');
  await surfaceOutlineWidth.press('Enter');
  await page.waitForFunction(() => (document.querySelector('[aria-label="Surface outline width"]')?.value ?? '') === '0.035');
  await page.waitForTimeout(100);
  await page.screenshot({ path: 'studio-shape-preview.png', fullPage: true });
  await page.locator('.shape-inspector').getByLabel('Radius').evaluate((input) => {
    input.value = '0.7';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: '+ Frustum', exact: true }).click();
  for (const label of ['Top', 'Bottom', 'Height']) {
    if (!await page.locator('.shape-inspector').getByLabel(label, { exact: true }).isVisible()) throw new Error(`Frustum ${label} control is not visible.`);
  }
  if (await page.locator('.shape-inspector .surface-outline-settings').count()) throw new Error('Frustum must not expose Surface Outline controls.');
  await page.locator('.shape-inspector').getByLabel('Top', { exact: true }).evaluate((input) => {
    input.value = '0.7';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  for (const [tool, label] of [
    ['Outline', 'Outline width'],
    ['Line Erase', 'Outline eraser width'],
    ['Fill Paint', 'Fill brush size'],
  ]) {
    await page.getByRole('button', { name: tool, exact: true }).click();
    if (!await page.getByLabel(label).isVisible()) throw new Error(`${label} direct numeric input is missing.`);
  }

  await page.locator('button[title="Edit and reorder palette"]').click();
  if (await page.locator('.palette-editor-row').count() < 2) throw new Error('Palette editor did not expose editable colors.');
  await page.locator('.palette-editor-row').first().getByTitle('Move right').click();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  for (const label of ['Day and night phase value', 'Sun path tilt X value', 'Sun path offset Z value']) {
    if (!await page.getByLabel(label).isVisible()) throw new Error(`${label} direct numeric input is missing.`);
  }
  const undoButton = page.getByRole('button', { name: 'Undo', exact: true });
  const redoButton = page.getByRole('button', { name: 'Redo', exact: true });
  if (!await undoButton.isVisible() || !await redoButton.isVisible()) throw new Error('Undo and Redo must remain directly visible.');
  if (await page.locator('.lighting-profile-card').count() !== 2) throw new Error('Day and Night lighting profiles are not both visible.');
  if (await page.locator('.lighting-profile-card input[type="color"]').count() !== 10) throw new Error('The complete Day/Night color controls are not available.');
  if (await page.locator('.lighting-section input[type="number"]').count() !== 12) throw new Error('The complete numeric lighting controls are not available.');
  for (const label of ['Show tile edges', 'Show infinite grid', 'Show coordinate axes']) {
    const toggle = page.getByLabel(label);
    if (!await toggle.isVisible() || !await toggle.isChecked()) throw new Error(`${label} must be visible and enabled by default.`);
    await toggle.uncheck();
    if (await toggle.isChecked()) throw new Error(`${label} could not be disabled.`);
    await toggle.check();
    if (!await toggle.isChecked()) throw new Error(`${label} could not be restored.`);
  }
  const currentLighting = await page.evaluate(() => {
    const section = document.querySelector('.lighting-section');
    const numberValue = (label) => section.querySelector(`[aria-label="${label}"]`)?.value;
    const terrainBounce = section.querySelector('.lighting-number-row input[type="number"]')?.value;
    const profiles = [...section.querySelectorAll('.lighting-profile-card')];
    return {
      phase: numberValue('Day and night phase value'),
      tilt: numberValue('Sun path tilt X value'),
      offset: numberValue('Sun path offset Z value'),
      terrainBounce,
      dayMain: profiles[0]?.querySelector('input[type="number"]')?.value,
      nightMain: profiles[1]?.querySelector('input[type="number"]')?.value,
    };
  });
  if (JSON.stringify(currentLighting) !== JSON.stringify({ phase: '0', tilt: '-12', offset: '15', terrainBounce: '0.5', dayMain: '3.2', nightMain: '0.8' })) {
    throw new Error(`New work scene did not use Painting lighting defaults: ${JSON.stringify(currentLighting)}`);
  }
  const dayPosition = page.getByLabel('Day and night phase value');
  await dayPosition.fill('0.35');
  await dayPosition.press('Enter');
  await page.waitForFunction(() => (document.querySelector('[aria-label="Day and night phase value"]')?.value ?? '') === '0.35');
  await page.locator('button[title="Undo"]').click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Day and night phase value"]')?.value ?? '') === '0');
  await page.locator('button[title="Redo"]').click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Day and night phase value"]')?.value ?? '') === '0.35');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="Day and night phase value"]')?.value ?? '') === '0');
  const dayMainIntensity = page.locator('.lighting-profile-card').first().locator('input[type="number"]').first();
  await dayMainIntensity.evaluate((input) => {
    input.value = '2.7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.lighting-profile-card input[type="number"]')?.value === '2.7');
  await undoButton.click();
  await page.waitForFunction(() => document.querySelector('.lighting-profile-card input[type="number"]')?.value === '3.2');
  await page.screenshot({ path: 'studio-lighting.png', fullPage: true });

  await page.getByRole('button', { name: 'Terrain' }).click();
  if (await page.locator('.terrain-tools .terrain-tool').count() !== 3) throw new Error('Terrain Tile tools are not three direct preview buttons.');
  if (await page.locator('.terrain-direction-pad button').count() !== 4) throw new Error('Terrain direction is not exposed as four direct arrow buttons.');
  if (await page.locator('.terrain-axis-buttons button').count() !== 3) throw new Error('Terrain X/Y/Z work-plane buttons are missing.');
  await page.locator('.terrain-tools .terrain-tool').nth(1).click();
  await page.locator('.terrain-direction-pad .east').click();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await dragPencil(0.46, 0.43, 0.54, 0.54);
  await page.waitForTimeout(150);

  const exportedDownload = await exportWorkFile();
  const exported = exportedDownload.json;
  const groups = exported.ink?.embeddedAssets ?? [];
  const strokePoints = groups.flatMap((asset) => asset.group.shapes).flatMap((shape) => shape.strokes).flatMap((stroke) => stroke.points);
  const fillBlocks = groups.flatMap((asset) => asset.group.shapes).flatMap((shape) => shape.fill.surfaces).flatMap((surface) => surface.blocks);
  const surfaceOutlines = groups.flatMap((asset) => asset.group.shapes).filter((shape) => shape.surfaceOutline?.enabled);
  const shapes = groups.flatMap((asset) => asset.group.shapes);
  const cylinder = shapes.find((shape) => shape.kind === 'cylinder');
  const frustum = shapes.find((shape) => shape.kind === 'frustum');
  if (groups.length !== 2) throw new Error(`Expected 2 exported Groups, received ${groups.length}.`);
  if (strokePoints.length < 2) throw new Error('The browser drawing gesture did not produce editable outline points.');
  if (!strokePoints.every((point) => point.pressure === 1)) throw new Error('Pressure Off did not persist pressure: 1 for new points.');
  if (fillBlocks.length < 1) throw new Error('The browser Fill Paint gesture did not produce sparse editable Fill blocks.');
  if (surfaceOutlines.length !== 1 || surfaceOutlines[0].surfaceOutline.width !== 0.035) {
    throw new Error('Surface Outline author settings were not exported exactly.');
  }
  if (!cylinder || cylinder.radius !== 0.7 || !frustum || frustum.topSize !== 0.7) throw new Error('Cylinder or Frustum dimensions were not exported exactly.');
  if (exported.sourceCompatibility?.paintingInkCompiledFormatVersion !== 16) throw new Error('The exported work file is not marked Ink compiled format v16.');
  if ((exported.terrain?.tiles?.length ?? 25) >= 25) throw new Error('The terrain erase gesture did not remove any reference cells.');

  await page.getByRole('button', { name: 'New' }).click();
  if (await page.locator('.group-row').count() !== 1) throw new Error('Creating a replacement work scene failed.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles(exportedDownload.path);
  await page.waitForFunction(() => document.querySelectorAll('.group-row').length === 2, undefined, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('.save-state');
    return status && !status.classList.contains('pending') && status.textContent?.includes('Saved locally');
  }, undefined, { timeout: 10_000 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'studio-preview.png', fullPage: true });
  const summaries = [await layoutSummary('desktop')];

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service Worker API is unavailable.');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Service Worker did not claim the page.')), 10_000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
      });
    }
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitUntilReady();
  summaries.push(await layoutSummary('offline-reload'));
  await page.getByRole('button', { name: 'Lighting', exact: true }).click();

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(100);
  if (!await page.locator('.day-phase-control').isVisible()) throw new Error('Day/night control is not visible at iPad landscape size.');
  await page.screenshot({ path: 'studio-ipad-landscape.png', fullPage: true });
  summaries.push(await layoutSummary('ipad-landscape'));

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(100);
  if (!await page.locator('.day-phase-control').isVisible()) throw new Error('Day/night control is not visible at iPad portrait size.');
  await page.screenshot({ path: 'studio-ipad-portrait.png', fullPage: true });
  summaries.push(await layoutSummary('ipad-portrait'));

  for (const summary of summaries) {
    if (summary.bodyWidth > summary.viewport.width || summary.bodyHeight > summary.viewport.height) {
      throw new Error(`${summary.label} layout overflows the viewport.`);
    }
    if (summary.groups !== 2 || (summary.tools !== 6 && !summary.lighting)) {
      throw new Error(`${summary.label} did not restore the complete editable workspace.`);
    }
  }
  process.stdout.write(`${JSON.stringify({ summaries, exported: {
    groups: groups.length,
    strokePoints: strokePoints.length,
    fillBlocks: fillBlocks.length,
    surfaceOutlines: surfaceOutlines.length,
    shapes: shapes.map((shape) => shape.kind),
    terrainTiles: exported.terrain.tiles.length,
  }, errors }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await context.setOffline(false).catch(() => undefined);
  await browser.close();
}
