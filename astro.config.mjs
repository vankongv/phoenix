import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import preact from '@astrojs/preact';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/**
 * Vite plugin: axobject-query ships CJS-only (no ESM exports). When Vite
 * serves it directly to the browser the named-export syntax fails. We intercept
 * the import, load the module in Node.js, serialise all four exported Maps and
 * return pure ESM that reconstructs them from JSON.
 */
function axobjectQueryEsmPlugin() {
  return {
    name: 'axobject-query-esm',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'axobject-query') return '\0virtual:axobject-query';
    },
    load(id) {
      if (id !== '\0virtual:axobject-query') return;

      const mod = _require('axobject-query');

      // Serialise each Map as a JSON-compatible array of [key, value] pairs.
      const ser = (map) => JSON.stringify([...map.entries()]);

      return [
        `export const AXObjectRoles    = new Map(${ser(mod.AXObjectRoles)});`,
        `export const AXObjects        = new Map(${ser(mod.AXObjects)});`,
        `export const AXObjectElements = new Map(${ser(mod.AXObjectElements)});`,
        `export const elementAXObjects = new Map(${ser(mod.elementAXObjects)});`,
        `export default { AXObjectRoles, AXObjects, AXObjectElements, elementAXObjects };`,
      ].join('\n');
    },
  };
}

export default defineConfig({
  integrations: [preact({ include: ['**/islands/**'] })],
  vite: {
    plugins: [tailwindcss(), axobjectQueryEsmPlugin()],
  },
});
