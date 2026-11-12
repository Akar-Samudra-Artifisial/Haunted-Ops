---
inclusion: fileMatch
fileMatchPattern: "apps/lab/**"
---

# Lab and chaos

The lab is a small system we break on purpose. It lives in the separate repo `haunted-lab` (this guidance also applies if a lab folder appears under `apps/lab`).

- 4 services: `gate`, `orders`, `payments`, `ledger`. Plus Prometheus and a chaos controller.
- 3 fault scenarios, each reproducible on demand:
  1. error spike after a bad deploy (null check removed)
  2. latency / fog (slow dependency)
  3. service down (dark room)
- Planted culprit commits: each scenario has a known commit the Exorcist should find. Keep commit ids and diffs stable so tests and replays can check the diagnosis.
- The chaos controller is the only way to inject faults. It must be able to reset to a healthy state.
- Lab data is synthetic. No production data.
