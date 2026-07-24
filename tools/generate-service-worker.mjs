import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const outputDirectory = resolve('dist');
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.name !== 'sw.js' && !entry.name.endsWith('.map')) files.push(`./${relative(outputDirectory, absolute).replaceAll('\\', '/')}`);
  }
}

await collect(outputDirectory);
files.sort();
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const cacheRevision = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
const cacheName = `ink-asset-studio-${packageJson.version}-${cacheRevision}`;
const source = `const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_FILES = ${JSON.stringify(files, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request, { ignoreVary: true }).then((cached) => cached || fetch(event.request).then((response) => {
    if (!response || response.status !== 200 || response.type === 'opaque') return response;
    const copy = response.clone();
    void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(async (error) => {
    if (event.request.mode === 'navigate') return (await caches.match('./index.html', { ignoreVary: true })) || Response.error();
    throw error;
  })));
});
`;

await writeFile(join(outputDirectory, 'sw.js'), source, 'utf8');
