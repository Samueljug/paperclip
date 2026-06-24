# Brief Coverage Gate

Blocks an issue from advancing unless its brief-artifact-manifest is complete and its coverage-matrix has no uncovered required items or unwaived off-track rows. Enforced via host blocker semantics; no core edits.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

`pnpm dev` rebuilds the worker, manifest, and UI bundles into `dist/`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.

This scaffold snapshots `@paperclipai/plugin-sdk` and `@paperclipai/shared` from a local Paperclip checkout at:

`<FORK>/packages/plugins/sdk`

The packed tarballs live in `.paperclip-sdk/` for local development. Before publishing this plugin, switch those dependencies to published package versions once they are available on npm.



## Install Into Paperclip

```bash
paperclipai plugin install <FORK>/dark-factory/plugins/brief-coverage-gate
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
