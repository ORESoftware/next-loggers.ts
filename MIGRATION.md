# Canonical repository migration

The canonical upstream is now `https://github.com/ores-otel/ores.otel.log.git`.

The preserved legacy remote is `https://github.com/ORESoftware/next-loggers.ts.git`.

For an existing clone:

```sh
git remote rename origin legacy
git remote add origin https://github.com/ores-otel/ores.otel.log.git
git fetch --all --prune --tags
git branch --set-upstream-to=origin/main main
```

The new repository was initialized from the complete legacy Git history, including branches and tags.
