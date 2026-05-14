# Development Workflow with Test Harness

This project follows a Test-Driven Development (TDD) approach using Jest and TypeScript.

## Prerequisites

- Node.js >= 18
- npm

## Setup

```bash
npm install
```

## Running the Server

### Development Mode

Starts the server with `tsx` (TypeScript Execute) for rapid development:

```bash
npm run dev
```

### Build and Run

Compiles TypeScript to JavaScript (ESM) and runs the build:

```bash
npm run build
node dist/index.js
```

## Testing

The test suite is split into two scripts so the fast unit + non-network integration tests can run cheaply on every change without the overhead of spawning a real server:

```bash
npm test                # fast suite (excludes tests/network.test.ts)
npm run test:integration  # network end-to-end suite only
npm run test:all          # both
```

### Running Specific Tests

Use `--` to forward arguments to Jest:

- **Database schema**: `npm test -- tests/db.test.ts`
- **Synchronization logic**: `npm test -- tests/sync.test.ts`
- **Search logic**: `npm test -- tests/logic.test.ts`
- **Network integration**: `npm run test:integration`

### Testing Network Mode

`tests/network.test.ts` spawns a server instance on port `3001` and uses `StreamableHTTPClientTransport` from the MCP SDK to verify end-to-end connectivity, tool dispatch, and `_hints` payloads.

## Test Infrastructure

- **Jest**: Configured for ESM and TypeScript via `ts-jest`.
- **Scratch Directories**: Tests use `scratch_test` directories to avoid polluting production data.
- **Test Seeding**: Logic tests seed a temporary SQLite database with known data points to verify query accuracy.

## Adding New Tools

1.  **Logic**: Implement the database query logic in `src/logic.ts`.
2.  **Test**: Add test cases in `tests/logic.test.ts` to verify the new logic.
3.  **MCP Handler**: Register the tool and its input schema in `src/index.ts`.
4.  **Verification**: Run `npm test` to ensure everything is integrated correctly.
