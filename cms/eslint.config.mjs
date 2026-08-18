import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// P3-4: next lint stand als Script schon in package.json, ohne Config lief es
// aber nie (interaktiver Erst-Setup-Wizard, in CI ohne TTY ein Hang/Fehlschlag).
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
