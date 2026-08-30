// Copies non-TS renderer assets (html/css) into dist so file:// loads resolve
// next to their compiled module. No bundler by design: the renderer is plain
// ES modules, which keeps the widget's cold-start cost near zero.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// tsc keeps the src/ prefix (rootDir is the repo root), so assets have to land
// beside their compiled modules at dist/src/renderer/... not dist/renderer/...
const pairs = [
  'src/renderer/full/index.html',
  'src/renderer/full/style.css',
  'src/renderer/widget/index.html',
  'src/renderer/widget/style.css',
].map((f) => [f, join('dist', f)]);
for (const [from, to] of pairs) {
  await mkdir(dirname(join(root, to)), { recursive: true });
  await cp(join(root, from), join(root, to));
}
