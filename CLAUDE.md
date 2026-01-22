---
description: Use Node.js 24 for this project.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Node.js 24.

- Use `node --import tsx <file>` to run TypeScript files
- Use `npm test` or `vitest` for testing
- Use `vite build` for bundling frontend
- Use `npm install` for installing dependencies
- Use `npm run <script>` to run package scripts
- Use `npx <package> <command>` to run package binaries
- Use `node --env-file=.env` to load environment variables (built-in since Node.js 20.6)

## APIs

- Use `express` for HTTP server
- Use `better-sqlite3` for SQLite
- Use `@aws-sdk/client-s3` for S3

## Testing

Use `vitest` for testing:

```ts#index.test.ts
import { test, expect } from "vitest";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use Vite for frontend development with React and Tailwind.

Run development server:

```sh
npm run dev
```

Build for production:

```sh
npm run build
```

## Running the Server

Development (with hot reload):

```sh
npm run dev:server
```

Production:

```sh
npm run start
```
