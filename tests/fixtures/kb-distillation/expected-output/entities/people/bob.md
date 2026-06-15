# Bob

## Expertise
- Integration testing, testcontainers
- CI/CD optimization
- Database testing patterns

## Positions
- Integration tests for internal APIs, contract tests for external APIs
- Schema-per-file approach for parallel test execution (prefer over database-per-file at scale)
- Layered testing strategy: unit (no I/O) → integration (testcontainers) → minimal end-to-end (~12 tests)
- Cut E2E suite from 60 to 12, CI from 50 minutes to 8
- Pact is solid but broker maintenance is annoying

## Resources Shared
- [[parallel-testing-blog]] - blog post on parallel integration testing with schema isolation
- [[testcontainers-patterns]] - GitHub repo with testing patterns
