import { copyFileSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sourceDirectory = path.join(projectRoot, 'src', 'infra', 'sqlite', 'migrations');
const migrationNamePattern = /^([0-9]{3})_[a-z][a-z0-9_-]*\.sql$/;
const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

if (comparable(realpathSync(sourceDirectory)) !== comparable(sourceDirectory)) {
  throw new Error('Migration source directory must be inside the project.');
}

function ensureBuildDirectory(parent, name) {
  const directory = path.join(parent, name);
  mkdirSync(directory, { recursive: true });
  if (comparable(realpathSync(directory)) !== comparable(directory)) {
    throw new Error('Migration output directory must be inside the project build directory.');
  }
  return directory;
}

const sourceFiles = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.name.endsWith('.sql'))
  .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
if (sourceFiles.length === 0) throw new Error('No SQL migrations were found.');
for (const [index, entry] of sourceFiles.entries()) {
  const match = migrationNamePattern.exec(entry.name);
  if (!entry.isFile() || match === null || Number(match[1]) !== index + 1) {
    throw new Error('SQL migration assets must be regular, consecutively numbered files.');
  }
}

const buildDirectory = ensureBuildDirectory(projectRoot, 'dist');
const infraDirectory = ensureBuildDirectory(buildDirectory, 'infra');
const sqliteDirectory = ensureBuildDirectory(infraDirectory, 'sqlite');
const outputDirectory = ensureBuildDirectory(sqliteDirectory, 'migrations');

// Remove only previously copied SQL assets, so a removed source migration cannot linger in dist.
for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
  if (entry.name.endsWith('.sql')) {
    if (!entry.isFile()) throw new Error('Migration output contains a nonregular SQL entry.');
    unlinkSync(path.join(outputDirectory, entry.name));
  }
}

for (const entry of sourceFiles) {
  copyFileSync(path.join(sourceDirectory, entry.name), path.join(outputDirectory, entry.name));
}
