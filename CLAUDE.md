no backwards compatibility needed

Default to using Node.js 24.

run npm run lint and then npx tsc -b to check and fix any issues 

## APIs

- Use `express` for HTTP server
- Use `better-sqlite3` for SQLite
- Use `@aws-sdk/client-s3` for S3

## Frontend

Use Vite for frontend development with React and Tailwind.

## Running the Server

Development (with hot reload):

```sh
npm run dev:server
```

Production:

```sh
npm run start
```
