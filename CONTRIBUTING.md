# Contributing to Crowd Light Show

Thanks for your interest in improving **Crowd Light Show**! Contributions of all kinds are welcome — bug reports, feature ideas, documentation, and code.

## Getting set up

Requirements: Node.js and `ffmpeg` available on your machine (ffmpeg is used for audio decoding).

```bash
# install dependencies
npm install

# run the app locally
npm start
```

Environment variables for local runs:

- `OPERATOR_PASS` — password for the operator console (`/operator`).
- `PUBLIC_BASE_URL` — the public base URL encoded into the join QR code.

## Running the tests

Please run the relevant tests before opening a pull request:

```bash
# safety governor tests (flash-rate cap, no red strobe, brightness ramps)
npm run test:safety

# multi-client sync harness (clock-sync + timeline alignment)
npm run test:sync
```

Changes that touch the cue compiler, brightness ramps, flash-rate limits, or the clock-sync path **must** keep `npm run test:safety` and `npm run test:sync` passing. The safety governor is a hard requirement, not a suggestion — please do not relax the ≤ 3 flashes/second cap, the red-strobe block, or the brightness ramp without a very good, clearly documented reason.

## Proposing changes

1. **Open an issue first** for anything non-trivial, so we can agree on the approach before you invest time. Use issues for bug reports and feature requests.
2. **Fork the repo and create a branch** for your change.
3. **Make focused commits** with clear messages.
4. **Open a pull request** against `main`. Describe what changed and why, and reference any related issue. Include the output of the relevant tests.

## Code style

- The clients are **vanilla JavaScript** (no framework) and the server is **Node.js + Fastify + ws** — please keep that lightweight, dependency-light approach.
- Match the existing style of the file you are editing (indentation, naming, structure). Keep changes small and readable.
- Prefer clarity over cleverness, especially in timing/sync and safety code.

## License of contributions

By submitting a contribution, you agree that your contribution is licensed under the **Apache License 2.0**, the same license that covers this project. See [LICENSE](LICENSE).

Please also read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).
