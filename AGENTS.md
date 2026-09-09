# Public and internal development

- `v0.2.0dev` and release branches are public. Company pilots belong only on `internal`; never merge or cherry-pick pilot integrations into a public branch.
- Never push `internal` or private recovery refs/bundles to the public remote. Public fixes may flow into `internal`, not the reverse.
- Public clients may expose a generic, deployment-configured Feishu login module. Do not embed organization domains, employee data, tenant identifiers, internal endpoints, deployment files, work-record/weekly-report pages, or pilot service integrations.
- Before removing or rewriting history, preserve complete private recovery data and verify it. Audit both the final tree and all history reachable from the public refs before publishing.
