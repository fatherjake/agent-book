import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // results/ holds run artifacts and the lab's repo clones (with their own test files).
    exclude: [...configDefaults.exclude, 'results/**', 'web/**', 'dashboard/**'],
  },
});
