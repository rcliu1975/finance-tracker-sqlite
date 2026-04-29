#!/usr/bin/env node

const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const cwd = process.cwd();
const hasOutput = argv.includes("--output");
const nextArgs = hasOutput ? argv : [...argv, "--output", path.join(cwd, "firebase-config.js")];
const result = spawnSync("node", [path.join(__dirname, "generate-app-config.js"), ...nextArgs], {
  cwd,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
