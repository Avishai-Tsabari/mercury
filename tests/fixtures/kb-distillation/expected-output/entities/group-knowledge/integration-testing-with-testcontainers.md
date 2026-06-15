# Integration Testing with Testcontainers

## Key Points
- Testcontainers spins up real database containers per test suite — eliminates mock drift
- Startup cost: ~10-15 seconds per container
- Shared container across test run with table truncation between tests is faster but prevents parallel execution

## Schema-per-file Pattern
- Each test file gets its own database schema within a shared container
- Tables are identical across schemas
- Enables parallel test execution with clean isolation
- Better than database-per-file at scale (~200+ test files) — avoids connection pool exhaustion

## Tradeoffs
| Approach | Isolation | Speed | Parallelism |
|----------|-----------|-------|-------------|
| Container per suite | High | Slow (10-15s startup) | Yes |
| Shared container + truncate | Medium | Fast | No |
| Schema per file | High | Fast | Yes |
| Database per file | Highest | Slow | Yes (but pool issues) |
