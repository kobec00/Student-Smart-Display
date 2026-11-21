// Copies the fonts from node_modules into public/fonts so the display works offline
// (and without devDependencies on the Pi):
//   Inter Tight (variable weight) for the interface, the clock and the big numbers,
//   JetBrains Mono (variable weight) for labels, timestamps and the HUD details.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'fonts');
mkdirSync(out, { recursive: true });
const files = {
  'inter-tight': ['inter-tight-latin-wght-normal', 'inter-tight-latin-ext-wght-normal'],
  'jetbrains-mono': ['jetbrains-mono-latin-wght-normal', 'jetbrains-mono-latin-ext-wght-normal'],
};
for (const [pkg, names] of Object.entries(files)) {
  for (const name of names) {
    copyFileSync(join(root, 'node_modules', '@fontsource-variable', pkg, 'files', `${name}.woff2`), join(out, `${name}.woff2`));
  }
}
console.log('Fonts copied to public/fonts');
