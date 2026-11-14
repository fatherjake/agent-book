Autonomous Token Efficiency Benchmark

## 1. Project Overview

Build an autonomous research system that discovers the most token-efficient configuration for an AI coding agent to build a fully functional, visually consistent, full-stack todo application.

The system must repeatedly:

1. Generate or select an agent configuration.
2. Launch a fresh isolated Docker environment.
3. Have a coding agent build the todo application.
4. Evaluate the application using automated tests and an independent browser agent.
5. Record all tokens consumed by the coding agent.
6. Compare the result against previous experiments.
7. Use a research agent to propose improvements.
8. Repeat automatically within configurable resource budgets.

**Primary objective:** Minimize coding-agent token consumption while maintaining 100% completion of mandatory functional and browser tests and meeting the visual quality threshold.

The benchmark must be reproducible, measurable, and capable of running unattended.

---

## 2. Technology Stack

Use TypeScript for the main project.

Recommended technologies:

- **Runtime:** Node.js
- **Agent integration:** Provider adapters, initially supporting one configurable model provider
- **Container orchestration:** Docker Engine
- **Browser automation:** Playwright
- **Browser evaluator:** An independent LLM using Playwright browser tools
- **Result storage:** SQLite
- **Dashboard:** React + Vite
- **Application benchmark:** React frontend, Express backend, SQLite database
- **Configuration:** JSON or YAML
- **Logging:** Structured JSONL

Keep dependencies minimal. Prefer simple, understandable implementations over unnecessary frameworks.

---

## 3. Project Structure

```text
token-benchmark/
├── TASK.md
├── README.md
├── package.json
├── docker-compose.yml
├── .env.example
├── tsconfig.json
│
├── benchmark/
│   ├── spec/
│   │   ├── requirements.md
│   │   ├── api-contract.yaml
│   │   ├── design.png
│   │   └── fixtures.json
│   │
│   ├── starter/
│   │   ├── package.json
│   │   ├── frontend/
│   │   └── backend/
│   │
│   └── docker/
│       └── Dockerfile
│
├── runner/
│   ├── agent.ts
│   ├── providers/
│   ├── sandbox.ts
│   ├── tools.ts
│   ├── token-tracker.ts
│   ├── run.ts
│   └── types.ts
│
├── evaluator/
│   ├── browser-agent.ts
│   ├── scenarios/
│   ├── backend-tests.ts
│   ├── visual-tests.ts
│   ├── score.ts
│   └── fixtures.ts
│
├── researcher/
│   ├── research-agent.ts
│   ├── experiment.ts
│   ├── optimizer.ts
│   ├── history.ts
│   └── loop.ts
│
├── configs/
│   ├── baseline/
│   │   ├── system-prompt.md
│   │   ├── tools.json
│   │   └── skills/
│   │
│   └── experiments/
│
├── dashboard/
│   ├── src/
│   └── package.json
│
├── results/
│   ├── experiments.jsonl
│   ├── traces/
│   ├── screenshots/
│   └── best-config/
│
└── scripts/
    ├── run-benchmark.ts
    ├── start-research.ts
    └── generate-report.ts
```

This is a suggested structure. Adjust where necessary, but maintain separation between benchmark, runner, evaluator, and researcher.

---

## 4. Todo Application Benchmark

The coding agent must build a full-stack todo application from the provided starter repository.

### Functional requirements

The application must support:

1. Creating tasks.
2. Editing task titles.
3. Marking tasks completed.
4. Marking completed tasks incomplete.
5. Deleting tasks.
6. Viewing all tasks.
7. Filtering active tasks.
8. Filtering completed tasks.
9. Persisting tasks after page reload.
10. Validating empty or invalid task inputs.
11. Handling API errors gracefully.
12. Maintaining consistent frontend and backend state.

### Backend requirements

Implement a REST API:

- `GET /api/todos`
- `POST /api/todos`
- `PATCH /api/todos/:id`
- `DELETE /api/todos/:id`

Tasks must contain:

- `id`
- `title`
- `completed`
- `createdAt`

Use SQLite for persistence.

Provide exact request/response schemas, error codes, validation limits, and ordering rules in `api-contract.yaml`.

### Frontend requirements

- React-based application.
- Match the supplied `design.png` reference.
- Responsive layout at specified viewport sizes.
- Functional forms, buttons, and filters.
- Clear loading and error states.
- Accessible labels and keyboard interaction.

Create the reference design as part of benchmark development. Freeze it before starting optimization experiments.

### Starter project

The starter must contain only the required scaffolding and dependencies.

It must not contain a completed or partially completed todo implementation.

Every run starts from an identical immutable snapshot of this starter.

---

## 5. Coding Agent Runner

Implement a runner that executes a selected coding-agent configuration against the benchmark.

### Responsibilities

