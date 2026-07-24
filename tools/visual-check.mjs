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

async function dragCanvas(fromX, fromY, toX, toY) {
  const bounds = await page.locator('canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no layout bounds.');
  await page.mouse.move(bounds.x + bounds.width * fromX, bounds.y + bounds.height * fromY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * toX, bounds.y + bounds.height * toY, { steps: 14 });
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

  await page.locator('.round-button[title="New Group"]').click();
  if (await page.locator('.group-row').count() !== 2) throw new Error('Creating a second Ink Group failed.');

  const pressure = page.getByRole('button', { name: /Pressure/ });
  await pressure.click();
  if (!(await pressure.textContent())?.includes('Off')) throw new Error('Pressure Off toggle did not update.');

  // Painting-compatible dynamic Planes start at a 1x1 authoring surface.
  // Keep the automated stroke inside that visible central surface.
  await dragCanvas(0.488, 0.405, 0.512, 0.445);
  await page.getByRole('button', { name: 'Fill Paint' }).click();
  await dragCanvas(0.495, 0.412, 0.507, 0.438);
  await page.waitForTimeout(350);

  await pressure.click();
  if (!(await pressure.textContent())?.includes('On')) throw new Error('Pressure On toggle did not update.');

  await page.getByRole('button', { name: 'Shape' }).click();
  await page.getByRole('button', { name: '+ Box', exact: true }).click();
  const normalOutset = page.locator('.normal-outset-settings');
  if (!await normalOutset.isVisible()) throw new Error('Cuboid Normal Outset controls are not visible.');
  await normalOutset.getByLabel('Enabled').check();
  await normalOutset.getByLabel('Shell Color').evaluate((input) => {
    input.value = '#5a3e16';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await normalOutset.getByLabel('Shell Outset').evaluate((input) => {
    input.value = '0.08';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.normal-outset-settings output')?.textContent === '0.080');
  await page.waitForTimeout(100);
  await page.screenshot({ path: 'studio-shape-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Draw' }).click();

  await page.locator('button[title="Edit and reorder palette"]').click();
  if (await page.locator('.palette-editor-row').count() < 2) throw new Error('Palette editor did not expose editable colors.');
  await page.locator('.palette-editor-row').first().getByTitle('Move right').click();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Navigate' }).click();
  const undoButton = page.getByRole('button', { name: 'Undo', exact: true });
  const redoButton = page.getByRole('button', { name: 'Redo', exact: true });
  if (!await undoButton.isVisible() || !await redoButton.isVisible()) throw new Error('Undo and Redo must remain directly visible.');
  if (await page.locator('.lighting-profile-card').count() !== 2) throw new Error('Day and Night lighting profiles are not both visible.');
  if (await page.locator('.lighting-profile-card input[type="color"]').count() !== 10) throw new Error('The complete Day/Night color controls are not available.');
  if (await page.locator('.lighting-section input[type="number"]').count() !== 9) throw new Error('The complete numeric lighting controls are not available.');
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
    const ranges = [...section.querySelectorAll('input[type="range"]')];
    const numbers = [...section.querySelectorAll('input[type="number"]')];
    return {
      phase: ranges[0]?.value,
      tilt: ranges[1]?.value,
      offset: ranges[2]?.value,
      terrainBounce: numbers[0]?.value,
      dayMain: numbers[1]?.value,
      nightMain: numbers[5]?.value,
    };
  });
  if (JSON.stringify(currentLighting) !== JSON.stringify({ phase: '0', tilt: '-12', offset: '15', terrainBounce: '0.5', dayMain: '3.2', nightMain: '0.8' })) {
    throw new Error(`New work scene did not use Painting lighting defaults: ${JSON.stringify(currentLighting)}`);
  }
  const dayPosition = page.locator('.lighting-section input[type="range"]').first();
  await dayPosition.evaluate((input) => {
    input.value = '0.35';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.lighting-section output')?.textContent === '0.35');
  await page.locator('button[title="Undo"]').click();
  await page.waitForFunction(() => document.querySelector('.lighting-section output')?.textContent === '0.00');
  await page.locator('button[title="Redo"]').click();
  await page.waitForFunction(() => document.querySelector('.lighting-section output')?.textContent === '0.35');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lighting-section output')?.textContent === '0.00');
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
  await page.getByRole('button', { name: 'Erase' }).click();
  await dragCanvas(0.46, 0.43, 0.54, 0.54);
  await page.waitForTimeout(150);

  const exportedDownload = await exportWorkFile();
  const exported = exportedDownload.json;
  const groups = exported.ink?.embeddedAssets ?? [];
  const strokePoints = groups.flatMap((asset) => asset.group.shapes).flatMap((shape) => shape.strokes).flatMap((stroke) => stroke.points);
  const fillBlocks = groups.flatMap((asset) => asset.group.shapes).flatMap((shape) => shape.fill.surfaces).flatMap((surface) => surface.blocks);
  const normalOutsets = groups.flatMap((asset) => asset.group.shapes).filter((shape) => shape.normalOutset?.enabled);
  if (groups.length !== 2) throw new Error(`Expected 2 exported Groups, received ${groups.length}.`);
  if (strokePoints.length < 2) throw new Error('The browser drawing gesture did not produce editable outline points.');
  if (!strokePoints.every((point) => point.pressure === 1)) throw new Error('Pressure Off did not persist pressure: 1 for new points.');
  if (fillBlocks.length < 1) throw new Error('The browser Fill Paint gesture did not produce sparse editable Fill blocks.');
  if (normalOutsets.length !== 1 || normalOutsets[0].normalOutset.color !== '#5a3e16' || normalOutsets[0].normalOutset.distance !== 0.08) {
    throw new Error('Normal Outset author settings were not exported exactly.');
  }
  if (exported.sourceCompatibility?.paintingInkCompiledFormatVersion !== 13) throw new Error('The exported work file is not marked Ink compiled format v13.');
  if ((exported.terrain?.tiles?.length ?? 25) >= 25) throw new Error('The terrain erase gesture did not remove any reference cells.');

  await page.getByRole('button', { name: 'New' }).click();
  if (await page.locator('.group-row').count() !== 1) throw new Error('Creating a replacement work scene failed.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles(exportedDownload.path);
  await page.waitForFunction(() => document.querySelectorAll('.group-row').length === 2, undefined, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Draw' }).click();
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
  await page.getByRole('button', { name: 'Navigate' }).click();

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
    normalOutsets: normalOutsets.length,
    terrainTiles: exported.terrain.tiles.length,
  }, errors }, null, 2)}\n`);
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await context.setOffline(false).catch(() => undefined);
  await browser.close();
}
