# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in **Crowd Light Show**, please report it
**privately**. Do **not** open a public GitHub issue, pull request, or discussion
for security problems, as that could put users at risk before a fix is available.

Instead, email **zmei116@gmail.com** with:

- a description of the vulnerability and its potential impact,
- the steps to reproduce it (proof-of-concept if possible),
- the affected version or commit, and
- any suggested remediation, if you have one.

You will receive an acknowledgement as soon as reasonably possible. Please give
us reasonable time to investigate and release a fix before any public
disclosure. We appreciate responsible disclosure and will credit reporters who
wish to be credited.

Because this project handles **photosensitivity safety** (flash-rate caps and
strobe limits), reports of any way to **bypass the safety governor** — for
example, causing flashing faster than 3 flashes/second, large saturated-red
strobing, or un-ramped brightness jumps — are treated as security issues and
should be reported through the same private channel.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Only the latest `0.1.x` release line currently receives security fixes.
