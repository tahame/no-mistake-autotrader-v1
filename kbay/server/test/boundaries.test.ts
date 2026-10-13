import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Modular boundaries, enforced: a module may use another module only through its index.ts,
// and order management may not import any other module at all (so it can be split out).
const root = path.resolve(__dirname, '../src/modules');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('module boundaries', () => {
  const all = files(root);
  const imports = all.flatMap((file) => {
    const mod = path.relative(root, file).split(path.sep)[0]!;
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(/from '(\.[^']+)'/g)].map((m) => {
      const target = path.resolve(path.dirname(file), m[1]!);
      const rel = path.relative(root, target);
      return { file: path.relative(root, file), mod, target: rel, targetMod: rel.startsWith('..') ? null : rel.split(path.sep)[0]! };
    });
  });

  it('cross-module imports go through index.js only', () => {
    const bad = imports.filter((i) => i.targetMod && i.targetMod !== i.mod && path.basename(i.target) !== 'index.js');
    expect(bad).toEqual([]);
  });

  it('order management depends on no other module', () => {
    const bad = imports.filter((i) => i.mod === 'orders' && i.targetMod && i.targetMod !== 'orders');
    expect(bad).toEqual([]);
  });

  it('no module reaches into the composition root', () => {
    const bad = imports.filter((i) => i.target.includes('wiring') || i.target.includes('workers'));
    expect(bad).toEqual([]);
  });
});
