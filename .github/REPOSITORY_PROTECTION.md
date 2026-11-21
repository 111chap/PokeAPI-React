# Main branch protection

CODEOWNERS names @111chap as the required owner reviewer. Application CI and repository guardrails must pass before merging contributions. Repository guardrails reject tracked account databases, installed dependencies, environment files, recognizable credentials, privileged pull-request events and broad workflow write permissions.

**CODEOWNERS and workflow files alone do not enforce merge restrictions.** The repository owner must enable branch protection on main. The proposed settings are in `branch-protection.json`: require a pull request, one owner approval, dismissal of stale approvals, approval after the last push, resolved discussions, an up-to-date branch and successful `verify` and `repository-guardrails` checks. Force pushes and branch deletion are disabled. The owner retains an emergency bypass; ordinary collaborators do not.

From an authenticated GitHub CLI with repository administration access, apply:

```sh
gh api --method PUT repos/111chap/PokeAPI-React/branches/main/protection --input .github/branch-protection.json
```

Alternatively use Settings → Branches → Add classic branch protection rule and configure the same requirements for `main`. Check the saved settings afterwards. The ChatGPT GitHub connector used for this change cannot administer branch protection.

Public repositories remain readable and forkable. These rules govern modifications to the protected branch. They do not erase previously exposed data or protect a compromised owner account. Keep collaborator access limited to trusted people, and use strong account authentication.
