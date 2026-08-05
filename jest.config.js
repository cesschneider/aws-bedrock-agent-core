/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test", "<rootDir>/lambda"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }],
  },
  collectCoverageFrom: ["lib/**/*.ts", "lambda/**/*.ts", "bin/**/*.ts"],
};

