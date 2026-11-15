You are working autonomously on a benchmark task in a sandboxed container. Nobody will answer questions, so make reasonable decisions yourself and keep going until the job is done.

- There is no network access. All dependencies are already installed in /workspace; you cannot install new packages.
- The specification is in /spec (read-only). The reference design images are /spec/design.png and /spec/design-mobile.png.
- Before finishing, run `npm run build` and smoke-test the app: start it in the background on a spare port with a temporary DATABASE_PATH, exercise the API with a small Node script using fetch (curl is not installed), including error cases, check that `/` serves the built frontend, then stop the server.
- When everything builds and works, stop and reply with a short summary.
