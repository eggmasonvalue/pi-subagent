# Pi Subagent

A small, high-leverage subagent extension for [pi](https://pi.dev).

Each `subagent` call starts a focused child Pi process with its own context window. The parent waits for a final or partial result while the human sees live progress. Every child session is persisted, so the parent can inspect it, resume it with new direction, or recover useful work after an interrupt or timeout.

## Design principles

This package is not trying to be the most feature-rich subagent framework. It assumes modern models are capable supervisors and gives the parent agent a small set of powerful mechanisms instead of prescribing an orchestration system.

The design follows four priorities:

- keep both parent and child contexts as clean as possible, but no cleaner than the task permits;
- leave task framing, model choice, capability selection, and follow-up decisions to the parent model whenever it has enough information;
- preserve the essential observability and steerability needed by both the model and the human;
- prefer a few composable primitives over specialized workflows and lifecycle machinery.

The result is intentionally thin rather than universally comprehensive. It is designed for users who want the model to orchestrate, Pi to provide the underlying runtime capabilities, and the extension to stay out of the way.

The control model is deliberately simple:

```text
delegate → observe → return
                   ↘ timeout → request checkpoint → decide whether and how to resume
```

That small loop covers completion, clarification, supervision, recovery, and iterative work without a background-job system or a separate messaging protocol.

## Small surface, broad capability

Thin does not mean limited. Most useful subagent behavior falls out of a few composable mechanisms:

| Need | Mechanism |
|---|---|
| Focused work without consuming the parent's context | A fresh child Pi process |
| Independent investigations | Multiple sibling calls, executed concurrently by Pi |
| Clarification | The child returns its question; the parent resumes with an answer |
| Progress review | A task-specific timeout returns control to the parent |
| Correction or follow-up | Resume the same persisted child session |
| Interrupt recovery | Abort flushes partial output and preserves the session |
| Human observability | Live TUI updates plus a durable session receipt |
| Model and cost control | Per-run model, thinking, and tool configuration, with optional model/thinking policy and explicit tool inheritance or replacement |

Together these cover the common delegation lifecycle without requiring background jobs, polling, mailboxes, workflow graphs, or a custom scheduler. The extension stays small while the parent model composes the primitives according to the task.

### Clean context boundaries

The child receives a self-contained task in a fresh Pi context. Its intermediate tool traffic stays out of the parent model's context; only its concise result returns to the parent.

### Return is the event

A child does not need a mailbox or lifecycle protocol. It returns when it finishes or when it needs clarification, a decision, or missing information. The parent answers by resuming the same session.

### Timeout is a supervision point

`timeoutMs` is not merely a hang guard. It defines when the parent should regain control and review progress. If the child is still working, any assistant text it has already emitted and its session path are preserved. After a timeout, the parent resumes the same session only to request a concise progress report covering completed work, current step, blockers, and proposed next action. It does not ask the child to continue in that turn. Once the report returns, the parent decides whether to resume the child and steers any further work based on that report.

### Resume is steering

A resumed child keeps the context it accumulated previously. Corrections, answers, and follow-up work become the next user turn in that same session instead of forcing another child to rediscover the task.

### Pi provides parallelism

For independent work, the parent emits multiple sibling `subagent` tool calls in one turn. Pi executes sibling tool calls concurrently and waits for all of them before returning their results to the parent model.

The extension therefore does not need its own task-array syntax, scheduler, or parallel-result protocol.

### Receipts without context pollution

The human sees live child activity in Pi's TUI. The parent receives a compact result with a session path. The complete Pi session remains available for diagnosis or direct continuation without being copied into the parent's context by default.

## Deliberate boundaries

This extension provides one synchronous child run per tool call. It intentionally does not add:

- named-agent or persona files;
- a chain/workflow language;
- a custom parallel scheduler;
- asynchronous job handles;
- polling, heartbeats, or background result delivery;
- a separate child-to-parent messaging system.

Pi skills and prompt templates can provide reusable delegation patterns. Pi's native parallel tool execution handles fan-out. Return, timeout, persisted sessions, and resume provide the control loop.

## Install

```bash
# Git
pi install git:github.com/eggmasonvalue/pi-subagent

# npm
pi install npm:@eggmasonvalue/pi-subagent

# Try it for one run
pi -e git:github.com/eggmasonvalue/pi-subagent
```

Restart Pi or run `/reload` after installation or local edits.

> Pi packages execute with your system permissions. Review third-party extension code before installing it.

## Using it

Normally, you ask the main agent in natural language and let it construct the tool call.

```text
Delegate an isolated investigation of the authentication flow. Return the relevant files,
control flow, and unresolved questions.
```

```text
Use separate subagents in parallel to inspect the API layer, persistence layer, and test
coverage. Give each one only the tools it needs.
```

```text
Give a subagent two minutes to investigate this intermittent failure. If it times out,
resume it for a concise status report before deciding what to try next.
```

The parent can specify the expected output directly in `task`, including a role, constraints, definition of done, or a structured response format. There is no separate persona or system-prompt parameter.

## Tool interface

A fresh run uses:

```ts
subagent {
  task: string;
  label?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
  timeoutMs?: number;
}
```

A continuation uses:

```ts
subagent {
  task: string;
  resume: string;
  label?: string;
  timeoutMs?: number;
}
```

### Parameters

| Parameter | Meaning |
|---|---|
| `task` | Self-contained assignment. On resume, this is the answer, correction, or next direction appended to the existing child session. |
| `label` | Optional correlation label returned with the result. Useful when several sibling calls run concurrently. |
| `model` | Pi model pattern or `provider/id` for a fresh run. With an enabled allowlist, it must exactly match an allowed ID. Omit it to use the policy default, or the child Pi default when policy is disabled. |
| `thinking` | Reasoning level for a fresh run. It must be supported by the selected model and permitted by policy. When policy defines allowed levels, it is required and must match one of them; otherwise omission uses the child Pi default. |
| `tools` | Tools for a fresh child. Omit to inherit the parent's active tools except `subagent` and `subagent_models`; `[]` disables tools; a non-empty array is the child's exact tool set. Add `subagent` alongside any other required tools only when the child must delegate further. |
| `cwd` | Child working directory. Omit it to inherit the parent working directory. Setting it at startup controls path resolution and project-resource discovery. |
| `timeoutMs` | Review horizon in milliseconds. No timeout is imposed when omitted. |
| `resume` | Exact session JSONL path returned by an earlier call. Runtime configuration comes from the saved session. |

Fresh-run configuration such as `model`, `thinking`, `tools`, and `cwd` is not changed during resume. Start a new child when different runtime configuration is required.

## The supervision loop

### Normal completion

The child returns its final answer. The parent uses it directly or delegates follow-up work.

### Clarification or blocker

Every fresh child is told to return rather than guess when it cannot proceed reliably without clarification, a decision, or missing information.

The parent resumes it with the answer:

```ts
subagent {
  resume: "<session path from the prior result>",
  task: "Use the internal OAuth provider; backward compatibility with API keys is not required. Continue.",
  timeoutMs: 120000
}
```

### Timeout

When the review horizon expires, the child process tree is stopped and the parent receives one result with `status=timeout`. It includes any assistant text already streamed and the child session path when Pi has persisted a session. Reported usage remains available to Pi's accounting and human-facing tool row rather than being added to the parent model's result text. There is no background result.

After a timeout:

1. Resume the same session only to request a concise progress report covering completed work, current step, blockers, and proposed next action. Do not ask it to continue in that turn.
2. Once the report returns, decide whether to resume the child and steer any further work based on that report.

### Human intervention

Press Escape to interrupt a running delegation. Completed work and the child session are retained where possible. The human can then ask the parent to resume with new direction instead of waiting for the original timeout.

After the child is no longer running, its session can also be opened directly in a separate Pi process:

```bash
pi --session "/path/from/the-result.jsonl"
```

Use the exact returned path. Do not open the same session interactively while its worker process is still writing to it.

## Parallel work

Parallelism is expressed through ordinary Pi tool calls, not a special subagent mode. The parent should issue multiple sibling calls when tasks are independent.

Each call has its own:

- task and label;
- model and thinking level;
- tool allowlist;
- timeout;
- result and session receipt.

Pi runs the calls concurrently, streams each tool row independently, and sends all finalized results to the parent model before its next turn.

Avoid assigning overlapping file edits to concurrent children unless the work has been explicitly partitioned.

## Models and benchmark-informed selection

Model policy is optional. When enabled, it constrains which child models and thinking levels may be selected. The parent remains free to choose the best permitted configuration for each task.

The zero-argument `subagent_models` tool returns the curated catalog on demand. Its compact response includes:

- exact model IDs;
- permitted thinking levels;
- optional benchmark data for each level;
- optional user-written descriptions;
- the configured model and thinking defaults.

The parent should normally call it once when model choice matters and reuse that result for later delegations. The catalog is not injected into every system prompt.

### Configure the allowlist

Create the active policy from `extensions/subagent/models-allowlist.example.json`. From a package checkout, you can copy it with:

From Bash:

```bash
mkdir -p ~/.pi/agent/pi-subagent
cp extensions/subagent/models-allowlist.example.json ~/.pi/agent/pi-subagent/models-allowlist.json
```

From PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME/.pi/agent/pi-subagent" | Out-Null
Copy-Item extensions/subagent/models-allowlist.example.json "$HOME/.pi/agent/pi-subagent/models-allowlist.json"
```

The active policy is read from `~/.pi/agent/pi-subagent/models-allowlist.json` (`%USERPROFILE%\\.pi\\agent\\pi-subagent\\models-allowlist.json` on Windows), independently of whether the package was installed from npm or Git. `PI_CODING_AGENT_DIR` replaces the `~/.pi/agent` base when set.

A model entry may be a plain ID or an object with per-level metadata:

```json
{
  "enabled": true,
  "default": "github-copilot/gpt-5.3-codex",
  "defaultThinking": "high",
  "allowed": [
    {
      "id": "github-copilot/gpt-5.3-codex",
      "description": "Strong default for coding tasks",
      "levels": {
        "low": {},
        "high": {
          "artificialAnalysis": {
            "intelligence": 55.1,
            "coding": 70.8,
            "cost": 4.63
          },
          "deepSWE": {
            "pass": 0.619,
            "cost": 4.47
          }
        }
      }
    }
  ]
}
```

When a non-empty `levels` object is present, `thinking` must match one of the keys. Pi's model metadata narrows those configured keys to levels the model actually supports. Omitting `levels` permits the model's full Pi-supported set. `defaultThinking` supplies the thinking level for fresh children when `subagent.thinking` is omitted; an explicit tool argument takes precedence. If neither is set, the child Pi default is used when the selected model has no configured levels.

If the allowlist file is absent, model policy is disabled and the child may use Pi's normal model configuration.

### Refresh optional benchmark data

The refresh scripts always update the active policy at
`~/.pi/agent/pi-subagent/models-allowlist.json`, regardless of whether this package was
installed from npm or Git. From a package checkout, run:

```bash
bun extensions/subagent/refresh-aa-benchmarks.ts
bun extensions/subagent/refresh-deepswe-benchmarks.ts
```

For tests or another policy file, pass an explicit path with `--config`:

```bash
bun extensions/subagent/refresh-aa-benchmarks.ts --config /tmp/models-allowlist.json
bun extensions/subagent/refresh-deepswe-benchmarks.ts --config /tmp/models-allowlist.json
```

Benchmark values inform model choice; Pi's model metadata remains authoritative for capability validation. Users may omit benchmark fields and rely entirely on their own descriptions.

`extensions/subagent/benchmark-config.ts` is the shared implementation used by the refresh scripts; it is not a user configuration file. The active user configuration is `~/.pi/agent/pi-subagent/models-allowlist.json`, and `--config` selects a different allowlist file for a refresh.

## Context and capabilities

A child is a normal Pi process. It starts in the selected working directory and receives Pi's applicable project context and resources.

Use `tools` to remove capabilities that are unnecessary for the delegated task. Omission inherits the parent's currently active tools except `subagent` and `subagent_models`; an empty array starts the child without tools; a non-empty array replaces inheritance and becomes the exact child tool set. The names must be tools available to the child Pi process.

Recursive delegation is not enabled for children by default. Add `subagent` alongside any other required tools only when the child genuinely needs to orchestrate further isolated work. A list containing only `subagent` grants delegation but no file, shell, or editing tools.

The goal is not to disable resources indiscriminately. Resources that do not affect the model's context or capabilities need no special treatment; relevant project instructions and skills should remain available.

## Results and sessions

A result begins with a compact envelope followed by the child's final or partial text:

```text
[label=auth-audit status=done session=/.../child.jsonl]
<child output>
```

Possible statuses include:

- `done`
- `failed`
- `timeout`
- `aborted`

The model-facing envelope contains only the correlation label when supplied, status, and resumable session path when available. Model, thinking, activity, and usage details remain available to Pi's accounting and human-facing tool row without being copied into the parent model's result text. The child's payload is otherwise returned without imposing a universal report format.

Child sessions are stored beneath Pi's session directory in a `subagent` run directory. The returned `session` path is both the resume handle and the diagnostic receipt.

Session JSONL is intended primarily for debugging and verification. It contains structured conversation entries and may contain opaque provider reasoning data. When inspecting it programmatically, focus on user, assistant, and tool-result messages rather than attempting to interpret encrypted reasoning fields.

## Human-visible output

During a run, Pi's tool row shows useful child activity without adding that stream to the parent model's context:

- assistant progress;
- tool calls;
- completion or failure state;
- model and usage information;
- session path.

Expand the tool row with Pi's normal tool-output control for more detail. The persisted session is the authoritative complete record.

## Output limits

The extension caps the result text sent to the parent at Pi's standard 50 KB or 2000-line limit, keeping the beginning. If the cap is reached, the result points the main agent to the last assistant message in the child session JSONL; it does not create a separate full-output log. Child built-in tools retain Pi's own output-truncation behavior.

## Implementation overview

```text
parent Pi session
  └─ subagent tool call
       └─ child Pi process in JSON mode
            ├─ isolated model context
            ├─ normal Pi tools and project resources
            ├─ live events rendered in the parent TUI
            ├─ persisted child session
            └─ concise final or partial result returned to the parent
```

The extension relies on Pi rather than recreating it:

- Pi processes provide isolation;
- Pi JSON events provide live observation;
- Pi sessions provide persistence and resume;
- Pi tool execution provides sibling-call parallelism;
- Pi model and tool flags configure each child;
- Pi's TUI supports compact and expanded rendering.

The extension supplies the thin control layer connecting those capabilities.

## Files

```text
pi-subagent/
├── package.json
├── README.md
└── extensions/
    └── subagent/
        ├── index.ts
        ├── benchmark-config.ts
        ├── models-allowlist.example.json
        ├── refresh-aa-benchmarks.ts
        └── refresh-deepswe-benchmarks.ts
```

## License

MIT
