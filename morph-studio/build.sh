#!/bin/sh
# Vercel build for Morph Studio (project root directory = morph-studio).
# The static app is fetched from the public GitHub branch and published from ./public;
# the two serverless functions in ./api are deployed from this directory.
set -eu
REF="${MORPH_BRANCH:-claude/zen-edison-db6da2}"
URL="https://codeload.github.com/karimo1990/test/tar.gz/refs/heads/$REF"
rm -rf src public && mkdir -p src public
curl -fsSL "$URL" | tar xz -C src
cp -R src/*/morph-studio/. public/
rm -rf public/api public/package.json public/package-lock.json public/vercel.json public/build.sh public/node_modules
ls -la public public/vendor/three
