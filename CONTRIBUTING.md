# Contributing

Thanks for helping. This tool can change real infrastructure, so changes are reviewed for safety first.

1. Open an issue (use the template) before large changes.
2. `npm ci --ignore-scripts`, then `npm test` and `npm run smoke` must pass.
3. Add a test for new logic. Tests use a temporary loopback HTTPS server; never call a real Arcane in tests.
4. **Privacy:** never commit real host names, IP addresses, container names, API keys, certificates, logs or personal
   paths, including in tests, fixtures and docs. Use `arcane.example.com` and `192.0.2.x` addresses.
5. New or changed change operations (anything that is not a GET) need a short note on what they can break.
6. Keep dependencies pinned to exact versions and justify new ones.
7. Do not add an option that disables TLS verification or redirects the API key to another origin.

Sign commits if you can. Report security issues privately, see [SECURITY.md](SECURITY.md).