1. Load the selected model, prompt, skills, and tool configuration.
2. Create a fresh isolated Docker container.
3. Copy the benchmark starter into the container.
4. Give the coding agent the product specification and reference design.
5. Allow the agent to create and edit project files, execute commands, and run local tests.
6. Record model calls, tool calls, token usage, and execution time.
7. Stop when the agent finishes or exceeds its resource limits.
8. Preserve the generated application and execution traces for evaluation.
9. Destroy the container after evaluation.

### Agent tools

Initially support:

- Reading files.
- Writing and editing files.
- Listing directories.
- Executing shell commands.
- Reading command output.

Make tools configurable so the researcher can experiment with their availability and output formats.

The agent must not access hidden evaluation tests.

### Docker isolation

Each run must use a separate container with:

- A fresh filesystem based on the same starter image.
- CPU, memory, time, and storage limits.
- A non-root execution user.
- No access to host credentials.
- No mounted Docker socket.
- No access to the evaluator or researcher's files.
- Restricted network connectivity.
- Controlled dependency installation.

The application must be accessible to the external evaluator through a controlled network connection.

Do not expose model-provider API keys inside the coding container. Model calls should be handled through a trusted runner or gateway that can record usage.

For the MVP, run experiments sequentially.

Design the system so parallel execution can be added later.

---

## 6. Token Tracking

Implement accurate token accounting for every coding-agent run.

Track:

- Input tokens.
- Output tokens.
- Reasoning tokens, when separately reported.
- Cache-read tokens.
- Cache-write tokens.
- Total consumed tokens.
- Estimated and actual API cost, where available.
- Number of model calls.
- Number of tool calls.
- Execution duration.

Use model-provider usage data as the authoritative source.

Avoid double-counting reasoning tokens that are already included in output totals.

Track the tokens consumed by loaded skills, prompts, tool results, retries, and context-compaction calls as part of normal model usage.

Where provider usage information is unavailable, mark the measurement as estimated rather than presenting it as exact.

Store the raw provider usage records for auditing.

**Important:** Track coding-agent, evaluator-agent, and research-agent tokens separately.

The main optimization metric is coding-agent tokens, but total research cost must also be reported.

---

## 7. Independent Application Evaluator

The evaluator must operate outside the coding-agent container.

It must never trust the coding agent's claim that the task is complete.

Use three evaluation systems.

### A. Browser Agent Evaluation

An independent browser agent must interact with the finished application through its rendered interface.

Give it high-level user goals rather than fixed selectors.

Example:

"Create a task named 'Buy groceries', mark it completed, reload the page, and verify that it remains completed."

Required scenarios:

- Create a todo.
- Edit a todo.
- Complete a todo.
- Reopen a completed todo.
- Delete a todo.
- Filter tasks.
- Verify persistence after reload.
- Handle invalid input.
- Recover from a simulated API error.

The browser agent should discover interface controls and perform actions as a user would.

Record its actions, screenshots, errors, and outcomes.

### B. Deterministic Verification

Browser-agent claims are not sufficient to establish success.

Use independent assertions to verify the resulting frontend, API, and database state.

For example, after a browser agent completes a task:

- Verify that the correct task exists.
- Verify that `completed = true`.
- Reload the application.
- Verify that the completed state persists.
- Verify that the browser displays the correct state.

Use Playwright and API tests for deterministic verification.

### C. Visual Evaluation

Compare the finished application against the fixed visual reference.

Use:

- Screenshots at fixed viewports.
- Pixel or perceptual image similarity.
- Layout and alignment checks.
- Typography and spacing checks.
- Optional vision-model evaluation.

Control fonts, viewport, device scale, browser version, seed data, and animations.

Produce a visual quality score from 0 to 100.

### Evaluation requirements

- Keep the final evaluation suite hidden from the coding agent.
- Use reproducible test fixtures and recorded random seeds.
- Test against a known-good reference implementation.
- Distinguish evaluator failures from application failures.
- Support retries for evaluator infrastructure failures.
- Preserve screenshots and evaluation traces.
- Do not allow the research agent to modify evaluation criteria.

---

## 8. Benchmark Scoring

The objective is to minimize tokens subject to quality requirements.

A configuration qualifies only if:

- All mandatory functional tests pass.
- All mandatory browser scenarios succeed.
- Backend and persistence checks pass.
- Visual fidelity meets or exceeds a configurable threshold, initially 95/100.
- The application starts and runs without critical errors.

Among qualifying configurations, rank by median coding-agent token usage.

Also report:

- Pass rate across repeated runs.
- Average and median token usage.
- Token usage variance.
- Visual quality.
- API cost.
- Wall-clock execution time.
- Tool call count.

A low-token run that fails mandatory tests must never replace a successful configuration.

For research experiments, use a quick initial run followed by multiple verification runs.

Do not treat one successful run as proof of reliability.

