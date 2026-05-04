# Flow Script Specification

Declarative description of "how to complete an order on a site". YAML format.

## Top-Level Schema

```yaml
flow_id: <site>.<purpose>           # required, snake_case
version: <integer>                   # required, increment on schema changes
target: <siteId>                     # required, must match adapter siteId
platform: web | mobile-android       # required (no mobile-ios)

variables:                           # optional
  - name: <var_name>
    type: number | string | boolean
    required: <bool>
    default: <value>

phases:
  acquire:
    - <step>
    - <step>
  settle:
    - <step>
    - <step>

metadata:
  recorded_at: <ISO8601>
  recorded_by: <recorder_id>
  recorder_version: <semver>
```

## Step Schema

```yaml
- id: <step_id>                      # required, unique within flow
  action: <action_type>              # required
  description: <text>                # optional, for debugging
  
  # action-specific fields below
  selector: <selector>
  value: <text>
  wait_for: { selector, timeout_ms }
  capture_as: <var_name>
  capture_field: <capture_spec>
  
  # universal fields
  retry: { max: <int>, backoff_ms: <int> }
  timeout_ms: <int>                  # default 10000
  humanize: <bool>                   # default true for browser/mobile
  checkpoint: <bool>                 # mark resumable point
  
  # control flow
  on_fail: abort | continue | <step_id>
  when: <expression>                 # conditional execution
```

## Action Types

| Action | Required fields |
|---|---|
| `tap` | `selector` |
| `input` | `selector`, `value` |
| `select` | `selector`, `value` |
| `assert` | `selector` (and one of: `text_match`, `attribute_match`, `exists`) |
| `wait` | one of: `duration_ms`, `wait_for` |
| `navigate` | `url` |
| `navigate_with_state` | `use: <var_name>` |
| `capture` | `selector`, `capture_as`, `capture_field` |
| `condition` | `when`, `then`, optional `else` |
| `abort` | `reason` |
| `humanize` | (no required, modifies preceding step's behavior) |
| `checkpoint` | (id only, marks resume point) |

## Selector Syntax

```
css=<css>                            # CSS selector (default if no prefix)
xpath=<xpath>                        # XPath
text=<text>                          # exact text match
text~=<regex>                        # regex text match
id=<accessibility_id>                # mobile accessibility id
role=<aria_role>[name=<name>]        # ARIA role
nth=<n>(<selector>)                  # nth element matching
```

## Capture Spec

```yaml
capture_field:
  type: url_param | cookie | dom_attribute | dom_text | response_header
  name: <field_name>                 # for url_param / cookie / header
  selector: <selector>               # for dom_*
  attribute: <attr>                  # for dom_attribute
  regex: <pattern>                   # optional extract
```

## Variable Interpolation

```
${input.<var>}                       # from intent input
${captured.<var>}                    # captured by previous step
${env.<var>}                         # config / env (limited)
```

Allowed in: `value`, `selector`, `url`, `text_match`, `when`.

## Phase Constraints

```
phases.acquire:
  - last step MUST have capture_as: 'reservation_token'

phases.settle:
  - first step MUST satisfy ALL:
      id: 'validate_reservation'           # required step id by convention
      action: 'navigate_with_state'
      use: 'reservation_token'
```

Both the `id` and the `action`+`use` are required. Validator rejects flows violating either.

## Version Compatibility

Adapter declares supported versions:
```ts
adapter.capabilities = {
  supportedFlowVersions: [1, 2]
}
```

Flow with `version: 3` against adapter supporting `[1, 2]` → fail with `flow_version_unsupported`.

## Recorder Output

Recorder generates flows interactively:
- Web: Playwright Codegen-based, outputs YAML
- Mobile-android: Appium Inspector + custom hooks, outputs YAML
- User must mark phase boundary (acquire/settle) before saving

## DryRun

```
dryrun(flowRef, intent): DryRunReport
  - executes all steps in `phases.acquire`
  - stops before reservation
  - emits report: which step failed, screenshots, DOM dumps
```

UI requirement: scheduled tasks must have a successful dryrun within last 24h before allowed to run live.

## Validation Rules

| Rule | Failure mode |
|---|---|
| `version` missing or non-integer | reject |
| `phases.acquire` or `phases.settle` missing | reject |
| Acquire phase no `capture_as: reservation_token` | reject |
| Settle phase first step does not satisfy `id=validate_reservation, action=navigate_with_state, use=reservation_token` | reject |
| Step `id` duplicate | reject |
| Variable referenced but not declared | reject |
| Selector with unknown prefix | reject |

## Implementation Files

```
packages/server/order-shared/flow-orchestration/
├── parser.ts                       # YAML → AST
├── validator.ts                    # phase / step rules
├── interpreter.ts                  # execute AST against engine
├── interpolator.ts                 # ${...} resolution
├── capture-handler.ts              # store captured values
└── __tests__/

tools/flow-recorder-ui/
├── web-recorder/
└── mobile-recorder/
```
