# CI workflow (pending move)

`github-workflow-ci.yml` is the GitHub Actions workflow for the pnpm workspace
(`pnpm install` → `lint` → `typecheck` → `test` → `build`). It lives here
because the credential used to push the `refactoring` branch lacks the
`workflow` OAuth scope, so GitHub refuses any push that creates a file under
`.github/workflows/`.

To activate it, run with a credential that has the `workflow` scope:

```sh
git mv ci/github-workflow-ci.yml .github/workflows/ci.yml
git rm ci/README.md
git commit -m "Activate CI workflow"
git push
```
