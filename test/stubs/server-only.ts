// `server-only` is a build-time marker: Next's bundler aliases it away, and the
// real package throws if anything actually imports it at runtime. Tests import
// the same modules outside Next, so they map it here instead — see
// tsconfig.test.json. Importing this file is a no-op, which is exactly what the
// marker means once you are past the bundler.
export {};
