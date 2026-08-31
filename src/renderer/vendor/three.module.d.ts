/**
 * Type shim for the vendored Three.js build.
 *
 * The renderer imports `../vendor/three.module.js` by relative path rather than
 * by package name: there is no bundler in this project, the page is loaded over
 * file://, and its CSP is `script-src 'self'`, so the library has to be a real
 * file sitting next to the code that imports it. This declaration lets tsc
 * type-check against the installed @types/three while emitting that relative
 * specifier verbatim.
 *
 * scripts/copy-assets.mjs copies the build into dist/src/renderer/vendor/.
 */
export * from 'three';
