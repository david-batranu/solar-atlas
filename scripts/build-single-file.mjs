#!/usr/bin/env node
/**
 * Build a single self-contained HTML file.
 *
 * The dev site uses native ES modules, which browsers refuse to load from a
 * file:// URL. This tiny in-house bundler preserves module scoping without any
 * dependencies: each module becomes an IIFE, imports are destructured from a
 * private registry, and exports are returned into it. The result is a classic
 * script, so dist/solar-atlas.html can simply be double-clicked.
 *
 *   node scripts/build-single-file.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODULE_DIR = path.join(ROOT, 'src', 'js');
const ENTRY = 'main';
const MODULE_ORDER = [
  'data',
  'ephemeris',
  'orbits',
  'camera',
  'renderer',
  'ui',
  'main',
];

const MODULE_KEYS = new Set(MODULE_ORDER);

function moduleNameFromSpecifier(specifier) {
  const base = specifier.split('/').pop()?.replace(/\.js$/, '');
  return base || '';
}

/**
 * Remove top-of-file import statements (which may span lines) and return the
 * binding declarations needed inside the module IIFE.
 */
function extractImports(source, ownName) {
  const lines = source.split('\n');
  const kept = [];
  const bindings = [];
  const dependencies = new Set();

  let i = 0;
  let seenCode = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!seenCode && /^\s*import\b/.test(line)) {
      let statement = line;
      while (
        i + 1 < lines.length
        && !/from\s+['"][^'"]+['"]\s*;?\s*$/.test(statement)
        && !/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(statement)
      ) {
        i += 1;
        statement += `\n${lines[i]}`;
      }
      const sideEffect = /^\s*import\s+['"]([^'"]+)['"]/.exec(statement);
      if (sideEffect) {
        const dep = moduleNameFromSpecifier(sideEffect[1]);
        if (!MODULE_KEYS.has(dep)) {
          throw new Error(`${ownName}: unknown side-effect import ${sideEffect[1]}`);
        }
        dependencies.add(dep);
        bindings.push(`// side-effect import ${dep}`);
        i += 1;
        continue;
      }

      const match = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/.exec(statement.trim());
      if (!match) {
        throw new Error(`${ownName}: could not parse import statement:\n${statement}`);
      }
      const clause = match[1].trim();
      const dep = moduleNameFromSpecifier(match[2]);
      if (!MODULE_KEYS.has(dep)) {
        throw new Error(`${ownName}: unknown import ${match[2]}`);
      }
      dependencies.add(dep);

      if (clause.startsWith('*')) {
        const ns = clause.replace(/^\*\s+as\s+/, '').trim();
        bindings.push(`const ${ns} = __SS[${JSON.stringify(dep)}];`);
      } else if (clause.startsWith('{')) {
        const inner = clause.replace(/^\{/, '').replace(/\}$/, '');
        const pairs = inner
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const alias = part.split(/\s+as\s+/);
            return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : part;
          });
        bindings.push(`const { ${pairs.join(', ')} } = __SS[${JSON.stringify(dep)}];`);
      } else if (clause) {
        // Default imports are not used in this project, but supply a clear error.
        throw new Error(`${ownName}: unsupported default import ${clause}`);
      }
      i += 1;
      continue;
    }

    if (line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')) {
      seenCode = true;
    }
    kept.push(line);
    i += 1;
  }

  return { code: kept.join('\n'), bindings, dependencies };
}

function extractExportNames(code) {
  const names = new Set();
  const regex = /^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let match;
  while ((match = regex.exec(code)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function transformModule(name) {
  const file = path.join(MODULE_DIR, `${name}.js`);
  const source = readFileSync(file, 'utf8');
  const { code, bindings, dependencies } = extractImports(source, name);

  const exportNames = extractExportNames(code);
  const stripped = code.replace(/^\s*export\s+/gm, '');
  if (/^\s*(?:import|export)\s/m.test(stripped)) {
    throw new Error(`${name}: an import/export survived transformation`);
  }

  const returnObject = exportNames.length
    ? `{ ${exportNames.join(', ')} }`
    : '{}';

  return {
    name,
    dependencies: [...dependencies],
    source: `__SS[${JSON.stringify(name)}] = (() => {
"use strict";
${bindings.join('\n')}
${stripped}
return ${returnObject};
})();`,
  };
}

function topologicalOrder(modules) {
  const byName = new Map(modules.map((module) => [module.name, module]));
  const result = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular module dependency at ${name}`);
    visiting.add(name);
    const module = byName.get(name);
    if (!module) throw new Error(`Missing module ${name}`);
    for (const dep of module.dependencies) visit(dep);
    visiting.delete(name);
    visited.add(name);
    result.push(module);
  }

  for (const name of MODULE_ORDER) visit(name);
  return result;
}

function build() {
  const modules = topologicalOrder(MODULE_ORDER.map(transformModule));
  const bundle = `(() => {
"use strict";
const __SS = Object.create(null);
${modules.map((module) => module.source).join('\n\n')}
})();`;

  // Validate syntax without executing the app.
  // eslint-disable-next-line no-new-func
  new Function(bundle);

  const htmlPath = path.join(ROOT, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  const css = readFileSync(path.join(ROOT, 'src', 'css', 'styles.css'), 'utf8');
  const favicon = readFileSync(path.join(ROOT, 'assets', 'favicon.svg'), 'utf8');

  const cssTag = /<link\s+rel="stylesheet"\s+href="\.\/src\/css\/styles\.css"\s*>/;
  if (!cssTag.test(html)) throw new Error('Could not find the stylesheet link in index.html');
  html = html.replace(cssTag, `<style>\n${css}\n</style>`);

  const iconTag = /<link\s+rel="icon"\s+href="\.\/assets\/favicon\.svg"\s+type="image\/svg\+xml"\s*>/;
  if (!iconTag.test(html)) throw new Error('Could not find the favicon link in index.html');
  html = html.replace(
    iconTag,
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(favicon)}">`,
  );

  const scriptTag = /<script\s+type="module"\s+src="\.\/src\/js\/main\.js"\s*><\/script>/;
  if (!scriptTag.test(html)) throw new Error('Could not find the entry script in index.html');
  const safeBundle = bundle.replace(/<\/script/gi, '<\\/script');
  html = html.replace(scriptTag, `<script>\n${safeBundle}\n</script>`);

  // The built document must not depend on local files.
  if (/<script[^>]+src=|<link[^>]+href="\.\//.test(html)) {
    throw new Error('Single-file build still references external local assets');
  }

  mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const outPath = path.join(ROOT, 'dist', 'solar-atlas.html');
  writeFileSync(outPath, html, 'utf8');

  const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`Built ${path.relative(ROOT, outPath)} (${sizeKb} kB)`);
  console.log(`Modules: ${modules.map((module) => module.name).join(' → ')}`);
}

build();
