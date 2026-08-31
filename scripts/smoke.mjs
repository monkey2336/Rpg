/**
 * Shell smoke test.
 *
 * Boots the real app, plays it, and captures the full view, the boss set-piece,
 * the widget at both sizes, and the restored window — then asserts the window
 * geometry the dual-mode spec calls for (360x220 corner-snapped, always-on-top,
 * non-focusable, 480x320 on hover, full window hidden while docked).
 *
 * On a headless Linux box it wraps itself in xvfb-run automatically.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'out', 'smoke');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const electron = join(root, 'node_modules', '.bin', 'electron');
const headless = process.platform === 'linux' && !process.env.DISPLAY;
// SwiftShader is the only GL available on a headless box, and recent Chromium
// requires an explicit opt-in before it will back WebGL with it.
const [cmd, args] = headless
  ? ['xvfb-run', ['-a', electron, '.', '--no-sandbox', '--enable-unsafe-swiftshader']]
  : [electron, ['.']];

console.log(`running shell smoke test${headless ? ' under xvfb' : ''}...`);
const child = spawn(cmd, args, {
  cwd: root,
  env: { ...process.env, CENOTAPH_SMOKE: outDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
child.stdout.on('data', (d) => {
  const line = String(d);
  if (line.startsWith('[')) process.stdout.write(line);
});

const code = await new Promise((resolve) => child.on('close', resolve));
const reportPath = join(outDir, 'report.json');
if (!existsSync(reportPath)) {
  console.error(`no report written (exit ${code})\n${stderr.split('\n').slice(-15).join('\n')}`);
  process.exit(1);
}
const report = JSON.parse(await readFile(reportPath, 'utf8'));

const checks = [
  ['boot succeeded', report.ok === true],
  ['widget is 360x220', report.widgetBounds?.width === 360 && report.widgetBounds?.height === 220],
  ['widget expands to 480x320', report.widgetHoverBounds?.width === 480 && report.widgetHoverBounds?.height === 320],
  ['widget stays on top', report.widgetAlwaysOnTop === true],
  ['widget never takes focus', report.widgetFocusable === false],
  ['full window hides while docked', report.fullVisible === false],
  ['full window restores', report.restoredVisible === true],
  ['boss encounter rendered', report.arena?.bossSpawned === true],
  ['route runs while docked', !!report.route?.zoneId],
  ['docked screens render', report.screensCaptured === 5],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (report.error) console.error(`\nerror: ${report.error}`);
console.log(`\ncaptures in ${outDir}`);
process.exit(failed === 0 && report.ok ? 0 : 1);
