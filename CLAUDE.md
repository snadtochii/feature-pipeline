@AGENTS.md

## Lessons

- Folder location is never a state signal for an epic child — a finished child never leaves `in-progress/<EPIC>/tasks/`. Key on the ticket's own frontmatter `status`.
- This repo has no runnable app, so the close stage's UI test checkpoint never has anything to test here: the skip-detection substring scan false-positives on skill/doc tickets (`form` in "format", `partial`, `template`, `layout`), and the dev-port probe's `localhost:5000` → `403` is macOS AirPlay (ControlCenter), not an app — confirm the owner with `lsof -iTCP:<port> -sTCP:LISTEN` and write the app-unreachable skip instead of spawning `ui-tester`.
