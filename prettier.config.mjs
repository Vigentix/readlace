/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config & import("prettier-plugin-tailwindcss").PluginOptions}
 */
const config = {
  singleQuote: false,
  trailingComma: "all",
  semi: true,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "./assets/tailwind.css",
  overrides: [
    {
      // The popup's paper/ink tokens live in its own stylesheet.
      files: ["entrypoints/popup/**", "components/Select.tsx"],
      options: { tailwindStylesheet: "./entrypoints/popup/popup.css" },
    },
  ],
};

export default config;
