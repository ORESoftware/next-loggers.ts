import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..');
const targetRoot = join(repositoryRoot, 'sdk', 'nodejs');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rootPackage = await readJson(join(repositoryRoot, 'package.json'));
const releasePackage = await readJson(join(targetRoot, 'package.json'));

if (rootPackage.name !== releasePackage.name || rootPackage.version !== releasePackage.version) {
  throw new Error(
    `sdk/nodejs/package.json drift: expected ${rootPackage.name}@${rootPackage.version}, ` +
      `found ${releasePackage.name}@${releasePackage.version}`,
  );
}

const {
  scripts: _scripts,
  devDependencies: _devDependencies,
  repository: rootRepository,
  ...publishableRoot
} = rootPackage;
const stagedPackage = {
  ...publishableRoot,
  repository: {
    ...rootRepository,
    directory: 'sdk/nodejs',
  },
};

await access(join(repositoryRoot, 'dist', 'cli', 'main.js'));
await mkdir(targetRoot, { recursive: true });

for (const generated of ['dist', 'src', 'README.md', 'LICENSE', '.cli-flags.toml']) {
  await rm(join(targetRoot, generated), { recursive: true, force: true });
}

await cp(join(repositoryRoot, 'dist'), join(targetRoot, 'dist'), {
  recursive: true,
  force: true,
  errorOnExist: false,
});
await cp(join(repositoryRoot, 'src'), join(targetRoot, 'src'), {
  recursive: true,
  force: true,
  errorOnExist: false,
});
for (const file of ['README.md', 'LICENSE', '.cli-flags.toml']) {
await copyFile(join(repositoryRoot, file), join(targetRoot, file));
}
await writeFile(
  join(targetRoot, 'package.json'),
  `${JSON.stringify(stagedPackage, null, 2)}\n`,
  'utf8',
);
await chmod(join(targetRoot, 'dist', 'cli', 'main.js'), 0o755);

// Keep the publish-only package manifest's public surface exactly aligned with
// the root package while retaining the SDK-local file list and repository
// directory. Build metadata and development dependencies never belong in the
// staged npm package.
const { scripts: _scripts, devDependencies: _devDependencies, ...publishable } = rootPackage;
await writeFile(
  join(targetRoot, 'package.json'),
  `${JSON.stringify(
    {
      ...publishable,
      files: releasePackage.files,
      repository: { ...rootPackage.repository, directory: 'sdk/nodejs' },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`staged ${releasePackage.name}@${releasePackage.version} in sdk/nodejs`);
