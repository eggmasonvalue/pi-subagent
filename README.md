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
delegate → observe → return or timeout → resume with direction
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
| Model and cost control | Per-task model, thinking, and tool selection within user policy |

Together these cover the common delegation lifecycle without requiring background jobs, polling, mailboxes, workflow graphs, or a custom scheduler. The extension stays small while the parent model composes the primitives according to the task.

### Clean context boundaries

The child receives a self-contained task in a fresh Pi context. Its intermediate tool traffic stays out of the parent model's context; only its concise result returns to the parent.

### Return is the event

A child does not need a mailbox or lifecycle protocol. It returns when it finishes or when it needs clarification, a decision, or missing information. The parent answers by resuming the same session.

### Timeout is a supervision point

`timeoutMs` is not merely a hang guard. It defines when the parent should regain control and review progress. If the child is still working, its partial result and session path are preserved. The parent can then resume it for a status summary or with revised direction.

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
| `model` | Pi model pattern or `provider/id` for a fresh run. With an enabled allowlist, it must exactly match an allowed ID. Omit it to use the configured default. |
| `thinking` | Reasoning level for a fresh run. When model policy defines allowed levels, this is required and must match one of them. |
| `tools` | Child tool allowlist. Choose the narrowest set that can complete the task. |
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

When the review horizon expires, the extension stops the child process tree and returns a normal tool result to the parent. The result contains:

- an envelope with `status=timeout` and `session=<absolute JSONL path>`;
- the text currently being streamed for the in-progress assistant turn, if any;
- otherwise the most recent completed assistant response, or an error/stderr message when there is no assistant text;
- usage accumulated from completed turns plus the latest usage checkpoint reported by the child.

It does not return a second hidden result or a promise for background work. The child is stopped; resume is a new synchronous call that appends the next user turn to the saved session. The usual next step is to resume the child and ask it to summarize its current state, then resume again with direction if necessary. This is preferable to loading a large raw transcript into the parent context.

### Human intervention

Press Escape to interrupt a running delegation. Completed work and the child session are retained where possible. The human can then ask the parent to resume with new direction instead of waiting for the original timeout.

The returned path is the exact child session file. For a human-readable view, start a separate Pi process after the child is no longer running and open that session:

```bash
pi --session "/path/from-the-result.jsonl"
```

You can also start a separate Pi process, type `/resume`, switch the selector to all sessions if necessary, and select the child from the `sessions/subagent/` directory. The direct command is still useful when you want to open the exact returned path without searching. Do not open the same session interactively while its worker process is still writing to it.

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
- the configured default.

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

A model entry may be a plain ID or an object with per-level metadata. Use `description` to record the differentiating information that the compact `subagent_models` catalog cannot infer reliably: coding or reasoning strengths, speed/quality trade-offs, context-window considerations, cost expectations, and the task types for which this model is preferred. The allowlist itself is the policy boundary: when enabled, a child may use only an exact listed ID, and an entry with `levels` permits only the listed thinking levels.

