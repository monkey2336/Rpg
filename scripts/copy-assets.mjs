// Copies non-TS renderer assets (html/css) into dist so file:// loads resolve
// next to their compiled module. No bundler by design: the renderer is plain
// ES modules, which keeps the widget's cold-start cost near zero.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/renderer/full/index.html', 'dist/renderer/full/index.html'],
  ['src/renderer/full/style.css', 'dist/renderer/full/style.css'],
  ['src/renderer/widget/index.html', 'dist/renderer/widget/index.html'],
  ['src/renderer/widget/style.css', 'dist/renderer/widget/style.css'],
];
for (const [from, to] of pairs) {
  await mkdir(dirname(join(root, to)), { recursive: true });
  await cp(join(root, from), join(root, to));
}