---

## 9. Autonomous Research Agent

Build a separate research agent responsible for discovering improvements to the coding-agent setup.

### Objective

Find configurations that consistently pass the benchmark using fewer tokens.

### Allowed modifications

The researcher may modify:

- System prompts.
- Coding-agent skill files.
- Tool selection and tool configurations.
- Tool output summarization.
- Context management strategies.
- Workflow instructions.
- Planning and verification strategies.
- Other explicitly approved agent configuration parameters.

### Forbidden modifications

The researcher must not modify:

- Benchmark requirements.
- Starter application.
- Hidden evaluator tests.
- Reference screenshots.
- Success thresholds.
- Evaluation scoring logic.
- Token accounting logic.
- Existing experiment results.

The researcher must not reuse application code generated during previous runs.

Only optimized agent configurations can carry forward.

### Research process

For every experiment:

1. Read previous experiment results.
2. Identify a promising optimization hypothesis.
3. Create a new candidate configuration.
4. Record exactly what changed.
5. Run the benchmark using the new configuration.
6. Evaluate quality and token consumption.
7. Reject candidates failing mandatory criteria.
8. Verify promising improvements through repeated runs.
9. Compare against the best verified configuration.
10. Keep the candidate if it produces a reliable improvement.
11. Record the outcome, including failed experiments.
12. Generate the next hypothesis.

Initially change one major variable at a time to make experiments interpretable.

Allow more complex experiments once the basic research loop works.

### Experiment isolation

Researcher changes must be applied to an isolated candidate configuration directory.

Do not directly overwrite the current best configuration.

Every candidate must have a unique ID and immutable snapshot.

---

## 10. Research Loop

Implement an unattended optimization loop.

Conceptual logic:

```python
best = load_best_verified_config()

while within_research_budget():
    candidate = researcher.propose(
        best_config=best,
        history=load_experiment_history()
    )

    result = benchmark.run(
        config=candidate,
        clean_environment=True
    )

    save_result(result)

    if not result.passed:
        continue

    verification = benchmark.repeat(
        config=candidate,
        runs=5
    )

    if verification.meets_quality_requirements:
        if verification.median_tokens < best.median_tokens:
            best = promote(candidate, verification)
```

The actual implementation should be in TypeScript.

### Research controls

Support:

- Maximum experiments.
- Maximum total research cost.
- Maximum tokens per coding run.
- Maximum runtime per experiment.
- Maximum total research duration.
- Configurable verification run count.
- Pause and resume.
- Graceful shutdown.
- Recovery from interrupted experiments.
- Automatic cleanup of abandoned containers.

The loop must stop when any configured budget is exhausted.

Every experiment should be resumable or clearly marked as interrupted.

---

## 11. Preventing Overfitting

Use two levels of evaluation.

### Development evaluation

Used frequently by the research loop to compare candidate configurations.

### Holdout evaluation

Used sparingly to validate promising configurations against unseen task variations.

The research agent must not be able to inspect the holdout tests or their detailed results.

Include multiple task names, database fixtures, action sequences, and visual states.

Eventually support additional benchmark applications such as a Kanban board or multi-user task manager.

For the MVP, only the todo application is required.

---

## 12. Results Storage

Store every experiment in SQLite.

Minimum entities:

### Experiment

- Experiment ID.
- Parent configuration ID.
- Candidate configuration ID.
- Research hypothesis.
- Changes made.
- Model and provider.
- Timestamp.
- Status.
- Overall outcome.

### Run

- Run ID.
- Experiment ID.
- Random seed.
- Container/image identifier.
- Git commit or starter snapshot hash.
- Started/finished timestamps.
- Token usage.
- API cost.
- Runtime.
- Evaluation results.
- Failure reason.

### Artifacts

- Agent execution trace.
- Tool-call trace.
- Provider usage records.
- Built application snapshot.
- Browser evaluation trace.
- Screenshots.
- Test reports.
- Configuration snapshot.

Store full files in the results directory and their paths/hashes in the database.

Never overwrite prior experiments.

---

## 13. Dashboard

Build a simple dashboard to inspect research progress.

Required views:

### Overview

- Best verified configuration.
- Lowest verified median token usage.
- Baseline token usage.
- Percentage improvement over baseline.
- Number of completed experiments.
- Total research cost.

### Experiment History

A table showing:

- Experiment ID.
- Model.
- Configuration.
- Pass/fail.
- Tokens.
- Cost.
- Runtime.
- Visual score.
- Improvement relative to best.

### Charts

- Best verified token usage over experiments.
- Token consumption versus quality.
- Pass rate by configuration.
- Research cost over time.

### Experiment Detail

Show:

- Research hypothesis.
- Configuration changes.
- Agent logs.
- Browser screenshots.
- Evaluation results.
- Token breakdown.
- Failure details.

