/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test", "<rootDir>/lambda"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
  },
  collectCoverageFrom: ["lib/**/*.ts", "lambda/**/*.ts", "bin/**/*.ts"],
};
