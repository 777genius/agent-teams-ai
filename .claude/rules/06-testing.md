# Testing

Assume nothing about correctness — prove it with tests.

## Unit Tests

- Write the test first for non-trivial logic (TDD). Implement until it passes.
- Every new function/method/module with logic gets unit tests.
- Run existing tests after every change. Fix breaks before moving on.

## Integration Tests

- Test module boundaries: DB queries, external APIs, filesystem, message queues.
- Use real dependencies (or containers) — not mocks. Mocks belong in unit tests.
- Target 70/20/10 ratio: unit/integration/E2E.

## End-to-End Tests

- Critical user journeys only (~10% of suite). Test API endpoints with integration tests, not E2E.

## After Every Change

- Run the test suite, report results, fix failures before continuing.
- If no test framework exists, flag it and propose a testing strategy.
