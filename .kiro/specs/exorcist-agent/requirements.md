# Requirements Document

## Introduction

The Exorcist is a Kiro agent that investigates an incident through MCP tools and submits a diagnosis. This document currently holds only the requirement for the G0 feasibility spike. The remaining requirements are written after G0.

## Glossary

- **Exorcist**: the Kiro agent that investigates a haunted service and submits a diagnosis.
- **Hunt**: one headless Exorcist run, from the prompt to `submit_diagnosis`.
- **MCP server**: the stdio Model Context Protocol server that exposes the Exorcist's tools.
- **Allow-list**: the set of tools the Exorcist may call (`query_metrics`, `diff_commit`, `submit_diagnosis`), enforced by the agent config and `--trust-tools`.
- **Diagnosis**: the `{summary, evidence[{kind,ref,detail}], culprit_commit, confidence}` payload passed to `submit_diagnosis`.
- **Credits**: the Kiro usage unit reported per turn by `kiro-cli`.
- **G0**: the feasibility gate that decides between headless `kiro-cli` and the ACP fallback.

## Requirements

### Requirement 1: G0 feasibility spike

**User Story:** As the Haunted Ops team, I want to prove that one headless Exorcist hunt works end to end and know its cost, so that I can decide between headless `kiro-cli` and the ACP fallback before writing the rest of the spec.

#### Acceptance Criteria

1.1 WHEN the headless command `kiro-cli chat --no-interactive` is run with the Exorcist agent, THE Exorcist SHALL investigate using only the MCP tools `query_metrics`, `diff_commit` and `submit_diagnosis`.

1.2 WHEN the Exorcist is asked to use a tool outside the allow-list (for example a shell command), THE system SHALL refuse the call.

1.3 WHEN the hunt finishes, THE Exorcist SHALL have called `submit_diagnosis` once with a valid `{summary, evidence[{kind,ref,detail}], culprit_commit, confidence}` payload, and THE MCP server SHALL write it to `spikes/g0/out/diagnosis.json`.

1.4 WHEN the hunt finishes, THE spike SHALL record the exit code, wall time and credits used.

1.5 WHEN the spike is complete, THE spike SHALL record a verdict line `G0: PASS` or `G0: FAIL — <reason>` and a "Decisions for the spec" section in `spikes/g0/G0.md`.
