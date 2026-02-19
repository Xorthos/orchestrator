# Architecture

Automated pipeline that watches a Jira project for tasks assigned to Claude, generates implementation plans for human approval, codes the approved plan via the Claude Agent SDK, deploys to a staging branch for review, and merges to master when the task is moved to "Done" — all driven by webhooks with a reconciliation poller as fallback.

## Main Workflow

```mermaid
flowchart TD
    %% ── Trigger ──────────────────────────────
    W[/"Jira webhook<br/>(issue_created / issue_updated)"/]
    P[/"Reconciliation poller<br/>(every N seconds)"/]

    W --> detect
    P --> detect

    detect{"Task in 'To Do'<br/>assigned to Claude<br/>or labeled?"}
    detect -- No --> skip([Ignore])
    detect -- Yes --> plan

    %% ── Phase 1: Plan ────────────────────────
    subgraph phase1 [" Phase 1 — Plan "]
        plan["Transition issue → In Progress<br/>Run Claude SDK (plan mode, read-only)"]
        plan --> postPlan["Post plan as Jira comment<br/>Reassign issue to reviewer"]
    end

    postPlan --> feedback

    %% ── Plan Approval Loop ───────────────────
    subgraph approval [" Plan Approval Loop "]
        feedback{"Reviewer comment?"}
        feedback -- "approve" --> approved["Mark plan approved"]
        feedback -- "feedback / question" --> replan["Re-run Claude planning<br/>with reviewer feedback"]
        replan --> postUpdated["Post updated plan to Jira"]
        postUpdated --> feedback
    end

    approved --> implement

    %% ── Phase 2: Implement ───────────────────
    subgraph phase2 [" Phase 2 — Implement "]
        implement["Create feature branch<br/>Run Claude SDK (acceptEdits, read-write)"]
        implement --> push["Commit & push branch"]
        push --> staging["Merge branch → staging"]
        staging --> smoke["Smoke-test staging URL"]
        smoke --> pr["Create PR → master<br/>Add label: claude-bot-pr-pending"]
        pr --> toTest["Transition issue → Test<br/>Reassign to reviewer"]
    end

    toTest --> reviewLoop

    %% ── Test / Rework Loop ───────────────────
    subgraph review [" Test & Review Loop "]
        reviewLoop{"Reviewer action?"}
        reviewLoop -- "comment with feedback" --> rework["Run Claude rework on branch<br/>Push fixes, re-merge staging"]
        rework --> reviewLoop
        reviewLoop -- "move to Done" --> merge
    end

    %% ── Phase 3: Merge ──────────────────────
    subgraph phase3 [" Phase 3 — Merge "]
        merge["Squash-merge PR → master<br/>Delete feature branch<br/>Clean up state & labels"]
    end

    merge --> deployed([Production deploy triggered])
```

## Component Diagram

```mermaid
flowchart LR
    subgraph Orchestrator ["Orchestrator (Node.js)"]
        direction TB
        server["Express Server<br/>/webhook/jira<br/>/health"]
        poller["Reconciliation<br/>Poller"]
        engine["WorkflowEngine"]
        server --> engine
        poller --> engine
    end

    subgraph Services
        direction TB
        jiraSvc["JiraService<br/>(jira.js client)"]
        ghSvc["GitHubService<br/>(Octokit)"]
        claudeSvc["ClaudeService<br/>(Agent SDK + git)"]
        stateSvc["StateManager<br/>(better-sqlite3)"]
    end

    engine --- jiraSvc
    engine --- ghSvc
    engine --- claudeSvc
    engine --- stateSvc

    jiraSvc <-->|"REST API"| Jira[(Jira Cloud)]
    ghSvc <-->|"REST API"| GitHub[(GitHub)]
    claudeSvc <-->|"Agent SDK"| Claude[("Claude<br/>(API or Max)")]
    claudeSvc <-->|"git CLI"| Repo[("Target Repo<br/>(local clone)")]
    stateSvc <-->|"read/write"| DB[(".orchestrator.db<br/>SQLite")]
```

## Jira Status Transitions

```mermaid
stateDiagram-v2
    [*] --> ToDo
    ToDo --> InProgress : Claude starts planning
    InProgress --> Test : Implementation + PR complete
    Test --> Test : Rework loop (feedback → fix)
    Test --> Done : Reviewer satisfied
    Done --> [*] : PR merged to master

    state ToDo {
        direction LR
        [*] --> Detected : Assigned to Claude / labeled
    }
```

## Key Labels & Statuses

| Concept | Value | Purpose |
|---|---|---|
| **Claude label** | `claude-bot` (configurable) | Marks a task for Claude to pick up |
| **PR-pending label** | `claude-bot-pr-pending` | Tracks issues with an open PR awaiting review |
| **Jira statuses** | To Do → In Progress → Test → Done | Board columns the orchestrator transitions through |
| **Internal phases** | `planning` · `plan-posted` · `approved` · `implementing` · `test` · `merging` · `failed` | Tracked in SQLite to survive restarts |
| **Claude plan mode** | `plan` (read-only tools) | Used during planning — no file edits |
| **Claude implement mode** | `acceptEdits` (read-write) | Used during implementation and rework |
| **Merge strategy** | Squash merge | Feature branch → master via GitHub API |
| **Staging branch** | `staging` | Feature branch merged here for pre-production testing |
