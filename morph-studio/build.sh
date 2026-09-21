#!/bin/sh
# Vercel build for Morph Studio (project root directory = morph-studio).
# The app is fetched from the public GitHub branch: static files → public/, serverless
# sources → api-src/. The deployed api/*.js are one-line shims that re-export from api-src/
# (export { default } from '../api-src/<name>.js'), so the functions always track the branch.
set -eu
REF="${MORPH_BRANCH:-claude/zen-edison-db6da2}"
URL="https://codeload.github.com/karimo1990/test/tar.gz/refs/heads/$REF"
rm -rf src public api-src && mkdir -p src public api-src
curl -fsSL "$URL" | tar xz -C src
cp -R src/*/morph-studio/. public/
cp src/*/morph-studio/api/*.js api-src/
rm -rf public/api public/package.json public/package-lock.json public/vercel.json public/build.sh public/node_modules
ls -la public api-src
