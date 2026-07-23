const searchRoot = await Promise.resolve(process.cwd());

export default {
  packages: {},
  searchRoot,
  // phase-C (r2g --containerized/containers support): re-run the .r2g tests
  // inside each image so Bun and Deno exercise the installed package too.
  containers: [
    { image: 'node:22' },
    { image: 'oven/bun:latest', cmd: 'bun' },
    { image: 'denoland/deno:latest', cmd: 'deno run --allow-all' },
  ],
};