The dashboard is read-only for the initial version.

Do not let dashboard functionality block the core benchmark and research loop.

---

## 14. Command-Line Interface

Implement the following commands or equivalent npm scripts.

```bash
# Run the baseline coding-agent configuration
npm run benchmark -- --config baseline

# Run a specific experimental configuration
npm run benchmark -- --config experiments/001

# Start autonomous optimization
npm run research

# Start research with a fixed experiment budget
npm run research -- --max-experiments 20

# Display experiment results
npm run results

# Start the dashboard
npm run dashboard
```

Document all available arguments.

Include a dry-run mode that verifies the environment, configuration, and Docker availability without invoking paid models.

---

## 15. Reliability and Security

The system will execute code generated by an AI agent.

Treat all generated code, tool output, and application content as untrusted.

Required safeguards:

- Isolated containers.
- No privileged Docker execution.
- No Docker socket inside coding containers.
- Non-root execution.
- CPU and memory limits.
- Timeouts.
- Restricted network access.
- No secrets mounted into generated app environments.
- No evaluator source code exposed to coding agents.
- Safe process cleanup.
- Structured error handling.
- Recovery from failed API calls and crashed containers.

The runner must remain operational when a coding agent produces broken code, an unstartable app, or an infinite loop.

Record the failure and proceed to the next experiment when permitted by the research budget.

---

## 16. Implementation Phases

### Phase 1 — Basic Benchmark

Build:

- Todo specification and reference design.
- Starter repository.
- Docker execution environment.
- Coding-agent runner.
- Token tracking.
- Basic deterministic evaluation.

**Completion:** One agent can build the app from a clean container, and the system reports correctness and token usage.

### Phase 2 — Full Evaluation

Add:

- Independent browser evaluator.
- Hidden scenarios.
- Backend state verification.
- Visual comparison.
- Evaluation traces.
- Reliable failure classification.

**Completion:** Finished applications are independently evaluated without relying on the builder's claims.

### Phase 3 — Autonomous Research

Add:

- Research agent.
- Candidate configuration generation.
- Experiment history.
- Automatic benchmark execution.
- Repeated verification.
- Best-configuration promotion.
- Budget limits and resume support.

**Completion:** The system can run multiple research experiments without manual intervention and identify verified improvements.

### Phase 4 — Dashboard and Analysis

Add:

- Results dashboard.
- Experiment comparisons.
- Token efficiency charts.
- Cost tracking.
- Exportable experiment reports.

**Completion:** Research results can be reviewed and compared easily.

---

## 17. Acceptance Criteria

The project is complete when:

- [ ] A coding agent can build the todo application inside a fresh Docker container.
- [ ] Every experiment begins from an identical clean starter.
- [ ] Coding agents can access the specification but not hidden tests.
- [ ] The evaluator can operate the finished app through a real browser.
- [ ] Backend and database state are verified independently.
- [ ] The interface is compared against a fixed visual reference.
- [ ] Token usage is recorded for every model invocation.
- [ ] Coding, research, and evaluation tokens are tracked separately.
- [ ] Failed runs are recorded without crashing the runner.
- [ ] A research agent can propose new prompts, skills, or tooling configurations.
- [ ] The research loop can execute multiple experiments automatically.
- [ ] Only verified passing configurations can become the new best.
- [ ] Research experiments cannot modify evaluation rules.
- [ ] Experiment results and configurations are reproducible.
- [ ] The research loop respects spending and runtime budgets.
- [ ] Results can be inspected through a dashboard or CLI.
- [ ] Docker environments are cleaned up after runs.
- [ ] Setup instructions are documented in README.md.

---

## 18. Development Instructions

Work through the phases in order.

Prioritize a functional end-to-end benchmark before adding advanced research capabilities or dashboard polish.

Do not implement fake evaluations, hardcoded success scores, or simulated token measurements and present them as real results.

Mocks may be used in automated infrastructure tests but must be clearly identified.

Provide a working baseline agent configuration.

Keep implementation modular so additional models, skills, tools, and benchmark tasks can be added later.

Write automated tests for the runner, token tracker, evaluator, research loop, and result storage.

Provide clear error messages and structured logs.

If model credentials are unavailable, implement the integrations and a mock provider for local infrastructure testing, but report that no real model benchmark has been executed.

## Final Deliverable

A working local project in which the user can:

1. Configure an AI model and API credentials.
2. Run the baseline benchmark.
3. See whether the coding agent successfully built the todo application.
4. Inspect browser, backend, and visual evaluations.
5. See the exact reported token usage and API cost.
6. Start an autonomous research loop.
7. Watch the researcher experiment with agent configurations.
8. View the best verified token-efficient configuration.

**Ultimate goal: Build a self-improving agent configuration research system that reliably completes software development tasks while minimizing token consumption.**
