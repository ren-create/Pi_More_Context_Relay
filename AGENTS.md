# Project instructions

## Scope

- This repository is a Pi-only portfolio project. Do not import code, history, configuration, or naming contracts from MrR.
- Prefer Pi's public SDK and extension APIs. Fork or patch Pi core only after a small executable spike proves that a required hook is unavailable.
- Keep the first demo sequential and local: supervisor plans, worker implements, tester verifies, supervisor reviews.

## Architectural invariants

- A Pi session owns its raw message history. This project owns group topology, shareable development records, policy decisions, context projections, relay events, and audit manifests.
- Authorization must run before retrieval or ranking. Forbidden records must never enter a model-facing candidate set.
- Keep authorization, relevance selection, projection, and token-budget packing as separate, testable stages.
- Derived summaries and handoffs inherit the strictest visibility of their sources unless an explicit, audited declassification rule is added later.
- Do not store, request, or relay hidden chain-of-thought. Persist only explicit conversation events, tool results, decisions, patches, test evidence, artifacts, summaries, and handoffs.
- Application-level context visibility is not an operating-system security boundary. Document that distinction in demos and public claims.

## MVP boundaries

- No vector database, general RAG, long-term persona memory, arbitrary workflow DAG, distributed execution, parallel repository writes, or full graphical interface.
- Use deterministic fixtures and fake canary secrets for leakage tests. Never use real credentials in tests or examples.
- Keep external dependencies minimal and pin versions deliberately.
- Do not commit generated runtime artifacts, credentials, raw private sessions, or benchmark outputs containing secrets.

## Working style

- Implement one vertical slice at a time and attach observable acceptance evidence.
- Treat `docs/DEVELOPMENT_REQUIREMENTS.md` as the initial product contract and `docs/ARCHITECTURE.md` as the initial technical boundary.
- Update documentation when a verified Pi API constraint changes an architectural assumption.
- Do not claim installation, build, test, model execution, token savings, or leakage prevention without actual evidence.

