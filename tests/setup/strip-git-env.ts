// Vitest setup file: no test sees an inherited GIT_* variable. A Git hook (or another checkout's script) that runs the
// tests exports GIT_DIR, and every scratch repository a test builds with a bare `git` call would then be built in the
// repository the variable names. scripts/gate.mjs strips them for gate steps; this covers `bun run --bun test` run
// directly. A test that needs one sets it itself, on the child it spawns.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
