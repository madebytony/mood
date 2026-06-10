#!/bin/bash
# Mood v2 — double-click to run (keeps dependencies up to date automatically)
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required — install it from https://nodejs.org"
  read -r -p "Press Enter to close…"; exit 1
fi
npm install --no-audit --no-fund || { read -r -p "npm install failed — press Enter to close…"; exit 1; }
( sleep 4 && open http://localhost:3000 ) &
npm run dev
