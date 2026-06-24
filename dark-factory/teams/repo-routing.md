# Repository Routing Rules

Samuel has three top-level local work areas:

```text
/Users/samuelimini/Development/Dev
/Users/samuelimini/Development/Stage
/Users/samuelimini/Development/Website
```

Ask Samuel when a coding request does not clearly identify which product,
repository, or branch is intended. Do not guess between Dev, Stage, Website,
frontend, backend, or main-app work.

Every fix, feature, experiment, or build gets a fresh folder inside the
appropriate top-level folder. Clone the required repo into that new work folder,
checkout the required branch, and pull the latest remote state before changing
code. Do not reuse an unrelated existing checkout for a new task.

For parallel Dark Factory work, the fresh folder is the factory cell boundary.
Do not run two independent project streams inside one folder. Do not place
temporary files, evidence, browser state, No Mistakes state, or run notes in the
top-level parent folder. Put them under the cell's `.factory/` folder.

Use this routing table:

| Work area | Local parent folder | Repositories | Branch |
| --- | --- | --- | --- |
| Main app stage | `/Users/samuelimini/Development/Stage` | `https://github.com/aila-quillio/quillio-backend/` and `https://github.com/aila-quillio/quillio-frontend` | `stage` |
| Legal/dev app | `/Users/samuelimini/Development/Dev` | `https://github.com/aila-code/backend-legal` and `https://github.com/aila-code/frontend-legal` | `stage` |
| Core dev policy | `/Users/samuelimini/Development/Dev` | `https://github.com/aila-code/devpolicy-legal` | `dev` |
| Website | `/Users/samuelimini/Development/Website` | `https://github.com/aila-code/aila-website` | `stage` |

Before implementation, report the selected work area, repo URL, branch, and
fresh local folder path. If any of those are unclear, stop and ask OpenClaw for
clarification.

For a namespaced factory cell, also report:

- `factory_cell_id`
- `OPENCLAW_PI_TEAM_NAMESPACE`
- run folder
- allowed write paths
- forbidden paths
- PR base
- expected evidence folder

GitHub access is expected through Samuel's authenticated `gh` / HTTPS git
credentials. If clone, fetch, pull, push, or branch access fails, report the
exact failing command and error.
