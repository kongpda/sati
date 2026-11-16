# 0010. Work in review unblocks its dependents

- Status: accepted
- Date: 2026-11-16

## Context

Sati is a brain for AI agents: it exists so agents can keep working. The default review mode, `agents`, sends every task an agent completes to `review`, and only a person can move it to `done`. Until now a dependency counted as out of the way only once it was `done` or `cancelled`. So every task that depended on an agent's finished work stayed off the ready list and refused a claim until a person approved. On the owner's machine that meant 498 tasks waiting in review across three projects, with the work after them stalled.

## Decision

A dependency in `review`, `done` or `cancelled` (or deleted) no longer holds its dependents back. The list is `CLEARS_DEPENDENTS` in `packages/core/src/domain/status.ts`, and every place that applies the rule uses it: the ready list in both stores, the claim check, the doctor's cycle check and the board's "waits for" badge.

Approval does not change. Only a person moves a task from `review` to `done`, and the review mode is unchanged.

## Consequences

- Agents build on finished work right away. People review when they can, not before agents may continue.
- A person who sends a task back from `review` to `todo` may find work already built on top of it. The dependent tasks keep their own history, so the reviewer can see what was built and reopen it too.
- `doctor` no longer reports a dependency cycle that runs only through tasks in review.

## Alternatives considered

- Default the review mode to `none`. Simple, but it drops the human record of what was checked, which is the reason the gate exists.
- Let a second agent approve. It keeps a check but changes the rule that a person approves, and it doubles agent work for every task.
- Leave it to each owner to turn review off. Owners hit the stall before they learn the setting exists.