```json
{
  "enabled": true,
  "default": "github-copilot/gpt-5.3-codex",
  "allowed": [
    {
      "id": "github-copilot/gpt-5.3-codex",
      "description": "Strong repository-wide coding and debugging; prefer for complex implementation, not latency-sensitive lookups",
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

When a non-empty `levels` object is present, `thinking` is required and its value must match one of the keys. Omitting `levels` leaves thinking unrestricted for that entry.

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

### What the benchmark config file is

`extensions/subagent/benchmark-config.ts` is not a user configuration file. It is a small shared implementation module used by the two refresh scripts for path resolution, JSON validation, and preservation of unknown fields.

The user-controlled configuration is the active model allowlist:

```text
~/.pi/agent/pi-subagent/models-allowlist.json
```

(`%USERPROFILE%\\.pi\\agent\\pi-subagent\\models-allowlist.json` on Windows.) It contains the allowed exact model IDs, the optional default, optional per-model descriptions, allowed thinking levels, and optional benchmark metadata. The Artificial Analysis and DeepSWE scripts read that file and merge fresh values into the matching model/level entries; they do not define a separate benchmark database. `--config PATH` only selects another allowlist file for a refresh.

## Context and capabilities

A child is a normal Pi process. It starts in the selected working directory and receives Pi's applicable project context and resources.

Use `tools` to remove capabilities that are unnecessary for the delegated task. The value is an allowlist of the tool names actually registered by the current Pi installation; available names vary with Pi configuration and installed extensions. The extension intentionally does not prescribe a list of names here—copying an example from a README can silently grant the wrong capabilities or fail to run. Pass only names you have verified in the target Pi session, or pass an empty array to disable child tools.

Recursive delegation is not enabled for children by default. Include `subagent` explicitly in the child's tools only when that child genuinely needs to orchestrate further isolated work.

The goal is not to disable resources indiscriminately. Resources that do not affect the model's context or capabilities need no special treatment; relevant project instructions and skills should remain available.

## Results and sessions

A result begins with a compact envelope followed by the child's final or partial text:

```text
[label=auth-audit status=done model=provider/model thinking=high turns=6 cost=0.0413 exit=stop session=/.../child.jsonl]
<child output>
```

Possible statuses include:

- `done`
- `failed`
- `timeout`
- `aborted`

The envelope contains orchestration facts known by the extension. The child's payload is otherwise returned without imposing a universal report format.

Child sessions are stored beneath Pi's session directory as uniquely named files in `subagent/` (`subagent/<run-id>.jsonl`). The returned `session` path is both the resume handle and the diagnostic receipt; because the files are in a normal session subdirectory, Pi's `/resume` selector can discover them.

Session JSONL is the authoritative persisted child conversation record. It contains structured session, user, assistant, and tool-result entries and may contain opaque provider reasoning data. A streamed assistant turn is normally persisted when it completes; if a timeout/abort interrupts that first turn, the current partial text is returned to the parent but may not yet be present in the JSONL. It is not a plain-text dump of every byte ever printed by a tool: a built-in tool may have already applied its own truncation or saved an auxiliary log. When inspecting it programmatically, focus on user, assistant, and tool-result messages rather than attempting to interpret encrypted reasoning fields.

## Human-visible output

During a run, the parent TUI receives updates from the child's JSON event stream. The collapsed `subagent` tool row shows:

- the label (or `child`/`resume`) and current status;
- recent completed assistant text, tool calls, and tool-result summaries;
- currently running tool calls;
- turns, token/cost usage, selected model/thinking level, and the session path when known.

Partial assistant text is updated while the child is generating. The collapsed view keeps the last ten activity items and reports how many earlier items were omitted. Expand the row with Pi's normal tool-output control to see the task, all activity summaries collected by the extension, and the final or partial result. It does not mirror raw JSON events or provider reasoning into the parent conversation. The persisted session is the authoritative complete child record.

## Output limits

There are two different limits:

1. **The extension's result envelope.** The text returned to the parent is passed through Pi's `50 * 1024` byte and 2000-line limits, keeping the beginning and adding an `Output truncated` notice when either limit is exceeded. This is a context-protection step performed by the extension. It does not create Pi's native temporary full-output log. The untruncated assistant message remains in the child session JSONL when that message was persisted (an interrupted in-progress turn may exist only as the returned partial text), and the full structured result is also retained in the tool details for the current TUI run.
2. **Child tool output.** Built-in child tools retain their own Pi behavior. For example, `read` reports a continuation offset instead of pretending the file is complete, while `bash` keeps the bounded display and, when its output is truncated, may save the full shell output to a separate temporary log. These tool-specific details are recorded in the child session as the tool result, not replaced by the extension's final-response limit.

Therefore, the child JSONL's final assistant message is the untruncated child response—not a native truncation log. It is the best durable record of that response, while a native tool-specific log path (when one exists) is the record for that tool's raw output.

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
