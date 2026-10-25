# Desktop contributor instructions

Read [README.md](README.md) for setup, packaging, release tags, signing, and checks. The repository's [contributor instructions](../CONTRIBUTING.md) and root `AGENTS.md` also apply. [VALIDATION.md](VALIDATION.md) records verification evidence and outstanding acceptance; it is not the setup guide.

- Keep Electron shell, native lifecycle, and packaging code here. Shared application behavior belongs in `../agent_desk/`; keep browser mode working.
- `[project].version` in `../pyproject.toml` is the only maintained app version. Do not add an independent version to desktop package manifests. Many commits may share a version; release tags use `desktop-MAJOR.MINOR.PATCH`, without `v`, and must match the project version.
- Release identity and Apple signing are separate. Only a validated desktop tag push produces release metadata. `AGENT_DESK_APPLE_SIGNING=1` enables Developer ID signing/notarization; it does not publish a release. Keep credentials outside Git.
- Use disposable `AGENT_DESK_PROFILE_DIR` and `AGENT_DESK_SOCKET_ROOT` paths with fictional sessions for checks. Never point tests at an installed profile or live conversations.
- Build artifacts belong in ignored `.build/` and `out/`. Installed runtimes use `<profile>/runtime/`. Require full shutdown before replacing changed runtime code; copy and verify before launch. Preserve application data and leave legacy content-hashed `runtimes/` directories untouched. Source/debug runs default to Agent Desk Dev; packaged apps default to Agent Desk.
- Run `npm test` from this folder for desktop unit checks. For build identity or packaging changes, also run `npm run test:about`, `npm run package`, and `npm run test:packaged`. For DMG changes, run `npm run make` and `npm run test:dmg`. Run relevant root Python/Node checks for shared-code changes.
- Update README and `../docs/guide.md` for user-visible behavior. Record actual verification separately from user acceptance; do not claim GitHub publication or Apple notarization based on local ad-hoc builds.
