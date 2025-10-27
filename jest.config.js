import { createRequire } from "module";

const require = createRequire(import.meta.url);
const tsJestPreset = require("ts-jest/presets/default-esm/jest-preset");

const transformKey = Object.keys(tsJestPreset.transform)[0];
const [transformer, transformerOptions] = tsJestPreset.transform[transformKey];

/** @type {import("jest").Config} **/
const config = {
  ...tsJestPreset,
  testEnvironment: "node",
  transform: {
    [transformKey]: [
      transformer,
      {
        ...transformerOptions,
        tsconfig: "./tsconfig.json",
      },
    ],
  },
};

export default config;
