import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function collect(directory, outputDirectory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, outputDirectory, files);
    else if (entry.name !== 'sw.js' && !entry.name.endsWith('.map')) files.push(`./${relative(outputDirectory, absolute).replaceAll('\\', '/')}`);
  }
}

export async function createServiceWorkerSource(outputDirectory, packageVersion) {
  const files = [];
  await collect(outputDirectory, outputDirectory, files);
  files.sort();
  const revision = createHash('sha256');
  for (const file of files) {
    revision.update(file);
    revision.update('\0');
    revision.update(await readFile(join(outputDirectory, file.slice(2))));
    revision.update('\0');
  }
  const cacheRevision = revision.digest('hex').slice(0, 12);
  const cacheName = `ink-asset-studio-${packageVersion}-${cacheRevision}`;
  return `const CACHE_PREFIX = 'ink-asset-studio-';
const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_FILES = ${JSON.stringify(files, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
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
}

export async function generateServiceWorker(
  outputDirectory = resolve('dist'),
  packageJsonPath = resolve('package.json'),
) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const source = await createServiceWorkerSource(outputDirectory, packageJson.version);
  await writeFile(join(outputDirectory, 'sw.js'), source, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await generateServiceWorker();
}
