# Changelog

## [3.0.0] - 2026-11-28

### ⚠️ Breaking: the model policy moved to settings.json

**`~/.pi/agent/pi-subagent/models-allowlist.json` is no longer read.** Without action, children run unrestricted on the child Pi's default model. Move the policy into a `subagent` key in Pi's `settings.json`:

```jsonc
"subagent": {
  "defaultModel": "provider/model",     // was "default"
  "defaultThinking": "high",            // unchanged
  "models": {                           // was the "allowed" array
    "provider/model": {
      "thinking": ["medium", "high"],   // was the keys of "levels"
      "description": "When to use it"
    }
  }
}
```

- `enabled` is gone: the policy applies whenever `models` is present.
- Benchmark scores moved out of the policy into the generated cache `~/.pi/agent/pi-subagent/benchmarks.json`, keyed by model and then thinking level.
- `refresh-aa-benchmarks.ts` became `refresh-benchmarks.ts`. It reads `settings.json` and never writes to it; `--config` is gone.
- DeepSWE is dropped: it stopped updating. `refresh-deepswe-benchmarks.ts` and the `deepSWE` scores are gone.
- Under a model list, an omitted `thinking` no longer falls through to the child Pi's default: it comes from `defaultThinking` when the model permits it, or from the model's only permitted level, and fails otherwise.
- `subagent_models` returns a readable text catalog for the model and a structured catalog for scripts, instead of compact JSON rows.
- `/subagents` lists children from `subagent-run` session entries, so children started by 2.x are no longer listed. Their sessions still resume.

### Added

- Codemode support. `subagent` and `subagent_models` declare output schemas, so `tools.subagent()` in a script resolves to `{ status, output, error?, label?, session?, contextTokens?, contextWindow? }` with the output untruncated. A failed child resolves with `status: "failed"` rather than rejecting, so `Promise.all` keeps its siblings.
- `/subagents` lists children started from codemode scripts, live and finished.
- Projects can withdraw a model the user settings permit with `"provider/id": null`.

### Changed

- A failed child is reported to the parent as an error result.
- `/subagents` key hints follow the user's keybindings.
- The extension is split into `child.ts`, `policy.ts`, and `index.ts`.

### Fixed

- A child killed by an outside signal was reported as `done`.
- Compiled Pi binaries on Windows (`B:/~BUN/root/...`) passed their virtual entry path to the child.
- Type errors against Pi 1.6: `StringEnum` from pi-ai no longer produces a TypeBox schema.
