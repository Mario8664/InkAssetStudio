import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceWorkerSource } from './generate-service-worker.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ink-studio-sw-test-'));

try {
  const indexPath = join(directory, 'index.html');
  await writeFile(indexPath, '<!doctype html><title>First</title>', 'utf8');
  const first = await createServiceWorkerSource(directory, 'test');
  await writeFile(indexPath, '<!doctype html><title>Second</title>', 'utf8');
  const second = await createServiceWorkerSource(directory, 'test');

  const cacheName = /const CACHE_NAME = "([^"]+)";/;
  const firstName = cacheName.exec(first)?.[1];
  const secondName = cacheName.exec(second)?.[1];
  if (!firstName || !secondName || firstName === secondName) {
    throw new Error('Service Worker cache revision did not change when fixed-name file contents changed.');
  }
  if (!second.includes('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME')) {
    throw new Error('Service Worker cache cleanup is not scoped to Ink Asset Studio.');
  }
  if (!second.includes("caches.match('./index.html'")) {
    throw new Error('Service Worker is missing the relative GitHub Pages navigation fallback.');
  }
  console.log('Service Worker content revision, cache ownership, and navigation fallback tests passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
