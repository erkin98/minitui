# Security policy

minitui runs model-generated mini-apps behind a permission gate and an OS sandbox, so security reports are very welcome.

## Supported versions

minitui is pre-release and nothing is published to a package registry yet. Fixes land on `master`, and the latest `master` is the only supported version; older commits get no fixes.

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a vulnerability.

A useful report says what you did, what happened, what you expected, and the commit you tested. Include a minimal reproduction if you have one.

## What to expect

- An acknowledgement within 7 days.
- A fix, or a decision with the reasoning, within 90 days of the report.
- Coordinated disclosure: once a fix is on `master`, or at 90 days, whichever comes first, the advisory is published with credit to you unless you prefer otherwise.
- There is no bug bounty.

## Scope

In scope, roughly in order of how much they matter:

- Running a gated command outside the OS sandbox, or escaping the sandbox (filesystem writes outside the allowed output, network egress, reads of the denied paths).
- Getting a command past the permission engine or its hard floor, which no approval mode is meant to lift.
- A consent prompt that shows anything other than the values the host resolved, so that what you approve is not what runs.
- Terminal escape sequences from a model, a generated app or a child process that reach the terminal unsanitized, or that spoof the consent prompt.
- A model-authored spec that reaches code execution, or reads or writes files the user did not approve.
- Leaking the API key to a child process, a log, the model or the screen.
- Weaknesses in this repository's workflows, release process or dependency handling.

Out of scope:

- Actions a user deliberately takes against their own machine, such as running with `--yolo` and approving a harmful command.
- Vulnerabilities in the model provider, or in upstream packages that minitui does not make worse. Please report those upstream; a note to us is still welcome if minitui is affected.
- Reports that depend on a modified local build, or on an attacker who already controls the user's account or terminal.
