# Contract Testing with Pact

## Key Points
- Consumer-driven contract testing: frontend writes the contract, backend verifies against it
- PactFlow (hosted) eliminates the self-hosted broker maintenance burden
- `can-i-deploy` CI check blocks deploys that would break a consumer
- Cultural adoption is harder than tooling — teams override checks when rushed

## When to Use
- External API boundaries between teams
- Frontend ↔ Backend contracts
- Less useful for internal APIs where integration tests are practical
